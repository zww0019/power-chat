import { describe, it, expect, beforeEach } from 'vitest';
import { BASE_URL, createNode, consumeSSE } from '../helpers';
// agent-module · 中断闭环（M5 / R015 / 决策 25）
// 端点 POST /api/nodes/:id/messages/abort 让用户能在 streaming 中触发 agent_final(aborted_by_user)
beforeEach(async () => {
    await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});
describe('agent: 用户中断', () => {
    it('streaming 中调中断端点返回 204；SSE 流以 done 收尾', async () => {
        const node = await createNode();
        // 用 __force_loop_search__ 让 agent 持续循环，给中断留时间窗口
        const ssePromise = consumeSSE(`/api/nodes/${node.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '搜一下供应链 __force_loop_search__' }),
        });
        // 等 agent 启动并运行几个 step 后再中断
        await new Promise((r) => setTimeout(r, 150));
        const abortRes = await fetch(`${BASE_URL}/api/nodes/${node.id}/messages/abort`, {
            method: 'POST',
        });
        expect(abortRes.status).toBe(204);
        const events = await ssePromise;
        // 必有 agent_final（或 aborted_by_user 或 max_same_tool 取决于竞速）
        const final = events.find((e) => e.type === 'agent_final');
        expect(final).toBeDefined();
        expect(['aborted_by_user', 'max_same_tool', 'max_steps']).toContain(final.reason);
        expect(events[events.length - 1].type).toBe('done');
    }, 30_000);
    it('节点不在流式中时调中断端点返回 404 not_streaming', async () => {
        const node = await createNode();
        const res = await fetch(`${BASE_URL}/api/nodes/${node.id}/messages/abort`, { method: 'POST' });
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error).toBe('not_streaming');
    });
});
