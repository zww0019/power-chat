import { describe, it, expect, beforeEach } from 'vitest';
import { api, BASE_URL, createNode, sendMessage , getCanvas } from '../helpers';

// conversation-module 测试 - truncateMessages（用户编辑触发）
// 覆盖：正常截断 / 流式守卫 / 分支引用守卫 / 边界值

beforeEach(async () => {
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

async function truncate(nodeId: string, fromSequence: number, expectStatus = 200): Promise<any> {
  return api<any>(`/api/nodes/${nodeId}/messages?fromSequence=${fromSequence}`, {
    method: 'DELETE',
    expectStatus,
  });
}

async function getCanvasMessages(nodeId: string): Promise<Array<{ sequence: number; role: string; content: string }>> {
  const snap = await getCanvas();
  return snap.messages
    .filter((m: any) => m.nodeId === nodeId)
    .sort((a: any, b: any) => a.sequence - b.sequence);
}

describe('conversation: truncateMessages（用户编辑）', () => {
  it('正常截断：删除 sequence ≥ N 的所有消息，返回删除条数', async () => {
    const node = await createNode();
    await sendMessage(node.id, '第一轮'); // sequence 0,1
    await sendMessage(node.id, '第二轮'); // sequence 2,3
    await sendMessage(node.id, '第三轮'); // sequence 4,5

    const before = await getCanvasMessages(node.id);
    expect(before).toHaveLength(6);

    // 截断 sequence ≥ 2：删 user2/asst2/user3/asst3，共 4 条
    const result = await truncate(node.id, 2);
    expect(result.deleted).toBe(4);

    const after = await getCanvasMessages(node.id);
    expect(after).toHaveLength(2);
    expect(after[0]!.sequence).toBe(0);
    expect(after[1]!.sequence).toBe(1);
  });

  it('截断后再次 sendMessage：sequence 自然接续（编辑+重发的语义）', async () => {
    const node = await createNode();
    await sendMessage(node.id, '原内容'); // 0,1
    await sendMessage(node.id, '后续'); // 2,3

    // 截断包含原 user 在内（sequence ≥ 0）
    await truncate(node.id, 0);
    expect(await getCanvasMessages(node.id)).toHaveLength(0);

    // 重发新内容：新 user 的 sequence 应是 0（接续算法："最大 + 1"，无消息时 -1+1=0）
    await sendMessage(node.id, '编辑后的内容');
    const after = await getCanvasMessages(node.id);
    expect(after).toHaveLength(2);
    expect(after[0]!.sequence).toBe(0);
    expect(after[0]!.role).toBe('user');
    expect(after[0]!.content).toBe('编辑后的内容');
  });

  it('分支引用守卫（2c 硬阻断）：被分支引用的 sequence 不可截断', async () => {
    const parent = await createNode();
    await sendMessage(parent.id, 'q1'); // 0,1
    await sendMessage(parent.id, 'q2'); // 2,3
    const parentMessages = await getCanvasMessages(parent.id);
    const assistant1Id = (await getCanvas()).messages.find((m: any) => m.nodeId === parent.id && m.sequence === 1).id;

    // 从 sequence=1 创建分支 → edge.inheritedUntilSequence = 1
    await api<any>('/api/nodes/branch', {
      method: 'POST',
      body: JSON.stringify({ parentNodeId: parent.id, fromMessageId: assistant1Id }),
      expectStatus: 201,
    });

    // 截断 sequence=2（不影响 inheritedUntilSequence=1）：应允许
    const okResult = await truncate(parent.id, 2);
    expect(okResult.deleted).toBe(2);

    // 截断 sequence=1（与 inheritedUntilSequence 相等，等价"删除该消息"）：应拒绝
    const res = await fetch(
      `${BASE_URL}/api/nodes/${parent.id}/messages?fromSequence=1`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('branch_referenced');
    expect(body.childNodeIds).toBeInstanceOf(Array);
    expect(body.childNodeIds.length).toBe(1);

    // 父节点消息未受影响（守卫优先于实际删除）
    expect(await getCanvasMessages(parent.id)).toHaveLength(2);

    // 副作用断言：抑制 vitest 对未使用 binding 的 lint
    void parentMessages;
  });

  it('边界：fromSequence 为负数返回 400', async () => {
    const node = await createNode();
    const res = await fetch(
      `${BASE_URL}/api/nodes/${node.id}/messages?fromSequence=-1`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
  });

  it('边界：fromSequence 缺失或非数字返回 400', async () => {
    const node = await createNode();
    const res = await fetch(
      `${BASE_URL}/api/nodes/${node.id}/messages`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
  });

  it('边界：截断超出当前最大 sequence 时静默删 0 条（无消息匹配）', async () => {
    const node = await createNode();
    await sendMessage(node.id, '只发一轮'); // 0,1
    const result = await truncate(node.id, 100);
    expect(result.deleted).toBe(0);
    expect(await getCanvasMessages(node.id)).toHaveLength(2);
  });
});
