import { describe, it, expect, beforeEach } from 'vitest';
import { api, BASE_URL, createBranchedPair } from '../helpers';

// canvas-module 集成测试
// Stage 6: 多数测试已可验证（mock-server 调真实模块）
//
// 关联文档：
// - docs/02-domain-model.md INV-5, INV-6, INV-7, INV-12
// - docs/04-api-contract.yaml /api/canvas, /api/nodes/*
// - docs/01-journeys/analyst-canvas-edits.md

beforeEach(async () => {
  // 每个测试前清空数据库（仅 mock-server 测试模式开放）
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

describe('canvas: 首屏快照', () => {
  it('首次启动返回空画布、单一 canvas 行（INV-12）', async () => {
    const data = await api<any>('/api/canvas');
    expect(data.canvas).toBeDefined();
    expect(data.canvas.id).toBeTruthy();
    expect(typeof data.canvas.viewportZoom).toBe('number');
    expect(data.nodes).toEqual([]);
    expect(data.edges).toEqual([]);
    expect(data.messages).toEqual([]);
  });

  it('插入节点后再 GET 返回完整快照', async () => {
    const n1 = await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ positionX: 0, positionY: 0 }),
      expectStatus: 201,
    });
    const n2 = await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ positionX: 400, positionY: 0 }),
      expectStatus: 201,
    });
    const data = await api<any>('/api/canvas');
    expect(data.nodes).toHaveLength(2);
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual([n1.id, n2.id].sort());
  });
});

describe('canvas: 节点 CRUD', () => {
  it('用户双击空白处创建对话节点（旅程1 步骤1）', async () => {
    const node = await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ positionX: 100, positionY: -200, type: 'dialogue' }),
      expectStatus: 201,
    });
    expect(node.type).toBe('dialogue');
    expect(node.positionX).toBe(100);
    expect(node.positionY).toBe(-200);
    expect(node.collapsed).toBe(false);
    expect(node.title).toBeNull();
    expect(node.id).toMatch(/^n_/);
  });

  it('PATCH 节点位置后再 GET 返回新位置（旅程3 步骤1）', async () => {
    const n = await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ positionX: 0, positionY: 0 }),
      expectStatus: 201,
    });
    const patched = await api<any>(`/api/nodes/${n.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ positionX: 1500, positionY: 1100 }),
    });
    expect(patched.positionX).toBe(1500);
    expect(patched.positionY).toBe(1100);
    const snap = await api<any>('/api/canvas');
    const reloaded = snap.nodes.find((x: any) => x.id === n.id);
    expect(reloaded.positionX).toBe(1500);
  });

  it('PATCH 节点 collapsed=true 进入折叠态（PRD-FIX-1：用户主动）', async () => {
    const n = await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ positionX: 0, positionY: 0 }),
      expectStatus: 201,
    });
    const patched = await api<any>(`/api/nodes/${n.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ collapsed: true }),
    });
    expect(patched.collapsed).toBe(true);
  });

  it('PATCH title 字段限长 30 字符', async () => {
    const n = await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ positionX: 0, positionY: 0 }),
      expectStatus: 201,
    });
    await api(`/api/nodes/${n.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'x'.repeat(31) }),
      expectStatus: 400,
    });
  });

  it('删除节点返回 204，再 GET 不再出现', async () => {
    const n = await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ positionX: 0, positionY: 0 }),
      expectStatus: 201,
    });
    const res = await fetch(`${BASE_URL}/api/nodes/${n.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const snap = await api<any>('/api/canvas');
    expect(snap.nodes.find((x: any) => x.id === n.id)).toBeUndefined();
  });

  it('删除节点级联删除入/出边，子孙节点保留（INV-5, Q2-3 选 B）', async () => {
    const { parent: A, child: B } = await createBranchedPair('阻力');

    const res = await fetch(`${BASE_URL}/api/nodes/${A.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const snap = await api<any>('/api/canvas');
    expect(snap.nodes.find((x: any) => x.id === A.id)).toBeUndefined();
    expect(snap.nodes.find((x: any) => x.id === B.id)).toBeDefined(); // 子节点保留
    // 但 A→B 的边断开
    expect(snap.edges.find((e: any) => e.parentNodeId === A.id || e.childNodeId === A.id)).toBeUndefined();
  });

  it.skip('删除正在流式输出的节点返回 409（INV-7）', async () => {
    // 需要在流式中发起删除请求，时序难以稳定控制。Stage 7 用 LSP 注入控制点
  });
});

describe('canvas: 边删除', () => {
  it('DELETE /api/edges/:id 删除单条边返回 204，节点保留', async () => {
    const { parent: A, child: B, edge } = await createBranchedPair();

    const res = await fetch(`${BASE_URL}/api/edges/${edge.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const snap = await api<any>('/api/canvas');
    expect(snap.edges.find((e: any) => e.id === edge.id)).toBeUndefined();
    // 边删除不影响两端节点
    expect(snap.nodes.find((x: any) => x.id === A.id)).toBeDefined();
    expect(snap.nodes.find((x: any) => x.id === B.id)).toBeDefined();
  });

  it('DELETE /api/edges/:id 删不存在的边返回 404', async () => {
    const res = await fetch(`${BASE_URL}/api/edges/e_does_not_exist`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('canvas: 视野状态', () => {
  it.skip('PATCH /api/canvas viewport 持久化', async () => {
    // 契约目前 viewport 仅在 GET 中存在，未开 PATCH /canvas 端点
  });

  it.skip('viewportZoom 边界：拒绝 < 0.25 或 > 2.0', async () => {
    // 同上：未开 PATCH /canvas 端点
  });
});
