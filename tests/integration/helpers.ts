// 测试公用辅助。所有测试通过 HTTP 调 mock-server (Stage 5) 或真实 Electron IPC (Stage 6+)。
// Stage 5 阶段：BASE_URL = http://localhost:3001（mock-server）
// Stage 6 阶段：会切到 Electron 主进程，但因 OpenAPI 契约一致，测试代码不变

import { readSSELines, parseSSEData } from '../../src/modules/sse';

export const BASE_URL = process.env.POWER_CHAT_API ?? 'http://localhost:3001';

export async function api<T = unknown>(
  path: string,
  init?: RequestInit & { expectStatus?: number },
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (init?.expectStatus !== undefined) {
    if (res.status !== init.expectStatus) {
      throw new Error(`Expected status ${init.expectStatus} but got ${res.status}`);
    }
  } else if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[${res.status}] ${path}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * 测试 fixture：lazy 拿到一个可用项目的 canvasId。
 * 多项目改造后 createNode 必须显式传 canvasId，但绝大多数测试只关心"在某画布里创建节点"，
 * 不关心是哪个项目。每次调用先尝试取项目列表的首项；若无项目（reset 后状态）则创建一个测试项目。
 *
 * 不缓存——beforeEach 会 reset 数据库，缓存 id 会指向已删除的项目。每次 fetch 一次开销可忽略。
 */
export async function ensureTestProject(): Promise<{ id: string; canvasId: string }> {
  const projects = await api<any[]>('/api/projects');
  if (projects.length > 0) {
    return { id: projects[0].id, canvasId: projects[0].canvasId };
  }
  const created = await api<any>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '测试项目' }),
    expectStatus: 201,
  });
  return { id: created.id, canvasId: created.canvasId };
}

/**
 * 测试 fixture：取当前测试项目的画布快照。包装 GET /api/canvas?projectId=xxx，
 * 让既有测试代码（原本调 api('/api/canvas')）只需替换函数名。
 */
export async function getCanvas(): Promise<{ canvas: any; nodes: any[]; edges: any[]; messages: any[] }> {
  const proj = await ensureTestProject();
  return api<any>(`/api/canvas?projectId=${encodeURIComponent(proj.id)}`);
}

/**
 * 测试 fixture：创建一个节点。给定坐标省略时默认 (0,0)。
 * 自动调 ensureTestProject 拿 canvasId，调用方无需关心多项目隔离。
 */
export async function createNode(opts?: {
  positionX?: number;
  positionY?: number;
  type?: 'dialogue' | 'refined';
}): Promise<{ id: string; [k: string]: any }> {
  const proj = await ensureTestProject();
  const body: Record<string, unknown> = {
    canvasId: proj.canvasId,
    positionX: opts?.positionX ?? 0,
    positionY: opts?.positionY ?? 0,
  };
  if (opts?.type) body.type = opts.type;
  return api<any>('/api/nodes', {
    method: 'POST',
    body: JSON.stringify(body),
    expectStatus: 201,
  });
}

/**
 * 测试 fixture：给指定节点发一条用户消息，消费 SSE 流，返回所有事件。
 * 比直接调用 consumeSSE 少一层模板（method/headers/body 都固定）。
 */
export async function sendMessage(
  nodeId: string,
  content: string,
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  return consumeSSE(`/api/nodes/${nodeId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

/**
 * 测试 fixture：建一对父子节点 A→B（带 branch edge）。
 * 给 A 发一条消息以拿到 messageId，再用 messageId 发起 branch。
 * 多个测试用例都需要这个起点，统一封装避免 fixture 抄写。
 *
 * @param seedContent 发给父节点的第一条消息内容，用于触发 done 事件取得 messageId；
 *                    USE_MOCK_LLM=1 时内容不影响 mock 响应
 * @returns 父节点、子节点、连接边的 id 封装
 */
export async function createBranchedPair(seedContent = '触发分支'): Promise<{
  parent: { id: string };
  child: { id: string };
  edge: { id: string };
}> {
  const parent = await createNode();
  const events = await sendMessage(parent.id, seedContent);
  const done = events.find((e) => e.type === 'done') as { messageId: string } | undefined;
  if (!done) throw new Error('no done event from sendMessage stream');
  const branch = await api<any>('/api/nodes/branch', {
    method: 'POST',
    body: JSON.stringify({ parentNodeId: parent.id, fromMessageId: done.messageId }),
    expectStatus: 201,
  });
  return { parent, child: branch.node, edge: branch.edge };
}

/**
 * 消费一个 SSE 流，把所有事件收集成数组后返回（适合测试断言）。
 * path 须含 BASE_URL 前缀以外的部分，函数内部拼接 BASE_URL。
 */
export async function consumeSSE(path: string, init?: RequestInit): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const res = await fetch(`${BASE_URL}${path}`, init);
  if (!res.ok || !res.body) {
    throw new Error(`SSE ${path} failed: ${res.status}`);
  }
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const line of readSSELines(res.body)) {
    const obj = parseSSEData<{ type: string; [k: string]: unknown }>(line);
    if (obj) events.push(obj);
  }
  return events;
}
