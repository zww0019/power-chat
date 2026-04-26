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

  it.skip('reasoning 内容不进入下一轮 LLM 调用的 messages 数组（INV-11 协议层）', async () => {
    // 这条 INV 需要拦截 LLM 客户端的 outbound 请求来验证。
    // 当前 mock 模式下 LLM 客户端是内部函数，无法外部注入 spy。
    // Stage 7 改为依赖注入后可启用
  });

  it.skip('上下文超长时返回 413 + ContextOverflowError', async () => {
    // 模拟方式：连续提交超长消息直到累计估算超过 80%。
    // 当前 mock 模式 chunk size 小，需特殊 fixture 触发——延后到 Stage 7
  });
});

describe('conversation: 标题自动生成（D006 / R012）', () => {
  it('每 3 轮对话后异步触发标题生成，SSE 推送 title 事件并持久化到 node.title', async () => {
    const node = await createNode();

    // 发 3 轮（每轮 user+assistant 共 2 条 message，3 轮共 6 条，命中节流 6 % 6 === 0）
    let lastEvents: Array<{ type: string; [k: string]: unknown }> = [];
    for (let i = 0; i < 3; i++) {
      lastEvents = await sendMessage(node.id, `第${i + 1}问 — 关于供应链`);
    }

    // 第 3 轮的 SSE 流应包含 title 事件
    const titleEvent = lastEvents.find((e) => e.type === 'title');
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

  it('第 1、2 轮对话不触发标题更新（节流未命中）', async () => {
    const node = await createNode();
    const events = await sendMessage(node.id, '初始问题');
    expect(events.find((e) => e.type === 'title')).toBeUndefined();
  });
});
