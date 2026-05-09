import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Canvas, Node, Edge, Message, ReasoningDetail, StreamingState } from '../types';

// Undo 栈条目（仅 node.move / node.delete，新建节点不入栈——R005-undo）
// 仅内存，不持久化（partialize 白名单不含 undoStack），跨会话不保留——domain §1.7
export type UndoEntry =
  | { kind: 'node.move'; nodeId: string; prevX: number; prevY: number }
  | { kind: 'node.delete'; snapshot: { node: Node; messages: Message[]; edges: Edge[] } };

const UNDO_STACK_LIMIT = 50;

interface CanvasState {
  canvas: Canvas | null;
  nodes: Record<string, Node>;
  edges: Record<string, Edge>;
  messages: Record<string, Message>;
  // 运行时派生状态（不持久化的部分会被 partialize 排除）
  activeNodeId: string | null;
  selectedNodeIds: string[]; // 多选用于提炼
  selectedEdgeId: string | null; // 选中的边（用于删除/高亮）
  // 当前全屏（大屏 Modal）展示的节点 ID。同时只能有一个，与覆盖层 Modal 语义一致。
  // 不持久化：刷新后视为关闭，避免恢复到一个用户已经离开的全屏态。
  fullscreenNodeId: string | null;
  streamingByNode: Record<string, StreamingState>;
  // M5 / 决策 29：agent 启动率/中断率指标内存计数；DevTools 可见，不持久化、不上报
  agentStats: AgentStats;
  hydrated: boolean;
  // 用户是否在本端手动操作过视口（拖动/缩放/minimap 跳转）。
  // 启动时若为 false，App 会执行 fit-to-nodes 自动居中；为 true 则尊重 localStorage 已保存的视口。
  // 持久化在 localStorage 中，使"已用过的客户端"重启后保留上次视口；首次启动 / 清缓存 → 走自动居中。
  userHasMovedViewport: boolean;
  // 撤销栈（仅内存，深度 50，FIFO 淘汰）
  undoStack: UndoEntry[];
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
  // 把 store 中某条消息的 ID 替换为新 ID。用于 SSE user_persisted / done 事件到达后，
  // 把前端乐观 ID 替换成后端持久化 ID——否则后续 branch / edit 等按 ID 查后端的操作会 404。
  replaceMessageId: (oldId: string, newId: string) => void;
  // 删除指定节点中 sequence ≥ fromSequence 的所有消息（用户编辑触发的本地同步）
  removeMessagesFromSequence: (nodeId: string, fromSequence: number) => void;
  appendMessageContent: (msgId: string, contentDelta: string, reasoningDelta?: string) => void;
  // 直接替换消息 content 为给定全文。仅 writer Phase 2 完成时使用——
  // append 语义对流式渲染必要，但去AI味后端会推一份完整最终全文，需要 replace 而非拼接，
  // 否则会出现"初稿全文 + 最终版全文"的双倍内容。
  replaceMessageContent: (msgId: string, content: string) => void;
  // 把 OpenRouter / OpenAI 推理模型的 reasoning_details 数组片段累加到消息上，供持久化与多轮回灌使用。
  // UI 渲染走 reasoningContent 字符串，本字段不影响显示。
  appendMessageReasoningDetails: (msgId: string, detailsDelta: ReasoningDetail[]) => void;
  finalizeMessage: (msgId: string) => void;
  markMessageError: (msgId: string, errorText: string) => void;
  setActiveNode: (id: string | null) => void;
  toggleSelectNode: (id: string) => void;
  clearSelection: () => void;
  setSelectedEdge: (id: string | null) => void;
  setStreaming: (nodeId: string, state: StreamingState) => void;
  // 打开节点大屏 Modal。同时只能一个；打开新节点时旧节点自动被替换。
  openFullscreen: (nodeId: string) => void;
  // 关闭大屏 Modal；调用方可附带把节点折叠（按 R013 的 fullscreen→collapsed 状态机）。
  closeFullscreen: () => void;
  // setViewport：用户主动操作视口（拖动/缩放/minimap）调用此函数 → 同时把 userHasMovedViewport 置为 true，
  // 让下次启动尊重当前视口。系统计算的初始视口（fit-to-nodes 启动钩子）不应走此函数，应直接 set canvas，
  // 否则会污染"用户是否动过"的语义。
  setViewport: (x: number, y: number, zoom: number) => void;
  // 系统计算的初始视口（fit-to-nodes）：直接覆盖 canvas viewport，不改 userHasMovedViewport。
  // 与 setViewport 分离：用户手动 vs 系统设定的语义必须可区分，否则启动自动居中本身会被误判为"用户动过"。
  setSystemViewport: (x: number, y: number, zoom: number) => void;
  bumpAgentStat: (kind: 'started' | 'completed' | 'aborted', reason?: string) => void;
  // 入栈：达到深度时 FIFO 淘汰最早条目
  pushUndoEntry: (entry: UndoEntry) => void;
  // 弹栈：成功撤销后调用；失败时不应调用（保留条目让用户重试）
  popUndoEntry: () => void;
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
      fullscreenNodeId: null,
      streamingByNode: {},
      agentStats: { started: 0, completed: 0, aborted: 0, byReason: {} },
      hydrated: false,
      userHasMovedViewport: false,
      undoStack: [],

