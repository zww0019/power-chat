import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Canvas, Node, Edge, Message, StreamingState } from '../types';

interface CanvasState {
  canvas: Canvas | null;
  nodes: Record<string, Node>;
  edges: Record<string, Edge>;
  messages: Record<string, Message>;
  // 运行时派生状态（不持久化的部分会被 partialize 排除）
  activeNodeId: string | null;
  selectedNodeIds: string[]; // 多选用于提炼
  selectedEdgeId: string | null; // 选中的边（用于删除/高亮）
  streamingByNode: Record<string, StreamingState>;
  // M5 / 决策 29：agent 启动率/中断率指标内存计数；DevTools 可见，不持久化、不上报
  agentStats: AgentStats;
  hydrated: boolean;
}

interface AgentStats {
  started: number;
  completed: number;
  aborted: number;
  // 按 AgentFinalReason 聚合的细分计数
  byReason: Record<string, number>;
}

interface CanvasActions {
  hydrate: (data: { canvas: Canvas; nodes: Node[]; edges: Edge[]; messages: Message[] }) => void;
  upsertNode: (node: Node) => void;
  updateNode: (id: string, patch: Partial<Node>) => void;
  removeNode: (id: string) => void;
  removeNodeAndEdges: (id: string) => void;
  upsertEdge: (edge: Edge) => void;
  removeEdge: (id: string) => void;
  removeEdgesTouching: (nodeId: string) => void;
  upsertMessage: (msg: Message) => void;
  appendMessageContent: (msgId: string, contentDelta: string, reasoningDelta?: string) => void;
  finalizeMessage: (msgId: string) => void;
  setActiveNode: (id: string | null) => void;
  toggleSelectNode: (id: string) => void;
  clearSelection: () => void;
  setSelectedEdge: (id: string | null) => void;
  setStreaming: (nodeId: string, state: StreamingState) => void;
  setViewport: (x: number, y: number, zoom: number) => void;
  bumpAgentStat: (kind: 'started' | 'completed' | 'aborted', reason?: string) => void;
}

type Store = CanvasState & CanvasActions;

