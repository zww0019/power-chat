import { describe, it, expect, beforeEach } from 'vitest';
import { api, consumeSSE, BASE_URL } from '../helpers';

// conversation-module 测试 - branch
// INV-1, INV-3 + 旅程1 步骤 7-13

beforeEach(async () => {
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

async function setupParentWithMessage(): Promise<{ parent: any; assistantMsgId: string }> {
  const parent = await api<any>('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ positionX: 0, positionY: 0 }),
    expectStatus: 201,
  });
  const events = await consumeSSE(`/api/nodes/${parent.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '阻力' }),
  });
  const done = events.find((e) => e.type === 'done') as any;
  return { parent, assistantMsgId: done.messageId };
}

describe('conversation: 分支动作', () => {
  it('返回 201 + {node, edge}，edge.edgeKind === branch', async () => {
    const { parent, assistantMsgId } = await setupParentWithMessage();
    const result = await api<any>('/api/nodes/branch', {
      method: 'POST',
      body: JSON.stringify({ parentNodeId: parent.id, fromMessageId: assistantMsgId }),
      expectStatus: 201,
    });
    expect(result.node.type).toBe('dialogue');
    expect(result.edge.edgeKind).toBe('branch');
    expect(result.edge.parentNodeId).toBe(parent.id);
    expect(result.edge.childNodeId).toBe(result.node.id);
  });

  it('Edge.inheritedUntilSequence 写入父节点 fromMessage 的 sequence（INV-3）', async () => {
    const { parent, assistantMsgId } = await setupParentWithMessage();
    // assistant 消息 sequence 应为 1（user=0, assistant=1）
    const result = await api<any>('/api/nodes/branch', {
      method: 'POST',
      body: JSON.stringify({ parentNodeId: parent.id, fromMessageId: assistantMsgId }),
      expectStatus: 201,
    });
    expect(result.edge.inheritedUntilSequence).toBe(1);
  });

  it('分支节点位置在父节点右侧偏移', async () => {
    const { parent, assistantMsgId } = await setupParentWithMessage();
    const result = await api<any>('/api/nodes/branch', {
      method: 'POST',
      body: JSON.stringify({ parentNodeId: parent.id, fromMessageId: assistantMsgId }),
      expectStatus: 201,
    });
    expect(result.node.positionX).toBeGreaterThan(parent.positionX);
  });

  it('支持多层深度分支，无 4 层限制（PRD-FIX-2）', async () => {
    let { parent: current, assistantMsgId } = await setupParentWithMessage();
    for (let i = 0; i < 6; i++) {
      const result = await api<any>('/api/nodes/branch', {
        method: 'POST',
        body: JSON.stringify({ parentNodeId: current.id, fromMessageId: assistantMsgId }),
        expectStatus: 201,
      });
      // 在新分支节点上发消息，准备下一轮
      const events = await consumeSSE(`/api/nodes/${result.node.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `深度 ${i + 1}` }),
      });
      const done = events.find((e) => e.type === 'done') as any;
      current = result.node;
      assistantMsgId = done.messageId;
    }
    // 验证拓扑：6 层分支链
    const snap = await api<any>('/api/canvas');
    expect(snap.nodes.length).toBe(7); // 1 父 + 6 分支
  });

  it.skip('父节点新增消息后子节点 LLM 调用上下文不含父节点新增内容（INV-3 + Q4-7）', async () => {
    // 需 spy LLM 客户端 outbound 请求验证；同 messages.test.ts 的 INV-11 测试
    // Stage 7 改为依赖注入后启用
  });

  it.skip('父节点删除后再次访问子节点的请求中无父链消息（解构验证）', async () => {
    // 同上
  });
});
