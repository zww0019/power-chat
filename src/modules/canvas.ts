// canvas-module
// 画布元数据 + 节点 CRUD + 边的隐式管理 + 删除级联（INV-5）。
// 注意：本模块对 LLM 完全无知（PRD §1.5）。
// 边的创建只能通过 conversation/refine 模块的 createEdge 内部 API（不暴露）。

import type { Canvas, Node, Edge, Message, NodeType, EdgeKind } from '../types.js';
import { StreamingNodeError } from '../types.js';
import { getPersistence } from './persistence.js';

const SINGLE_CANVAS_ID = 'canvas_main';

// 运行时状态：哪些节点正在流式输出（INV-7 守卫）。
// 用内存 Set 而非持久化，因为进程重启后所有流必然已中断，不需要恢复。
const streamingNodes = new Set<string>();

/** 标记节点进入流式状态；由 conversation 模块在开始 stream 时调用 */
export function markStreaming(nodeId: string): void {
  streamingNodes.add(nodeId);
}
/** 标记节点退出流式状态；由 conversation 模块在 stream 结束或出错时调用 */
export function unmarkStreaming(nodeId: string): void {
  streamingNodes.delete(nodeId);
}
/** 查询节点是否正在流式输出；deleteNode 在删除前用此守卫（INV-7） */
export function isStreaming(nodeId: string): boolean {
  return streamingNodes.has(nodeId);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
const nowIso = () => new Date().toISOString();

export async function getOrCreateCanvas(): Promise<Canvas> {
  const p = getPersistence();
  let canvas = await p.get<Canvas>('canvases', SINGLE_CANVAS_ID);
  if (!canvas) {
    canvas = {
      id: SINGLE_CANVAS_ID,
      viewportX: 0,
      viewportY: 0,
      viewportZoom: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await p.put('canvases', SINGLE_CANVAS_ID, canvas);
  }
  return canvas;
}

export async function getCanvasSnapshot(): Promise<{
  canvas: Canvas;
  nodes: Node[];
  edges: Edge[];
  messages: Message[];
}> {
  const p = getPersistence();
  const canvas = await getOrCreateCanvas();
  const [nodes, edges, messages] = await Promise.all([
    p.list<Node>('nodes'),
    p.list<Edge>('edges'),
    p.list<Message>('messages'),
  ]);
  return { canvas, nodes, edges, messages };
}

export async function createNode(params: {
  positionX: number;
  positionY: number;
  type?: NodeType;
}): Promise<Node> {
  await getOrCreateCanvas();
  const node: Node = {
    id: newId('n'),
    canvasId: SINGLE_CANVAS_ID,
    type: params.type ?? 'dialogue',
    positionX: params.positionX,
    positionY: params.positionY,
    width: 380,
    collapsed: false,
    title: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastFocusedAt: nowIso(),
  };
  await getPersistence().put('nodes', node.id, node);
  return node;
}

export async function getNode(id: string): Promise<Node | null> {
  return getPersistence().get<Node>('nodes', id);
}

export async function patchNode(
  id: string,
  patch: Partial<Pick<Node, 'positionX' | 'positionY' | 'collapsed' | 'title'>>,
): Promise<Node | null> {
  const p = getPersistence();
  const node = await p.get<Node>('nodes', id);
  if (!node) return null;

  // 标题长度校验
  if (patch.title !== undefined && patch.title !== null && patch.title.length > 30) {
    throw new Error('title too long (max 30 chars)');
  }

  const updated: Node = { ...node, ...patch, updatedAt: nowIso() };
  await p.put('nodes', id, updated);
  return updated;
}

// 删除节点：级联删除该节点的所有 messages 和它的所有 edges（INV-5, Q2-3=B）
// 不删除子孙节点。返回是否实际删了。
export async function deleteNode(id: string): Promise<boolean> {
  if (isStreaming(id)) {
    throw new StreamingNodeError(id);
  }
  const p = getPersistence();
  const node = await p.get<Node>('nodes', id);
  if (!node) return false;

  await p.transaction(async () => {
    // 删该节点
    await p.delete('nodes', id);
    // 删所有该节点的 messages
    const messages = await p.list<Message>('messages', (m) => m.nodeId === id);
    for (const m of messages) {
      await p.delete('messages', m.id);
    }
    // 删所有触及该节点的边
    const edges = await p.list<Edge>('edges', (e) => e.parentNodeId === id || e.childNodeId === id);
    for (const e of edges) {
      await p.delete('edges', e.id);
    }
  });
  return true;
}

// 删除单条边。无副作用——边删除不级联节点或消息。
// 边不存在时返回 false（→ 路由层映射为 404）。
export async function deleteEdge(id: string): Promise<boolean> {
  const p = getPersistence();
  const edge = await p.get<Edge>('edges', id);
  if (!edge) return false;
  await p.delete('edges', id);
  return true;
}

// 内部 API：创建边（仅供 conversation/refine 模块调用，不暴露 HTTP）
export async function createEdge(params: {
  parentNodeId: string;
  childNodeId: string;
  edgeKind: EdgeKind;
  inheritedUntilSequence: number | null;
}): Promise<Edge> {
  const edge: Edge = {
    id: newId('e'),
    parentNodeId: params.parentNodeId,
    childNodeId: params.childNodeId,
    edgeKind: params.edgeKind,
    inheritedUntilSequence: params.inheritedUntilSequence,
    createdAt: nowIso(),
  };
  await getPersistence().put('edges', edge.id, edge);
  return edge;
}

export async function getEdgesOfChild(childNodeId: string): Promise<Edge[]> {
  return getPersistence().list<Edge>('edges', (e) => e.childNodeId === childNodeId);
}

export async function getEdgesOfParent(parentNodeId: string): Promise<Edge[]> {
  return getPersistence().list<Edge>('edges', (e) => e.parentNodeId === parentNodeId);
}
