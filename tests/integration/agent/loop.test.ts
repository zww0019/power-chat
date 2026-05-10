import { describe, it, expect, beforeEach } from 'vitest';
import { api, BASE_URL, createNode, sendMessage , getCanvas } from '../helpers';
import { AGENT_REACT_FORCE_SEARCH } from '../../../src/modules/fixtures';

// agent-module · ReAct loop 端到端（mock 工具）
// 关联：R014/R015/R016/R017/R019, D013/D015/D016/D017, INV-11(扩展)

beforeEach(async () => {
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

// ============== 测试 helper（避免相同断言模板在多个用例中重复） ==============

interface AssistantMessageView {
  id: string;
  nodeId: string;
  role: string;
  agentTrace?: Array<{ type: string }> | null;
}

async function getAssistantMessage(nodeId: string): Promise<AssistantMessageView | undefined> {
  const snap = await getCanvas() as Promise<{ messages: AssistantMessageView[] }>;
  return snap.messages.find((m) => m.role === 'assistant' && m.nodeId === nodeId);
}

// 断言 SSE 流符合 agent loop 完整路径：含 action / observation 且以 done 结尾
function expectAgentFlowEvents(events: Array<{ type: string; [k: string]: unknown }>): void {
  const types = events.map((e) => e.type);
  expect(types).toContain('agent_action');
  expect(types).toContain('agent_observation');
  expect(types[types.length - 1]).toBe('done');
}

// 在 SSE 流中定位第一个 agent_action 事件并强类型断言；调用方做后续 toolArgs 差异化断言
function findActionEvent(events: Array<{ type: string; [k: string]: unknown }>): { toolName: string; toolArgs: Record<string, unknown> } {
  return events.find((e) => e.type === 'agent_action') as { toolName: string; toolArgs: Record<string, unknown> };
}

describe('agent: ReAct loop 端到端 - native_tools 模式', () => {
  it('用户用"搜一下"动作动词触发时，SSE 流包含 agent_action + agent_observation + done', async () => {
    const node = await createNode();
    const events = await sendMessage(node.id, '搜一下东南亚新茶饮市场数据');
    expectAgentFlowEvents(events);

    const action = findActionEvent(events);
    expect(action.toolName).toBe('web_search');
    expect(action.toolArgs).toBeDefined();

    const observation = events.find((e) => e.type === 'agent_observation') as { success: boolean; result: string };
    expect(observation.success).toBe(true);
    expect(observation.result).toMatch(/返回 \d+ 条结果/);
  });

  it('user 含 URL 时触发 fetch_page 工具', async () => {
    const node = await createNode();
    const events = await sendMessage(node.id, '读一下这个网页：https://example.com/article');
    const action = events.find((e) => e.type === 'agent_action') as { toolName: string; toolArgs: { url: string } };
    expect(action).toBeDefined();
    expect(action.toolName).toBe('fetch_page');
    expect(action.toolArgs.url).toBe('https://example.com/article');
  });

  it('agent loop 完成后 assistant message 持久化 agentTrace（含 action + observation）', async () => {
    const node = await createNode();
    await sendMessage(node.id, '搜一下供应链问题');
    const asstMsg = await getAssistantMessage(node.id);
    expect(asstMsg!.agentTrace).toBeDefined();
    expect(Array.isArray(asstMsg!.agentTrace)).toBe(true);
    expect(asstMsg!.agentTrace!.length).toBeGreaterThan(0);

    const types = asstMsg!.agentTrace!.map((s) => s.type);
    expect(types).toContain('action');
    expect(types).toContain('observation');
  });

  it('普通对话（无触发词）不进入 agent loop，message.agentTrace 为 null（R016 / R019 守卫）', async () => {
    const node = await createNode();
    await sendMessage(node.id, '中国新茶饮品牌出海有哪些主要阻力？');
    const asstMsg = await getAssistantMessage(node.id);
    expect(asstMsg!.agentTrace ?? null).toBeNull();
  });

  it('agent 调用后续轮的对话不再回灌 agentTrace，新 assistant 消息 agentTrace 应为 null', async () => {
    const node = await createNode();
    await sendMessage(node.id, '搜一下供应链问题');
    // 第二条普通对话（不含触发词）
    const events = await sendMessage(node.id, '继续聊');
    expect(events[events.length - 1]!.type).toBe('done');
    const snap = await getCanvas() as Promise<{ messages: Array<{ role: string; nodeId: string; sequence: number; agentTrace?: unknown }> }>;
    const asstMsgs = snap.messages
      .filter((m) => m.nodeId === node.id && m.role === 'assistant')
      .sort((a, b) => a.sequence - b.sequence);
    expect(asstMsgs).toHaveLength(2);
    // 第二条 assistant 消息没有触发 agent，agentTrace 应为 null
    expect(asstMsgs[1]!.agentTrace ?? null).toBeNull();
  });
});

describe('agent: ReAct loop 端到端 - react_text 模式', () => {
  it('推理模型时 mock LLM 输出 JSON 字符串被 parseReactJson 解析为 tool_call 并完成端到端', async () => {
    // 切换到推理模型让 detectToolSupport 命中黑名单返回 react_text；
    // 用唯一 modelName 避开 detectToolSupport 进程内缓存（D018）
    const reactModel = `deepseek-reasoner-test-${Date.now()}`;
    await fetch(`${BASE_URL}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llmModel: reactModel }),
    });

    const node = await createNode();
    const events = await sendMessage(node.id, `请帮忙 ${AGENT_REACT_FORCE_SEARCH}`);
    expectAgentFlowEvents(events);

    const action = findActionEvent(events);
    expect(action.toolName).toBe('web_search');
    expect(action.toolArgs).toMatchObject({ query: expect.any(String) });

    // assistant 消息的 agentTrace 落库（与 native_tools 模式一致）
    const asstMsg = await getAssistantMessage(node.id);
    expect(asstMsg?.agentTrace).toBeDefined();
    expect(asstMsg!.agentTrace!.map((s) => s.type)).toContain('action');
  });
});