      // 启动时合并后端快照：节点/边/消息以后端为准；canvas viewport 在 userHasMovedViewport=true 时
      // 保留 store 现有值（来自 localStorage），否则用后端值——首次启动后再交给 App 的 fit-to-nodes 钩子覆盖。
      // 这样修复了"后端固定 0/0/1 永远覆盖前端拖到的位置"的双存储竞争。
      hydrate: (data) => {
        const nodes = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
        const edges = Object.fromEntries(data.edges.map((e) => [e.id, e]));
        const messages = Object.fromEntries(data.messages.map((m) => [m.id, m]));
        set((s) => {
          const localCanvas = s.canvas;
          const mergedCanvas = s.userHasMovedViewport && localCanvas
            ? {
                ...data.canvas,
                viewportX: localCanvas.viewportX,
                viewportY: localCanvas.viewportY,
                viewportZoom: localCanvas.viewportZoom,
              }
            : data.canvas;
          return { canvas: mergedCanvas, nodes, edges, messages, hydrated: true };
        });
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

      replaceMessageId: (oldId, newId) =>
        set((s) => {
          if (oldId === newId) return s;
          const existing = s.messages[oldId];
          if (!existing) return s;
          // 同时改 map key 与 message.id 字段；其它 store 字段（streamingByNode 按 nodeId、
          // edges.inheritedUntilSequence 按 sequence）均不引用 messageId，无需联动。
          const { [oldId]: _, ...rest } = s.messages;
          return { messages: { ...rest, [newId]: { ...existing, id: newId } } };
        }),

      removeMessagesFromSequence: (nodeId, fromSequence) =>
        set((s) => ({
          messages: Object.fromEntries(
            Object.entries(s.messages).filter(
              ([, m]) => !(m.nodeId === nodeId && m.sequence >= fromSequence),
            ),
          ),
        })),

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

      replaceMessageContent: (msgId, content) =>
        set((s) => {
          const existing = s.messages[msgId];
          if (!existing) return s;
          return {
            messages: { ...s.messages, [msgId]: { ...existing, content } },
          };
        }),

      appendMessageReasoningDetails: (msgId, detailsDelta) =>
        set((s) => {
          const existing = s.messages[msgId];
          if (!existing || detailsDelta.length === 0) return s;
          return {
            messages: {
              ...s.messages,
              [msgId]: {
                ...existing,
                reasoningDetails: [...(existing.reasoningDetails ?? []), ...detailsDelta],
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

      // 错误收尾：把错误说明写入 message.content 末尾（用 \n\n[错误] 前缀视觉区分），
      // status 置 'error'。与 finalizeMessage 互斥（流出错就走这条，不再 finalize）。
      // 让用户在节点 UI 内直接看到错误而非只在 DevTools console 看到（D021 配套）
      markMessageError: (msgId, errorText) =>
        set((s) => {
          const existing = s.messages[msgId];
          if (!existing) return s;
          const prefix = existing.content ? `${existing.content}\n\n` : '';
          return {
            messages: {
              ...s.messages,
              [msgId]: {
                ...existing,
                content: `${prefix}[错误] ${errorText}`,
                status: 'error',
              },
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

      // 打开大屏 Modal：同时把被打开的节点设为 active，让"焦点对比"等
      // 既有 UI 状态保持一致；不主动改 collapsed（关闭时再统一折叠）。
      openFullscreen: (nodeId) =>
        set(() => ({
          fullscreenNodeId: nodeId,
          activeNodeId: nodeId,
          selectedNodeIds: [],
          selectedEdgeId: null,
        })),

      // 关闭大屏 Modal：仅清空 fullscreenNodeId。
      // 节点折叠（collapsed=true）由进入 fullscreen 时的 openFullscreen 调用方（ExpandedNodeView）
      // 在调用 openFullscreen 前预先完成，关闭时无需再操作节点状态。
      closeFullscreen: () => set({ fullscreenNodeId: null }),

      setViewport: (x, y, zoom) =>
        set((s) => ({
          canvas: s.canvas ? { ...s.canvas, viewportX: x, viewportY: y, viewportZoom: zoom } : s.canvas,
          // 用户主动操作 → 标记本端视口已被用过，下次启动跳过 fit-to-nodes
          userHasMovedViewport: true,
        })),

      setSystemViewport: (x, y, zoom) =>
        set((s) => ({
          canvas: s.canvas ? { ...s.canvas, viewportX: x, viewportY: y, viewportZoom: zoom } : s.canvas,
          // 不改 userHasMovedViewport：fit-to-nodes 居中是系统行为，不应阻断后续拖动写入
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

      pushUndoEntry: (entry) =>
        set((s) => {
          const next = [...s.undoStack, entry];
          // FIFO 淘汰：超出深度时砍掉最旧条目（数组头部），保留最近 UNDO_STACK_LIMIT 条
          if (next.length > UNDO_STACK_LIMIT) next.splice(0, next.length - UNDO_STACK_LIMIT);
          return { undoStack: next };
        }),

      popUndoEntry: () =>
        set((s) => ({ undoStack: s.undoStack.slice(0, -1) })),
    }),
    {
      name: 'power-chat-canvas',
      // version 1：在 0→1 升级时，对没有 userHasMovedViewport 字段的旧 localStorage 数据做迁移——
      // 若 canvas viewport 不是初始 0/0/1，说明该用户曾拖动过视口（旧版本无标志位但实际动过），
      // 推断为已操作；否则保持 false。避免老用户升级后首次启动被 fit-to-nodes 误覆盖到旧视口。
      version: 1,
      migrate: (persisted: any, version: number) => {
        if (version === 0 && persisted && persisted.userHasMovedViewport === undefined) {
          const c = persisted.canvas;
          // 旧版本没有 userHasMovedViewport 字段。推断逻辑：
          // 后端 canvas 初始化时 viewport 固定为 (0, 0, 1)；若 localStorage 里的值偏离了初始值，
          // 说明该用户曾经拖动/缩放过（旧版本把视口写到 canvas 里），应视为"已动过"。
          // 用 `!== 0/0/1` 作为启发式推断，宁可误判为"动过"（保留旧视口）也不覆盖老用户的视口位置。
          const movedByDefault = c
            ? c.viewportX !== 0 || c.viewportY !== 0 || c.viewportZoom !== 1
            : false;
          return { ...persisted, userHasMovedViewport: movedByDefault };
        }
        return persisted;
      },
      // 只持久化数据层 + 视口"用过"标志位；不持久化运行时状态（active/selected/streaming/hydrated）
      partialize: (s) => ({
        canvas: s.canvas,
        nodes: s.nodes,
        edges: s.edges,
        messages: s.messages,
        userHasMovedViewport: s.userHasMovedViewport,
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

/**
 * 选择器：子节点视角——取本节点 branch 入边对应的"分支源"信息。
 * 用于在子节点头部展示"↳ 分支自《父标题》第 N 条..."。
 * 数据回溯链：edge.parentNodeId → parentNode；edge.inheritedUntilSequence → sourceMessage（同 sequence）。
 * 边、节点、消息任一缺失（异常状态）返回 null。
 */
export function selectBranchSourceOfNode(
  state: CanvasState,
  nodeId: string,
): { parentNode: Node; sourceMessage: Message } | null {
  const branchEdge = Object.values(state.edges).find(
    (e) => e.childNodeId === nodeId && e.edgeKind === 'branch',
  );
  if (!branchEdge || branchEdge.inheritedUntilSequence === null) return null;
  const parentNode = state.nodes[branchEdge.parentNodeId];
  if (!parentNode) return null;
  const sourceMessage = Object.values(state.messages).find(
    (m) => m.nodeId === branchEdge.parentNodeId && m.sequence === branchEdge.inheritedUntilSequence,
  );
  if (!sourceMessage) return null;
  return { parentNode, sourceMessage };
}

/**
 * 选择器：判断某节点的某条消息（按 sequence）是否被任一子分支引用。
 * 编辑用户消息时用——若返回 true，编辑会破坏子分支继承上下文，按钮应禁用（2c 硬阻断）。
 * 引用判定：存在某出边 branch 的 inheritedUntilSequence ≥ sequence
 *（编辑该 sequence 意味着要删除 sequence 及之后的所有消息，等价于"截断范围 fromSequence=sequence"）。
 */
export function selectIsMessageReferencedByBranch(
  state: CanvasState,
  nodeId: string,
  sequence: number,
): boolean {
  return Object.values(state.edges).some(
    (e) =>
      e.parentNodeId === nodeId &&
      e.edgeKind === 'branch' &&
      e.inheritedUntilSequence !== null &&
      e.inheritedUntilSequence >= sequence,
  );
}

/**
 * 选择器：父节点视角——取从本节点某条消息派生的所有子分支。
 * 用于在父节点助手消息气泡上展示 "⑂ N" 徽章及子节点跳转列表。
 * 仅返回 edge 与 child node 都存在的项；按 edge.createdAt 升序保持点击体验稳定。
 */
export function selectBranchesFromMessage(
  state: CanvasState,
  parentNodeId: string,
  sequence: number,
): Array<{ edge: Edge; childNode: Node }> {
  return Object.values(state.edges)
    .filter(
      (e) =>
        e.parentNodeId === parentNodeId &&
        e.edgeKind === 'branch' &&
        e.inheritedUntilSequence === sequence,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((edge) => ({ edge, childNode: state.nodes[edge.childNodeId] }))
    .filter((x): x is { edge: Edge; childNode: Node } => !!x.childNode);
}
