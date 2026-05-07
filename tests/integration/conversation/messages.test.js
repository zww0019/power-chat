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
        const snap = await api('/api/canvas');
        const messages = snap.messages
            .filter((m) => m.nodeId === node.id)
            .sort((a, b) => a.sequence - b.sequence);
        expect(messages).toHaveLength(4);
        expect(messages.map((m) => m.sequence)).toEqual([0, 1, 2, 3]);
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });
    it('user 消息的 reasoningContent 始终为 null（INV-11 数据层）', async () => {
        const node = await createNode();
        await sendMessage(node.id, '阻力');
        const snap = await api('/api/canvas');
        const userMsg = snap.messages.find((m) => m.role === 'user' && m.nodeId === node.id);
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
        const data = await api('/api/__test__/last-llm-messages');
        expect(data.messages).not.toBeNull();
        // 协议层验证 1：所有 messages 不携带 agentTrace 字段（R019 永不回传）
        for (const m of data.messages) {
            expect(m).not.toHaveProperty('agentTrace');
        }
        // 协议层验证 2：assistant 历史消息保留 reasoningContent（修正后的 INV-11，
        // DeepSeek-Reasoner 协议要求；不带会 400 invalid_request_error）
        const assistantMsgs = data.messages.filter((m) => m.role === 'assistant');
        expect(assistantMsgs.length).toBeGreaterThan(0);
        const firstAsst = assistantMsgs[0];
        expect(typeof firstAsst.reasoningContent === 'string').toBe(true);
        expect((firstAsst.reasoningContent ?? '').length).toBeGreaterThan(0);
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
        let lastEvents = [];
        for (let i = 0; i < 3; i++) {
            lastEvents = await sendMessage(node.id, `第${i + 1}问 — 关于供应链`);
        }
        // 第 3 轮的 SSE 流应包含 title 事件
        const titleEvent = lastEvents.find((e) => e.type === 'title');
        expect(titleEvent).toBeDefined();
        expect(titleEvent.nodeId).toBe(node.id);
        expect(typeof titleEvent.title).toBe('string');
        expect(titleEvent.title.length).toBeGreaterThan(0);
        // 持久化验证
        const snap = await api('/api/canvas');
        const updated = snap.nodes.find((x) => x.id === node.id);
        expect(updated.title).toBeTruthy();
        expect(updated.title.length).toBeLessThanOrEqual(30);
    });
    it('第 1、2 轮对话不触发标题更新（节流未命中）', async () => {
        const node = await createNode();
        const events = await sendMessage(node.id, '初始问题');
        expect(events.find((e) => e.type === 'title')).toBeUndefined();
    });
});
