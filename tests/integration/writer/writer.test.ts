import { describe, it, expect, beforeEach } from 'vitest';
import { api, consumeSSE, BASE_URL } from '../helpers';

// writer-module 集成测试
// INV-2 (written 节点不展开父链) + session-writer 流程

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

describe('writer: 创建撰写任务', () => {
  it('提交 N 个源节点返回 201 + {node:written, edges:N条, streamUrl}', async () => {
    const a = await createNodeWithContent('供应链问题');
    const b = await createNodeWithContent('监管差异');
    const result = await api<any>('/api/write', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a, b], writingRequest: '写成技术博客' }),
      expectStatus: 201,
    });
    expect(result.node.type).toBe('written');
    expect(result.edges).toHaveLength(2);
    for (const e of result.edges) {
      expect(e.edgeKind).toBe('write_input');
      expect([a, b]).toContain(e.parentNodeId);
      expect(e.childNodeId).toBe(result.node.id);
      expect(e.inheritedUntilSequence).toBeNull();
    }
    expect(result.streamUrl).toMatch(/\/api\/write\/stream\//);
  });

  it('提交 0 个源节点返回 400', async () => {
    await api('/api/write', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [], writingRequest: null }),
      expectStatus: 400,
    });
  });

  it('streamUrl 拉取后返回 SSE 流，含 content + done', async () => {
    const a = await createNodeWithContent('供应链');
    const result = await api<any>('/api/write', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], writingRequest: null }),
      expectStatus: 201,
    });
    const events = await consumeSSE(result.streamUrl);
    const types = events.map((e) => e.type);
    expect(types).toContain('content');
    expect(types[types.length - 1]).toBe('done');
  });

  it('撰写输出为第一人称叙事文章（非结构纲要）', async () => {
    const a = await createNodeWithContent('茶饮出海的供应链问题');
    const result = await api<any>('/api/write', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], writingRequest: null }),
      expectStatus: 201,
    });
    const events = await consumeSSE(result.streamUrl);
    const fullContent = events
      .filter((e) => e.type === 'content')
      .map((e) => (e as any).delta as string)
      .join('');

    // 不应出现提炼的四栏 marker（证明是撰写模式而非提炼模式）
    expect(fullContent).not.toContain('【核心结论】');
    expect(fullContent).not.toContain('【关键论据】');

    // 应有第一人称表达
    // WRITE_RESPONSE mock 以"上周"开头 + "我"出现多次
    const hasFirstPerson = /我/.test(fullContent);
    expect(hasFirstPerson).toBe(true);

    // 不应出现 AI 高频总结词
    expect(fullContent).not.toContain('综上所述');
    expect(fullContent).not.toContain('值得注意的是');
  });

  it('written 节点不支持直接发消息（INV-2 守卫）', async () => {
    const a = await createNodeWithContent('任意内容');
    const result = await api<any>('/api/write', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], writingRequest: null }),
      expectStatus: 201,
    });
    // 流式完成（消费完）
    await consumeSSE(result.streamUrl);

    // 尝试对 written 节点发消息应该返回 error 事件
    const events = await consumeSSE(`/api/nodes/${result.node.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '追问' }),
    });
    const err = events.find((e) => e.type === 'error') as any;
    expect(err).toBeTruthy();
    expect(err.error).toBe('cannot_send_to_refined_or_written_node');
    // 确认未产生 user_persisted / done（即没有真的写入消息）
    expect(events.find((e) => e.type === 'user_persisted')).toBeUndefined();
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
  });

  it('支持用户自定义写作要求（writingRequest）', async () => {
    const a = await createNodeWithContent('茶饮出海');
    const result = await api<any>('/api/write', {
      method: 'POST',
      body: JSON.stringify({
        sourceNodeIds: [a],
        writingRequest: '写成轻松的博客，给投资人看',
      }),
      expectStatus: 201,
    });
    expect(result.node.type).toBe('written');
    expect(result.streamUrl).toContain('/api/write/stream/');

    const events = await consumeSSE(result.streamUrl);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('流式输出：Phase 1 流式 content 初稿，Phase 2 不再产生迭代事件，done 收尾', async () => {
    const a = await createNodeWithContent('供应链问题');
    const result = await api<any>('/api/write', {
      method: 'POST',
      body: JSON.stringify({ sourceNodeIds: [a], writingRequest: null }),
      expectStatus: 201,
    });
    const events = await consumeSSE(result.streamUrl);
    const types = events.map((e) => e.type);

    // Phase 1：content 事件流式产出初稿
    expect(types).toContain('content');

    // 旧的多轮迭代事件 rewrite_round 已从契约删除，任何撰写流都不应再出现
    expect(events.find((e) => e.type === 'rewrite_round')).toBeUndefined();

    // 最后是 done；finalContent 为可选字段（mock 改写命中长度安全网时不携带，
    // 仅当 humanizer 实际产出有效改写时才会设置——契约不强制存在）
    const last = events[events.length - 1] as any;
    expect(last.type).toBe('done');
    if (last.finalContent !== undefined) {
      expect(typeof last.finalContent).toBe('string');
      expect((last.finalContent as string).length).toBeGreaterThan(0);
    }
  });
});
