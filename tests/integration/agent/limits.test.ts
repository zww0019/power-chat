import { describe, it, expect, beforeEach } from 'vitest';
import { BASE_URL, createNode, sendMessage } from '../helpers';

// agent-module · 硬约束触限路径（R018）
// 测试 max_same_tool（同种工具调用 5 次）与 max_steps（单次循环 8 步）触限后能优雅总结

beforeEach(async () => {
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

describe('agent: 硬约束触限', () => {
  it('同种工具连续调用超过 5 次时 yield agent_final reason=max_same_tool 并以 done 收尾', async () => {
    const node = await createNode();
    // __force_loop_search__ 让 mock LLM 跨多轮持续返回 web_search tool_call
    const events = await sendMessage(node.id, '搜一下供应链 __force_loop_search__');
    const final = events.find((e) => e.type === 'agent_final') as { reason: string } | undefined;
    expect(final).toBeDefined();
    expect(final!.reason).toBe('max_same_tool');
    expect(events[events.length - 1]!.type).toBe('done');

    // 触限后还应有总结 content delta（决策 9：再调一次 LLM 给总结）
    const finalIdx = events.findIndex((e) => e.type === 'agent_final');
    const afterFinal = events.slice(finalIdx + 1);
    const contentAfter = afterFinal.filter((e) => e.type === 'content');
    expect(contentAfter.length).toBeGreaterThan(0);
  }, 30_000);

  it('交替工具调用累积超过 8 步时 yield agent_final reason=max_steps', async () => {
    const node = await createNode();
    // __force_loop_alternate__ 让 mock LLM 交替返回两种工具，每种各调 4 次后撞 max_steps
    const events = await sendMessage(node.id, '搜一下 __force_loop_alternate__');
    const final = events.find((e) => e.type === 'agent_final') as { reason: string } | undefined;
    expect(final).toBeDefined();
    expect(final!.reason).toBe('max_steps');
    expect(events[events.length - 1]!.type).toBe('done');
  }, 30_000);
});