export const useCanvasStore = create<Store>()(
  persist(
    (set, get) => ({
      canvas: null,
      nodes: {},
      edges: {},
      messages: {},
      activeNodeId: null,
      selectedNodeIds: [],
      selectedEdgeId: null,
      streamingByNode: {},
      agentStats: { started: 0, completed: 0, aborted: 0, byReason: {} },
      hydrated: false,

      hydrate: (data) => {
        const nodes = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
        const edges = Object.fromEntries(data.edges.map((e) => [e.id, e]));
        const messages = Object.fromEntries(data.messages.map((m) => [m.id, m]));
        set({ canvas: data.canvas, nodes, edges, messages, hydrated: true });
      },

      upsertNode: (node) =>
        set((s) => ({ nodes: { ...s.nodes, [node.id]: node } })),

      updateNode: (id, patch) =>
        set((s) => {
          const existing = s.nodes[id];
          if (!existing) return s;
          return { nodes: { ...s.nodes, [id]: { ...existing, ...patch } } };
        }),

      removeNode: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.nodes;
          // 同时清理该节点的所有消息
          const messages = Object.fromEntries(
            Object.entries(s.messages).filter(([, m]) => m.nodeId !== id),
          );
          return {
            nodes: rest,
            messages,
            activeNodeId: s.activeNodeId === id ? null : s.activeNodeId,
            selectedNodeIds: s.selectedNodeIds.filter((x) => x !== id),
          };
        }),

      // 与后端 deleteNode 的级联语义对齐：节点删除后同步删除触及该节点的所有边
      // （后端已做事务级联，前端这里只负责 store 一致性）
      removeNodeAndEdges: (id) =>
        set((s) => {
          const { [id]: _removedNode, ...remainingNodes } = s.nodes;
          const remainingEdges = Object.fromEntries(
            Object.entries(s.edges).filter(
              ([, e]) => e.parentNodeId !== id && e.childNodeId !== id,
            ),
          );
          const remainingMessages = Object.fromEntries(
            Object.entries(s.messages).filter(([, m]) => m.nodeId !== id),
          );
          return {
            nodes: remainingNodes,
            edges: remainingEdges,
            messages: remainingMessages,
            activeNodeId: s.activeNodeId === id ? null : s.activeNodeId,
            selectedNodeIds: s.selectedNodeIds.filter((x) => x !== id),
            // 该节点关联的边若被选中，一并清空
            selectedEdgeId:
              s.selectedEdgeId && s.edges[s.selectedEdgeId] &&
              (s.edges[s.selectedEdgeId]!.parentNodeId === id ||
                s.edges[s.selectedEdgeId]!.childNodeId === id)
                ? null
                : s.selectedEdgeId,
          };
        }),

      upsertEdge: (edge) =>
        set((s) => ({ edges: { ...s.edges, [edge.id]: edge } })),

      removeEdge: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.edges;
          return {
            edges: rest,
            selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
          };
        }),

      removeEdgesTouching: (nodeId) =>
        set((s) => {
          const remaining = Object.fromEntries(
            Object.entries(s.edges).filter(
              ([, e]) => e.parentNodeId !== nodeId && e.childNodeId !== nodeId,
            ),
          );
          return { edges: remaining };
        }),

      upsertMessage: (msg) =>
        set((s) => ({ messages: { ...s.messages, [msg.id]: msg } })),

      appendMessageContent: (msgId, contentDelta, reasoningDelta) =>
        set((s) => {
          const existing = s.messages[msgId];
          if (!existing) return s;
          return {
            messages: {
              ...s.messages,
              [msgId]: {
                ...existing,
                content: existing.content + contentDelta,
                reasoningContent: reasoningDelta
                  ? (existing.reasoningContent ?? '') + reasoningDelta
                  : existing.reasoningContent,
              },
            },
          };
        }),

      finalizeMessage: (msgId) =>
        set((s) => {
          const existing = s.messages[msgId];
          if (!existing) return s;
          return {
            messages: {
              ...s.messages,
              [msgId]: { ...existing, status: 'complete' },
            },
          };
        }),

      setActiveNode: (id) =>
        set(() => ({
          activeNodeId: id,
          // 活跃节点与多选/边选中在语义上互斥：
          // 若保留多选，Delete 键会产生"删节点还是删边"的歧义
          selectedNodeIds: [],
          selectedEdgeId: null,
        })),

      toggleSelectNode: (id) =>
        set((s) => {
          const exists = s.selectedNodeIds.includes(id);
          return {
            selectedNodeIds: exists
              ? s.selectedNodeIds.filter((x) => x !== id)
              : [...s.selectedNodeIds, id],
            selectedEdgeId: null,
          };
        }),

      clearSelection: () => set({ selectedNodeIds: [], selectedEdgeId: null }),

      setSelectedEdge: (id) =>
        set(() => ({
          selectedEdgeId: id,
          // 选中边时清空节点选择，避免删除键歧义
          activeNodeId: null,
          selectedNodeIds: [],
        })),

      setStreaming: (nodeId, state) =>
        set((s) => ({
          streamingByNode: { ...s.streamingByNode, [nodeId]: state },
        })),

      setViewport: (x, y, zoom) =>
        set((s) => ({
          canvas: s.canvas ? { ...s.canvas, viewportX: x, viewportY: y, viewportZoom: zoom } : s.canvas,
        })),

      bumpAgentStat: (kind, reason) =>
        set((s) => ({
          agentStats: {
            ...s.agentStats,
            [kind]: s.agentStats[kind] + 1,
            byReason: reason
              ? { ...s.agentStats.byReason, [reason]: (s.agentStats.byReason[reason] ?? 0) + 1 }
              : s.agentStats.byReason,
          },
        })),
    }),
    {
      name: 'power-chat-canvas',
      // 只持久化数据层，不持久化运行时状态（active/selected/streaming/hydrated）
      partialize: (s) => ({
        canvas: s.canvas,
        nodes: s.nodes,
        edges: s.edges,
        messages: s.messages,
      }),
    },
  ),
);

/** 选择器：取节点的所有消息，按 sequence 升序排列 */
export function selectMessagesOfNode(state: CanvasState, nodeId: string): Message[] {
  return Object.values(state.messages)
    .filter((m) => m.nodeId === nodeId)
    .sort((a, b) => a.sequence - b.sequence);
}

/** 选择器：取节点的所有入边（childNodeId === nodeId）和出边（parentNodeId === nodeId） */
export function selectEdgesOfNode(state: CanvasState, nodeId: string): { inbound: Edge[]; outbound: Edge[] } {
  const all = Object.values(state.edges);
  return {
    inbound: all.filter((e) => e.childNodeId === nodeId),
    outbound: all.filter((e) => e.parentNodeId === nodeId),
  };
}
