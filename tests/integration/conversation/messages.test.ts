import { describe, it, expect, beforeEach } from 'vitest';
import { api, BASE_URL, createNode, sendMessage } from '../helpers';

// conversation-module 测试 - messages（节点内对话）
//
// 关联：INV-1, INV-3, INV-8, INV-11, D006, R012
//       旅程1 阶段 A 步骤 2-6, 旅程2 sad-1, sad-3

beforeEach(async () => {
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

describe('conversation: 节点内消息发送', () => {
  it('用户发送消息后 AI 流式回复，先 reasoning 后 content 然后 done', async () => {
    const node = await createNode();
    const events = await sendMessage(node.id, '中国新茶饮品牌出海有哪些主要阻力？');
    const types = events.map((e) => e.type);
    expect(types).toContain('content');
    expect(types[types.length - 1]).toBe('done');
  });

  it('消息被持久化，sequence 严格单调（INV-8）', async () => {
    const node = await createNode();
    await sendMessage(node.id, '阻力');
    await sendMessage(node.id, '反例');
    const snap = await api<any>('/api/canvas');
    const messages = snap.messages
      .filter((m: any) => m.nodeId === node.id)
      .sort((a: any, b: any) => a.sequence - b.sequence);
    expect(messages).toHaveLength(4);
    expect(messages.map((m: any) => m.sequence)).toEqual([0, 1, 2, 3]);
    expect(messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('user 消息的 reasoningContent 始终为 null（INV-11 数据层）', async () => {
    const node = await createNode();
    await sendMessage(node.id, '阻力');
    const snap = await api<any>('/api/canvas');
    const userMsg = snap.messages.find((m: any) => m.role === 'user' && m.nodeId === node.id);
    expect(userMsg.reasoningContent).toBeNull();
  });

  it('agentTrace 不进入下一轮 LLM 调用的 messages 数组（R019 协议层）；reasoning_content 按协议要求回传（修正后的 INV-11）', async () => {
    // 启用 thinking mode 让 mock LLM 输出 reasoning（fixtures 中的 canned response 含 reasoning 字段）
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ thinkingModeEnabled: true }),
    });
    const node = await createNode();
    // 第一轮：assistant 消息持久化时含 reasoningContent
    await sendMessage(node.id, '中国新茶饮品牌出海有哪些主要阻力？');
    // 第二轮：触发新一次 LLM 调用，让我们能观察入参 messages 的形态
    await sendMessage(node.id, '反例');

    // 跨进程读 mockStream 最近一次入参（mock-server 进程暴露的测试端点）
    const data = await api<{ messages: Array<{ role: string; content: string; reasoningContent?: string | null; [k: string]: unknown }> | null }>(
      '/api/__test__/last-llm-messages',
    );
    expect(data.messages).not.toBeNull();
    // 协议层验证 1：所有 messages 不携带 agentTrace 字段（R019 永不回传）
    for (const m of data.messages!) {
      expect(m).not.toHaveProperty('agentTrace');
    }
    // 协议层验证 2：assistant 历史消息保留 reasoningContent（修正后的 INV-11，
    // DeepSeek-Reasoner 协议要求；不带会 400 invalid_request_error）
    const assistantMsgs = data.messages!.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const firstAsst = assistantMsgs[0]!;
    expect(typeof firstAsst.reasoningContent === 'string').toBe(true);
    expect((firstAsst.reasoningContent ?? '').length).toBeGreaterThan(0);
  });

  it('SSE 流包含 user_persisted 事件，messageId 与持久化 user 消息 id 一致', async () => {
    // 协议契约：前端乐观生成的 user 消息 ID 与后端独立生成的真实 ID 不同。
    // 后端必须在持久化 user 后 yield user_persisted 事件下发真实 ID，否则用户对刚发的消息发起
    // branch 时前端传入的乐观 ID 在后端查不到 → 400 fromMessageId not found in parent。
    const node = await createNode();
    const events = await sendMessage(node.id, '阻力');
    const userPersisted = events.find((e) => e.type === 'user_persisted') as { messageId: string } | undefined;
    expect(userPersisted).toBeDefined();
    expect(typeof userPersisted!.messageId).toBe('string');
    const snap = await api<any>('/api/canvas');
    const userMsg = snap.messages.find((m: any) => m.role === 'user' && m.nodeId === node.id);
    expect(userMsg.id).toBe(userPersisted!.messageId);
  });

  it('user_persisted 事件出现在第一个 content / reasoning 增量之前', async () => {
    // 顺序约束：前端在收到 user_persisted 后才把 store 中的乐观 user ID 替换为真实 ID。
    // 若 reasoning / content 增量先到达而 user_persisted 滞后，对应窗口期内任何 branch 调用
    // 都会失败——本断言保证后端不会颠倒该顺序。
    const node = await createNode();
    const events = await sendMessage(node.id, '阻力');
    const types = events.map((e) => e.type);
    const userIdx = types.indexOf('user_persisted');
    const firstDeltaIdx = types.findIndex((t) => t === 'content' || t === 'reasoning');
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(firstDeltaIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeLessThan(firstDeltaIdx);
  });

  it.skip('上下文超长时返回 413 + ContextOverflowError', async () => {
    // 模拟方式：连续提交超长消息直到累计估算超过 80%。
    // 当前 mock 模式 chunk size 小，需特殊 fixture 触发——延后到 Stage 7
  });
});

describe('conversation: 标题双轨制（D006 / R012）', () => {
  it('自动轨：每 3 轮（6 条 message）触发一次，第 3 轮 SSE 流含 title 事件并持久化', async () => {
    const node = await createNode();

    // 第 1、2 轮不触发（messages 数 = 2、4，不命中 % 6 === 0）
    const r1 = await sendMessage(node.id, '第1问 — 关于供应链');
    expect(r1.find((e) => e.type === 'title')).toBeUndefined();
    const r2 = await sendMessage(node.id, '第2问 — 关于供应链');
    expect(r2.find((e) => e.type === 'title')).toBeUndefined();

    // 第 3 轮（messages 数 = 6，命中触发条件）
    const r3 = await sendMessage(node.id, '第3问 — 关于供应链');
    const titleEvent = r3.find((e) => e.type === 'title');
    expect(titleEvent).toBeDefined();
    expect(titleEvent!.nodeId).toBe(node.id);
    expect(typeof titleEvent!.title).toBe('string');
    expect((titleEvent!.title as string).length).toBeGreaterThan(0);

    // 持久化验证
    const snap = await api<any>('/api/canvas');
    const updated = snap.nodes.find((x: any) => x.id === node.id);
    expect(updated.title).toBeTruthy();
    expect(updated.title.length).toBeLessThanOrEqual(30);
  });

  it('主动轨：POST /api/nodes/:id/regenerate-title 成功返回标题并持久化', async () => {
    const node = await createNode();
    await sendMessage(node.id, '中国新茶饮品牌出海有哪些主要阻力？');

    const result = await api<{ title: string }>(`/api/nodes/${node.id}/regenerate-title`, {
      method: 'POST',
    });
    expect(typeof result.title).toBe('string');
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.title.length).toBeLessThanOrEqual(30);

    const snap = await api<any>('/api/canvas');
    const updated = snap.nodes.find((x: any) => x.id === node.id);
    expect(updated.title).toBe(result.title);
  });

  it('主动轨：对空节点（无消息）调用返回 400 empty_node', async () => {
    const node = await createNode();
    const res = await fetch(`${BASE_URL}/api/nodes/${node.id}/regenerate-title`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('empty_node');
  });

  it('主动轨：对不存在节点调用返回 404 not_found', async () => {
    const res = await fetch(`${BASE_URL}/api/nodes/no_such_node/regenerate-title`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('主动轨：多次调用永远强制重新生成（不依赖 node.title 是否已有值）', async () => {
    const node = await createNode();
    await sendMessage(node.id, '关于供应链的问题');
    const first = await api<{ title: string }>(`/api/nodes/${node.id}/regenerate-title`, {
      method: 'POST',
    });
    expect(first.title).toBeTruthy();
    // 再次调用应当再次成功（验证：用户主动意图永远成立，不卡 node.title 已有值的判断）
    const second = await api<{ title: string }>(`/api/nodes/${node.id}/regenerate-title`, {
      method: 'POST',
    });
    expect(second.title).toBeTruthy();
  });
});
