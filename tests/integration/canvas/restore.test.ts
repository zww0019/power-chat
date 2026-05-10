import { describe, it, expect, beforeEach } from 'vitest';
import { api, BASE_URL, createNode, createBranchedPair , getCanvas } from '../helpers';

// canvas-module: POST /api/nodes/restore（撤销删除节点的服务端落点）
// 关联文档：
// - docs/02-domain-model.md §1.7 ActionLog / §3.4 reverse_payload / INV-3 / INV-10
// - docs/04-api-contract.yaml /api/nodes/restore
// - md/04-技术决策/electron-build-packaging.md（技术约束）

beforeEach(async () => {
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

describe('canvas: POST /api/nodes/restore', () => {
  it('恢复仅含节点（无消息无边）的最小快照', async () => {
    const node = await createNode({ positionX: 100, positionY: 200 });
    await api(`/api/nodes/${node.id}`, { method: 'DELETE', expectStatus: 204 });

    // 确认已删
    const before = await getCanvas();
    expect(before.nodes.find((n: any) => n.id === node.id)).toBeUndefined();

    // 用原 snapshot 恢复
    await api('/api/nodes/restore', {
      method: 'POST',
      body: JSON.stringify({ node, messages: [], edges: [] }),
      expectStatus: 204,
    });

    const after = await getCanvas();
    const restored = after.nodes.find((n: any) => n.id === node.id);
    expect(restored).toBeDefined();
    expect(restored.positionX).toBe(100);
    expect(restored.positionY).toBe(200);
    expect(restored.id).toBe(node.id);
  });

  it('id 已存在时返回 409 already_exists（避免覆盖现有数据）', async () => {
    const node = await createNode({ positionX: 0, positionY: 0 });
    // 节点未删的情况下尝试 restore：应该 409
    const res = await fetch(`${BASE_URL}/api/nodes/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node, messages: [], edges: [] }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('already_exists');
  });

  it('完整快照恢复：节点 + 消息 + branch 边（INV-3 inheritedUntilSequence 原样写回）', async () => {
    const { parent, child, edge } = await createBranchedPair();

    // 抓取删除前的完整快照（snapshot of parent）
    const before = await getCanvas();
    const parentNode = before.nodes.find((n: any) => n.id === parent.id);
    const parentMsgs = before.messages.filter((m: any) => m.nodeId === parent.id);
    const parentEdges = before.edges.filter(
      (e: any) => e.parentNodeId === parent.id || e.childNodeId === parent.id,
    );
    expect(parentMsgs.length).toBeGreaterThan(0);
    const branchEdgeBefore = parentEdges.find((e: any) => e.id === edge.id);
    expect(branchEdgeBefore).toBeDefined();
    const inheritedSeq = branchEdgeBefore.inheritedUntilSequence;
    expect(inheritedSeq).not.toBeNull();

    // 删除父节点
    await api(`/api/nodes/${parent.id}`, { method: 'DELETE', expectStatus: 204 });

    // 恢复
    await api('/api/nodes/restore', {
      method: 'POST',
      body: JSON.stringify({ node: parentNode, messages: parentMsgs, edges: parentEdges }),
      expectStatus: 204,
    });

    const after = await getCanvas();
    expect(after.nodes.find((n: any) => n.id === parent.id)).toBeDefined();
    expect(after.messages.filter((m: any) => m.nodeId === parent.id).length).toBe(parentMsgs.length);
    const restoredEdge = after.edges.find((e: any) => e.id === edge.id);
    expect(restoredEdge).toBeDefined();
    // INV-3：分支边 inheritedUntilSequence 必须原样写回
    expect(restoredEdge.inheritedUntilSequence).toBe(inheritedSeq);
    // 子节点链路完整：edge 两端都能查到
    expect(after.nodes.find((n: any) => n.id === child.id)).toBeDefined();
  });

  it('对端节点已被独立删除时，悬空边照常入库（前端渲染层兜底过滤）', async () => {
    const a = await createNode({ positionX: 0, positionY: 0 });
    const b = await createNode({ positionX: 200, positionY: 0 });
    // 通过 branch 让 a→b 有一条边
    const events = await import('../helpers').then(({ sendMessage }) => sendMessage(a.id, 'x'));
    const done = events.find((e: any) => e.type === 'done') as { messageId: string };
    const branch = await api<any>('/api/nodes/branch', {
      method: 'POST',
      body: JSON.stringify({ parentNodeId: a.id, fromMessageId: done.messageId }),
      expectStatus: 201,
    });
    const branchEdge = branch.edge;
    const branchChild = branch.node;

    // 抓 a 的快照（含触及 a 的边）
    const before = await getCanvas();
    const aSnapshot = {
      node: before.nodes.find((n: any) => n.id === a.id),
      messages: before.messages.filter((m: any) => m.nodeId === a.id),
      edges: before.edges.filter((e: any) => e.parentNodeId === a.id || e.childNodeId === a.id),
    };
    expect(aSnapshot.edges.find((e: any) => e.id === branchEdge.id)).toBeDefined();

    // 先删 a（断链），再删它的子分支节点（让快照中的边对端不存在）
    await api(`/api/nodes/${a.id}`, { method: 'DELETE', expectStatus: 204 });
    await api(`/api/nodes/${branchChild.id}`, { method: 'DELETE', expectStatus: 204 });

    // 恢复 a：snapshot 中包含一条对端 (branchChild) 已不存在的边
    await api('/api/nodes/restore', {
      method: 'POST',
      body: JSON.stringify(aSnapshot),
      expectStatus: 204,
    });

    const after = await getCanvas();
    // 节点 a 恢复 + 悬空边照常入库（按用户决策"保留边数据"）
    expect(after.nodes.find((n: any) => n.id === a.id)).toBeDefined();
    expect(after.edges.find((e: any) => e.id === branchEdge.id)).toBeDefined();
    // 但 b/branchChild 真的不在（INV：未恢复就是不在）
    expect(after.nodes.find((n: any) => n.id === branchChild.id)).toBeUndefined();
    // 仅校验存在 b（未参与本测试的删除/恢复）：b 仍在
    expect(after.nodes.find((n: any) => n.id === b.id)).toBeDefined();
  });

  it('请求体缺字段返回 400 bad_request', async () => {
    const res = await fetch(`${BASE_URL}/api/nodes/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: { id: 'x' } }), // 缺 messages/edges
    });
    expect(res.status).toBe(400);
  });
});
