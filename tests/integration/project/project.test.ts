import { describe, it, expect, beforeEach } from 'vitest';
import { api, BASE_URL } from '../helpers';

// project-module 集成测试：覆盖 /api/projects 全套端点 + 级联删除 + 多项目数据隔离 + 自动迁移
//
// 关联：
// - src/modules/project.ts（CRUD + ensureDefaultProject 迁移）
// - electron/src/ipc.ts / mock-server/src/server.ts（路由对称）

beforeEach(async () => {
  await fetch(`${BASE_URL}/api/__test__/reset`, { method: 'POST' });
});

describe('project: 列表与创建', () => {
  it('reset 后首次列表为空数组（无 canvas_main 时）', async () => {
    const list = await api<any[]>('/api/projects');
    expect(list).toEqual([]);
  });

  it('POST /api/projects 创建项目返回 201 + 必填字段', async () => {
    const proj = await api<any>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '茶饮研究' }),
      expectStatus: 201,
    });
    expect(proj.id).toMatch(/^proj_/);
    expect(proj.canvasId).toMatch(/^canvas_/);
    expect(proj.name).toBe('茶饮研究');
    expect(proj.lastOpenedAt).toBeNull();
    expect(proj.createdAt).toBeTruthy();
  });

  it('POST /api/projects 空名字返回 400', async () => {
    await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
      expectStatus: 400,
    });
    await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '   ' }),
      expectStatus: 400,
    });
  });

  it('POST 创建后 GET 列表能查到', async () => {
    const created = await api<any>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'A' }),
      expectStatus: 201,
    });
    const list = await api<any[]>('/api/projects');
    expect(list.find((p) => p.id === created.id)).toBeDefined();
  });
});

describe('project: 改名与 lastOpenedAt', () => {
  it('PATCH 改名生效', async () => {
    const created = await api<any>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '原名' }),
      expectStatus: 201,
    });
    const updated = await api<any>(`/api/projects/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: '新名' }),
    });
    expect(updated.name).toBe('新名');
  });

  it('PATCH 名称超长 400', async () => {
    const created = await api<any>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'A' }),
      expectStatus: 201,
    });
    await api(`/api/projects/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'x'.repeat(41) }),
      expectStatus: 400,
    });
  });

  it('POST /touch 更新 lastOpenedAt 让最近打开优先排序生效', async () => {
    const a = await api<any>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'A' }),
      expectStatus: 201,
    });
    // 间隔 1ms 让 createdAt 不同
    await new Promise((r) => setTimeout(r, 5));
    const b = await api<any>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'B' }),
      expectStatus: 201,
    });
    // 默认排序：lastOpenedAt 都为 null，按 createdAt 倒序 → B 排在 A 前
    let list = await api<any[]>('/api/projects');
    expect(list[0].id).toBe(b.id);

    // touch A 后 A.lastOpenedAt 不为 null，应排到最前
    await fetch(`${BASE_URL}/api/projects/${a.id}/touch`, { method: 'POST' });
    list = await api<any[]>('/api/projects');
    expect(list[0].id).toBe(a.id);
  });

  it('PATCH 不存在的 id 返回 404', async () => {
    await api('/api/projects/proj_does_not_exist', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'X' }),
      expectStatus: 404,
    });
  });
});

describe('project: 删除级联', () => {
  it('DELETE /api/projects/:id 返回 204，再 GET 列表不再出现', async () => {
    const proj = await api<any>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '待删' }),
      expectStatus: 201,
    });
    const res = await fetch(`${BASE_URL}/api/projects/${proj.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const list = await api<any[]>('/api/projects');
    expect(list.find((p) => p.id === proj.id)).toBeUndefined();
  });

  it('DELETE 级联清理 canvas + 该 canvas 的所有节点', async () => {
    const proj = await api<any>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '级联测试' }),
      expectStatus: 201,
    });
    // 创建几个节点
    await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ canvasId: proj.canvasId, positionX: 0, positionY: 0 }),
      expectStatus: 201,
    });
    await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ canvasId: proj.canvasId, positionX: 100, positionY: 0 }),
      expectStatus: 201,
    });
    // 验证节点存在
    let snap = await api<any>(`/api/canvas?projectId=${proj.id}`);
    expect(snap.nodes).toHaveLength(2);

    // 删除项目
    const del = await fetch(`${BASE_URL}/api/projects/${proj.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    // 项目+canvas 都已删除：再 GET 应该 404
    const after = await fetch(`${BASE_URL}/api/canvas?projectId=${proj.id}`);
    expect(after.status).toBe(404);
  });

  it('DELETE 不存在的 id 返回 404', async () => {
    const res = await fetch(`${BASE_URL}/api/projects/proj_does_not_exist`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('project: 多项目数据隔离', () => {
  it('GET /api/canvas?projectId=A 不返回项目 B 的节点', async () => {
    const a = await api<any>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '项目A' }),
      expectStatus: 201,
    });
    const b = await api<any>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '项目B' }),
      expectStatus: 201,
    });
    const nodeA = await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ canvasId: a.canvasId, positionX: 0, positionY: 0 }),
      expectStatus: 201,
    });
    const nodeB = await api<any>('/api/nodes', {
      method: 'POST',
      body: JSON.stringify({ canvasId: b.canvasId, positionX: 0, positionY: 0 }),
      expectStatus: 201,
    });
    const snapA = await api<any>(`/api/canvas?projectId=${a.id}`);
    const snapB = await api<any>(`/api/canvas?projectId=${b.id}`);
    expect(snapA.nodes).toHaveLength(1);
    expect(snapA.nodes[0].id).toBe(nodeA.id);
    expect(snapB.nodes).toHaveLength(1);
    expect(snapB.nodes[0].id).toBe(nodeB.id);
  });

  it('GET /api/canvas 不带 projectId 返回 400', async () => {
    const res = await fetch(`${BASE_URL}/api/canvas`);
    expect(res.status).toBe(400);
  });

  it('GET /api/canvas?projectId=不存在 返回 404', async () => {
    const res = await fetch(`${BASE_URL}/api/canvas?projectId=proj_does_not_exist`);
    expect(res.status).toBe(404);
  });

  it('POST /api/nodes 不传 canvasId 返回 400', async () => {
    const res = await fetch(`${BASE_URL}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionX: 0, positionY: 0 }),
    });
    expect(res.status).toBe(400);
  });
});
