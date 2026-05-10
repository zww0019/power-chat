import { describe, it, expect, beforeEach } from 'vitest';
import { api, BASE_URL, createNode, sendMessage , getCanvas } from '../helpers';

// OpenRouter 思考兼容改造的端到端验证：
// 1. provider=openrouter + thinkingModeEnabled=true 时，SSE 流既含 reasoning 也含 reasoning_details
// 2. assistant 消息持久化时 reasoningDetails 数组非空
// 3. 多轮对话中 OpenRouter 路径下 reasoning_details 被回灌到下一轮 LLM 入参（思考连续性）

beforeEach(async () => {
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

// 抽出避免每个用例各写一份 PUT body：四个 provider×thinking 组合的 fixture 公共部分一致
async function configureProvider(overrides: Record<string, unknown>): Promise<void> {
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      llmModel: 'mock-model',
      llmApiKey: 'sk-test',
      thinkingModeEnabled: true,
      ...overrides,
    }),
  });
}

describe('reasoning · OpenRouter 思考路径', () => {
  it('provider=openrouter + thinking=on 时流式产出 reasoning_details 事件', async () => {
    await configureProvider({
      provider: 'openrouter',
      thinkingEffort: 'medium',
      llmBaseUrl: 'https://openrouter.ai/api/v1',
    });
    const node = await createNode();
    const events = await sendMessage(node.id, '中国新茶饮品牌出海有哪些主要阻力？');

    const types = events.map((e) => e.type);
    expect(types).toContain('reasoning');
    expect(types).toContain('reasoning_details');
    expect(types).toContain('content');
    expect(types[types.length - 1]).toBe('done');
  });

  it('reasoning_details 持久化到 assistant 消息的 reasoningDetails 字段', async () => {
    await configureProvider({
      provider: 'openrouter',
      llmBaseUrl: 'https://openrouter.ai/api/v1',
    });
    const node = await createNode();
    await sendMessage(node.id, '中国新茶饮品牌出海有哪些主要阻力？');

    const snap = await getCanvas();
    const assistantMsg = snap.messages.find(
      (m: any) => m.role === 'assistant' && m.nodeId === node.id,
    );
    expect(assistantMsg.reasoningDetails).toBeTruthy();
    expect(Array.isArray(assistantMsg.reasoningDetails)).toBe(true);
    expect(assistantMsg.reasoningDetails.length).toBeGreaterThan(0);
    expect(assistantMsg.reasoningDetails[0]).toHaveProperty('type');
  });

  it('其他 provider（custom）下不产出 reasoning_details 事件', async () => {
    await configureProvider({
      provider: 'custom',
      llmBaseUrl: 'https://api.example.com/v1',
    });
    const node = await createNode();
    const events = await sendMessage(node.id, '中国新茶饮品牌出海有哪些主要阻力？');

    const types = events.map((e) => e.type);
    expect(types).toContain('reasoning');
    expect(types).not.toContain('reasoning_details');
  });

  it('多轮对话：第一轮的 reasoningDetails 在第二轮请求时回灌到 assistant 历史', async () => {
    await configureProvider({
      provider: 'openrouter',
      llmBaseUrl: 'https://openrouter.ai/api/v1',
    });
    const node = await createNode();
    await sendMessage(node.id, '中国新茶饮品牌出海有哪些主要阻力？');
    await sendMessage(node.id, '反例');

    const data = await api<{ messages: Array<Record<string, unknown>> | null }>(
      '/api/__test__/last-llm-messages',
    );
    expect(data.messages).not.toBeNull();
    const assistantMessages = data.messages!.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThan(0);
    // mock 路径下 recordMockLLMMessages 记录的是 LLMMessage（camelCase）；
    // 真实 OpenRouter HTTP 路径走 toOpenAIMessage 会转 snake_case，由单测 buildBody.test 覆盖
    const withDetails = assistantMessages.find((m) => m.reasoningDetails);
    expect(withDetails).toBeTruthy();
    expect(Array.isArray((withDetails as { reasoningDetails: unknown }).reasoningDetails)).toBe(true);
  });

  it('settings.provider 由 openrouter.ai baseURL 自动推断（旧 db.json 升级路径）', async () => {
    // 模拟旧 db.json：PUT 不带 provider，仅设 baseURL，期望服务端按 URL 推断
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        llmBaseUrl: 'https://openrouter.ai/api/v1',
        llmModel: 'mock-model',
        llmApiKey: 'sk-test',
      }),
    });
    const settings = await api<any>('/api/settings');
    expect(settings.provider).toBe('openrouter');
  });
});
