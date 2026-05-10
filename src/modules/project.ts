// project-module
// 项目 CRUD + 默认项目自动迁移。一个 Project 1:1 关联一个 Canvas（Project.canvasId）。
// 删除项目时级联删除 canvas + 该 canvas 下的 nodes/edges/messages（INV-5 同思路）。
//
// 迁移语义：旧版本只有一个硬编码 canvas_main 画布。首次进入新版本时若检测到
// "projects 表为空且 canvas_main 存在"，自动创建一个名为"默认项目"的 Project
// 包住老数据，让用户无感升级。

import type { Project, Canvas, Node, Edge, Message } from '../types.js';
import { getPersistence } from './persistence.js';
import { createCanvas } from './canvas.js';

const LEGACY_CANVAS_ID = 'canvas_main';

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
const nowIso = () => new Date().toISOString();

export async function listProjects(): Promise<Project[]> {
  await ensureDefaultProject();
  const p = getPersistence();
  const all = await p.list<Project>('projects');
  // 排序：lastOpenedAt 倒序优先；从未打开过的项目按 createdAt 倒序排在后面
  return all.sort((a, b) => {
    const aTime = a.lastOpenedAt ?? '';
    const bTime = b.lastOpenedAt ?? '';
    if (aTime !== bTime) return bTime.localeCompare(aTime);
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export async function getProject(id: string): Promise<Project | null> {
  return getPersistence().get<Project>('projects', id);
}

// 创建项目：同时创建对应的 canvas（1:1 绑定）。
// name 由调用方提供而非后端生成默认值——让前端控制 i18n 与 UX 命名策略（如"未命名项目"、"New Project"）。
export async function createProject(params: { name: string }): Promise<Project> {
  const projectId = newId('proj');
  const canvasId = newId('canvas');
  const now = nowIso();
  const project: Project = {
    id: projectId,
    name: params.name,
    canvasId,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: null,
  };
  await createCanvas(canvasId);
  await getPersistence().put('projects', projectId, project);
  return project;
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'lastOpenedAt'>>,
): Promise<Project | null> {
  const p = getPersistence();
  const project = await p.get<Project>('projects', id);
  if (!project) return null;
  if (patch.name !== undefined && (patch.name.trim().length === 0 || patch.name.length > 40)) {
    throw new Error('project name must be non-empty and within 40 characters');
  }
  const updated: Project = { ...project, ...patch, updatedAt: nowIso() };
  await p.put('projects', id, updated);
  return updated;
}

// 标记项目"被打开"。前端从 HomePage 跳转到 CanvasPage 前调用一次，
// 让首页排序按访问近期反映真实使用顺序。
export async function touchProject(id: string): Promise<void> {
  await updateProject(id, { lastOpenedAt: nowIso() });
}

// 删除项目：级联清理 canvas + 该 canvas 下的所有 nodes / edges / messages。
// 不做"是否最后一个项目"的守卫——允许用户清空到 0，HomePage 会显示空状态引导新建。
// 删除前调用方需自行保证该项目下没有正在流式输出的节点（前端已在 UI 层守卫）。
export async function deleteProject(id: string): Promise<boolean> {
  const p = getPersistence();
  const project = await p.get<Project>('projects', id);
  if (!project) return false;

  await p.transaction(async () => {
    const canvasId = project.canvasId;
    // 先删该项目所属画布的节点 + 这些节点关联的 messages 和 edges
    const nodes = await p.list<Node>('nodes', (n) => n.canvasId === canvasId);
    const nodeIdSet = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      await p.delete('nodes', n.id);
    }
    const messages = await p.list<Message>('messages', (m) => nodeIdSet.has(m.nodeId));
    for (const m of messages) {
      await p.delete('messages', m.id);
    }
    const edges = await p.list<Edge>('edges', (e) => nodeIdSet.has(e.parentNodeId) || nodeIdSet.has(e.childNodeId));
    for (const e of edges) {
      await p.delete('edges', e.id);
    }
    // 再删 canvas 与 project 自身
    await p.delete('canvases', canvasId);
    await p.delete('projects', id);
  });
  return true;
}

// 启动迁移：检测旧版本 canvas_main 数据，自动包成"默认项目"让用户无感升级。
// 触发条件：projects 表为空 + canvases.canvas_main 存在 → 创建默认项目并把 canvas_main 关联给它。
// projects 表非空时是已迁移过的状态，幂等 no-op；canvas_main 不存在时是全新用户，no-op。
export async function ensureDefaultProject(): Promise<void> {
  const p = getPersistence();
  const projects = await p.list<Project>('projects');
  if (projects.length > 0) return;
  const legacyCanvas = await p.get<Canvas>('canvases', LEGACY_CANVAS_ID);
  if (!legacyCanvas) return;
  const now = nowIso();
  const project: Project = {
    id: newId('proj'),
    name: '默认项目',
    canvasId: LEGACY_CANVAS_ID,
    createdAt: legacyCanvas.createdAt ?? now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  await p.put('projects', project.id, project);
}
