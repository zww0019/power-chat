import { describe, it, expect, beforeEach } from 'vitest';
import { api, consumeSSE, BASE_URL } from '../helpers';

// refine-module 集成测试
// INV-2, INV-4 + 旅程1 阶段 C-D 步骤 15-23

beforeEach(async () => {
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

async function createNodeWithContent(content: string): Promise<string> {
  const n = await api<any>('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ positionX: 0, positionY: 0 }),
    expectStatus: 201,
  });
  await consumeSSE(`/api/nodes/${n.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return n.id;
}

describe('refine: 创建提炼任务', () => {
  it('提交 N 个源节点返回 201 + {node:refined, edges:N条, streamUrl}', async () => {
    const a = await createNodeWithContent('供应链');
    const b = await createNodeWithContent('监管');
    const c = await createNodeWithContent('品牌叙事');
    const result = await api<any>('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a, b, c], intentQuestion: '决策框架' }),
      expectStatus: 201,
    });
    expect(result.node.type).toBe('refined');
    expect(result.edges).toHaveLength(3);
    for (const e of result.edges) {
      expect(e.edgeKind).toBe('refine_input');
      expect([a, b, c]).toContain(e.parentNodeId);
      expect(e.childNodeId).toBe(result.node.id);
      expect(e.inheritedUntilSequence).toBeNull();
    }
    expect(result.streamUrl).toMatch(/\/api\/refine\/stream\//);
  });

  it('提交 0 个源节点返回 400', async () => {
    await api('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [], intentQuestion: null }),
      expectStatus: 400,
    });
  });

  it('streamUrl 拉取后返回 SSE 流，含 content + done', async () => {
    const a = await createNodeWithContent('阻力');
    const result = await api<any>('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], intentQuestion: null }),
      expectStatus: 201,
    });
    const events = await consumeSSE(result.streamUrl);
    const types = events.map((e) => e.type);
    expect(types).toContain('content');
    expect(types[types.length - 1]).toBe('done');
  });

  it('提炼输出包含强制四栏 marker（R011 / D008）', async () => {
    const a = await createNodeWithContent('阻力');
    const result = await api<any>('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], intentQuestion: null }),
      expectStatus: 201,
    });
    const events = await consumeSSE(result.streamUrl);
    const fullContent = events
      .filter((e) => e.type === 'content')
      .map((e) => (e as any).delta as string)
      .join('');
    // R011：四栏 marker 必须用全角中括号 + 完整文字
    expect(fullContent).toContain('【核心结论】');
    expect(fullContent).toContain('【关键论据】');
    expect(fullContent).toContain('【未解决 / 待验证】');
    expect(fullContent).toContain('【可能的下一步】');
  });

  it('streamUrl token 一次性使用，第二次拉取返回 token_not_found', async () => {
    const a = await createNodeWithContent('阻力');
    const result = await api<any>('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], intentQuestion: null }),
      expectStatus: 201,
    });
    // 第一次消费完整
    await consumeSSE(result.streamUrl);
    // 第二次应该返回 error 事件
    const events2 = await consumeSSE(result.streamUrl);
    const errorEvt = events2.find((e) => e.type === 'error') as any;
    expect(errorEvt).toBeDefined();
    expect(errorEvt.error).toBe('token_not_found');
  });

  it('intentQuestion 为 null 时使用综合性提炼默认 prompt（mock 仍返回内容）', async () => {
    const a = await createNodeWithContent('阻力');
    const result = await api<any>('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], intentQuestion: null }),
      expectStatus: 201,
    });
    const events = await consumeSSE(result.streamUrl);
    const content = events
      .filter((e) => e.type === 'content')
      .map((e: any) => e.delta)
      .join('');
    expect(content.length).toBeGreaterThan(0);
  });
});

describe('refine: INV-4 提炼边的合法性', () => {
  it('每条 refine_input 边的 child 都是 refined 节点', async () => {
    const a = await createNodeWithContent('阻力');
    const b = await createNodeWithContent('反例');
    const result = await api<any>('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a, b], intentQuestion: null }),
      expectStatus: 201,
    });
    const snap = await api<any>('/api/canvas');
    const refinedIds = new Set(
      snap.nodes.filter((n: any) => n.type === 'refined').map((n: any) => n.id),
    );
    for (const e of snap.edges) {
      if (e.edgeKind === 'refine_input') {
        expect(refinedIds.has(e.childNodeId)).toBe(true);
      }
    }
  });
});

describe('refine: 混合类型源节点（Q4-4 选 A 允许）', () => {
  it('选中对话节点 + 提炼节点混合提炼时，全部当原料处理', async () => {
    const a = await createNodeWithContent('阻力');
    // 先做一次提炼得到提炼节点
    const r1 = await api<any>('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], intentQuestion: null }),
      expectStatus: 201,
    });
    await consumeSSE(r1.streamUrl);
    // 再用对话节点 + 提炼节点混合做第二次提炼
    const b = await createNodeWithContent('反例');
    const r2 = await api<any>('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [r1.node.id, b], intentQuestion: '综合' }),
      expectStatus: 201,
    });
    expect(r2.edges).toHaveLength(2);
  });
});

describe('refine: INV-2 提炼节点的减熵', () => {
  it.skip('提炼后再在提炼节点上对话，AI 上下文 = 提炼输出 + 新对话，不展开原节点', async () => {
    // 需要拦截 LLM 客户端的 outbound 请求验证 messages 数组内容
    // 当前 mock 模式无 spy 注入；Stage 7 加依赖注入后启用
  });
});

describe('refine: 提炼节点不再支持直接发消息', () => {
  // UI 已用"继续追问"按钮替换输入框（孵化对话子节点继承提炼输出），
  // 后端守卫为防御层：旧客户端/绕过前端的调用被拒绝，确保"提炼即终态"语义。
  it('在提炼节点上 POST /messages 应立即返回 error 事件', async () => {
    const a = await createNodeWithContent('素材');
    const r = await api<any>('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], intentQuestion: null }),
      expectStatus: 201,
    });
    await consumeSSE(r.streamUrl);
    const events = await consumeSSE(`/api/nodes/${r.node.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '能不能再展开第二点' }),
    });
    const err = events.find((e) => e.type === 'error') as any;
    expect(err).toBeTruthy();
    expect(err.error).toBe('cannot_send_to_refined_node');
    // 确认未产生 user_persisted / done（即没有真的写入消息）
    expect(events.find((e) => e.type === 'user_persisted')).toBeUndefined();
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
  });

  it('在提炼节点上 branchNode 应正常工作（继续追问的底层路径）', async () => {
    const a = await createNodeWithContent('素材');
    const r = await api<any>('/api/refine', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], intentQuestion: null }),
      expectStatus: 201,
    });
    const streamEvents = await consumeSSE(r.streamUrl);
    const done = streamEvents.find((e) => e.type === 'done') as any;
    expect(done).toBeTruthy();
    // 在提炼节点的 assistant 消息上孵化对话子节点
    const branch = await api<any>('/api/nodes/branch', {
      method: 'POST',
      body: JSON.stringify({ parentNodeId: r.node.id, fromMessageId: done.messageId }),
      expectStatus: 201,
    });
    expect(branch.node.type).toBe('dialogue');
    expect(branch.edge.edgeKind).toBe('branch');
    expect(branch.edge.parentNodeId).toBe(r.node.id);
    expect(branch.edge.inheritedUntilSequence).toBe(0);
  });
});
