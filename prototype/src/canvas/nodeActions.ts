// 节点级业务动作（发消息 / 分支 / 重新提炼）。
// 提到模块顶层是为了让 CanvasNode 组件主体只负责状态与 JSX，避免单组件 CCN 失控。
// 函数内部通过 useCanvasStore.getState() 直接访问 store，不接受 store 参数，
// 调用方仅传业务参数（nodeId / text 等）。

import { useCanvasStore } from '../store/canvasStore';
import { api } from '../api/client';
import type { Message, StreamEvent } from '../types';

const newMsgId = () => `m_${Math.random().toString(36).slice(2, 11)}`;

/**
 * SSE 事件 → store 的统一分发：避免 sendMessage / retryRefine 回调各自手写 switch。
 * 调用方仅需 `(evt) => applyStreamEvent(evt, asstMsgId)`。
 *
 * 命名辨析：同名函数 `runAssistantStream`（src/modules/_utils.ts）在后端做 buffer 累加
 * + 持久化；本函数仅做前端内存 store 更新，两者职责完全不同，不要混淆。
 */
export function applyStreamEvent(evt: StreamEvent, asstMsgId: string): void {
  const store = useCanvasStore.getState();
  switch (evt.type) {
    case 'reasoning': store.appendMessageContent(asstMsgId, '', evt.delta); break;
    case 'content': store.appendMessageContent(asstMsgId, evt.delta); break;
    case 'done': store.finalizeMessage(asstMsgId); break;
    case 'title': store.updateNode(evt.nodeId, { title: evt.title }); break;
    case 'error':
      // D021 配套：错误同时写入 message + DevTools console。
      // 仅 console.error 会让 UI 静默无反馈，用户看不到失败原因（如 context_overflow / 400）
      console.error('[stream]', evt.error);
      store.markMessageError(asstMsgId, evt.error);
      break;
  }
}

/**
 * 向节点发送一条用户消息并启动 AI 流式回复。
 *
 * M5 全局并发协议（决策 26 / 27）：
 * - 同节点 streaming 中再发：先调中断 API（§7.1 自动 abort 旧的）+ 用 force=true 启动新流
 * - 跨节点 streaming 中切换：弹确认 → 用户拒绝则放弃；用户同意则 force=true 中断旧的并启动
 * - 全局空闲：直接启动
 */
export async function performSendMessage(nodeId: string, text: string): Promise<void> {
  const store = useCanvasStore.getState();
  const busyNodeId = findStreamingNodeId(store);
  let force = false;
  if (busyNodeId) {
    if (busyNodeId === nodeId) {
      // §7.1 同节点连发：自动中断旧的，不询问用户。
      // abortStream 仅触发信号，generator 还未退出；紧接着带 force=true 发新消息，
      // server 端全局并发守卫会重新检测 isAnyStreaming()——若旧 controller 尚未被
      // unregister，force 路径会再次 abort 它（幂等），保证新流能启动。
      await api.abortStream(nodeId).catch(() => false);
      force = true;
    } else {
      // 跨节点切换：用户确认（决策 26）
      const ok = window.confirm('节点 A 正在流式回复中。继续将中断它，然后在当前节点开始新的回复，确认吗？');
      if (!ok) return;
      await api.abortStream(busyNodeId).catch(() => false);
      force = true;
    }
  }

  const ownMessages = Object.values(store.messages)
    .filter((m) => m.nodeId === nodeId)
    .sort((a, b) => a.sequence - b.sequence);
  const userSequence = (ownMessages[ownMessages.length - 1]?.sequence ?? -1) + 1;

  const userMsg: Message = {
    id: newMsgId(),
    nodeId,
    role: 'user',
    content: text,
    sequence: userSequence,
    status: 'complete',
    createdAt: new Date().toISOString(),
  };
  store.upsertMessage(userMsg);

  const asstMsgId = newMsgId();
  store.upsertMessage({
    id: asstMsgId,
    nodeId,
    role: 'assistant',
    content: '',
    reasoningContent: '',
    sequence: userSequence + 1,
    status: 'streaming',
    createdAt: new Date().toISOString(),
  });
  store.setStreaming(nodeId, 'streaming');
  store.bumpAgentStat('started');

  try {
    await api.streamMessage(nodeId, text, (evt) => {
      applyStreamEvent(evt, asstMsgId);
      if (evt.type === 'agent_final') {
        // bumpAgentStat 仅由 agent_final 触发（决策 29 / M5）：
        // 普通对话不走 agent loop，不会产生 agent_final，因此启动率/中断率仅统计真正的 agent 调用。
        // completed / aborted 均通过 agent_final.reason 区分——两条路径都需要 agent_final 才能记账。
        store.bumpAgentStat(evt.reason === 'completed' ? 'completed' : 'aborted', evt.reason);
      }
    }, { force });
    store.setStreaming(nodeId, 'idle');
  } catch (e) {
    console.error('sendMessage failed', e);
    store.setStreaming(nodeId, 'error');
  }
}

/**
 * 用户主动中断当前节点的 agent 流（M5 / R015 落地）。
 *
 * 不在此处调 setStreaming(idle)，原因：abort API 仅触发 AbortController.abort()，
 * generator 仍需若干 microtask 才能走到 finally 清 registry 并 yield agent_final + done；
 * 提前将 store 标记为 idle 会导致 UI 在"已中断但流还未正式收尾"的窗口期出现竞态——
 * 例如用户再次点击发送看到 isStreaming=false 并立即触发新的 send，而 server 端旧流
 * 还未 unregister，新 send 会命中 409 streaming_busy。
 * 正确做法：让 SSE done 事件驱动 applyStreamEvent → store.finalizeMessage + setStreaming(idle)。
 */
export async function performAbort(nodeId: string): Promise<void> {
  const ok = await api.abortStream(nodeId).catch(() => false);
  if (!ok) {
    // 节点已不在流式中（可能已自然完成），不必报错；store 状态由后续 SSE done 事件兜底
    return;
  }
}

// 全局并发 1 守卫：找出当前正在流式的节点（仅取第一个，正常情况只有一个）。
// 用 for-of Object.entries 提前 return 而非 .find()，原因是节点数量通常 < 30，
// 且 Object.entries 在 V8 里已足够快；若未来画布超 1000 节点需改为专用 streamingNodeId 字段。
function findStreamingNodeId(store: ReturnType<typeof useCanvasStore.getState>): string | null {
  for (const [nid, state] of Object.entries(store.streamingByNode)) {
    if (state === 'streaming') return nid;
  }
  return null;
}

/**
 * 跨节点跳转并定位到某条消息——分支双向标注的"一键回到来源"行为。
 *
 * 完整动作：(1) 若节点折叠则展开（store + 后端持久化）；(2) 设为活跃节点；
 * (3) pan 画布让节点中心进入视口中央；(4) 等两帧后手动滚动节点内消息容器到该消息。
 *
 * 两帧延迟的原因：折叠→展开会触发 React 重新挂载 ExpandedNodeView，
 * 第一帧只完成 commit 还没 layout，DOM 选择器拿到的是新挂载但尚未布局的元素，
 * 滚动计算会拿到错位的偏移。两层 rAF 确保 layout 完成后再滚动。
 *
 * 不用 Element.scrollIntoView：节点是 position:absolute 嵌在画布 transform 层里，
 * scrollIntoView 会让所有可滚动祖先（含 body / 画布根）都滚动以使元素可见，
 * 导致 body 被滚走、画布出现空白裂缝、minimap 视口框漂移。
 * 改为定位最近的 overflow:auto 祖先（节点的消息列表容器）只滚它一个。
 *
 * messageId 传 null 时跳过滚动（用于子节点无消息的早期场景）；找不到 DOM 锚点或可滚动祖先时静默 return。
 */
export function focusNodeOnMessage(targetNodeId: string, messageId: string | null): void {
  const store = useCanvasStore.getState();
  const node = store.nodes[targetNodeId];
  if (!node) return;

  if (node.collapsed) {
    store.updateNode(targetNodeId, { collapsed: false });
    api.updateNode(targetNodeId, { collapsed: false }).catch(() => {});
  }
  store.setActiveNode(targetNodeId);

  // 画布 pan 居中：复用 Minimap 的 centerOn 公式（vx = winW/2 - lx*zoom）
  // 取节点中心点（展开态宽 360，高度动态——用 positionY + 半个常见高度做近似中心）
  const zoom = store.canvas?.viewportZoom ?? 1;
  const lx = node.positionX + 180;
  const ly = node.positionY + 120;
  store.setViewport(window.innerWidth / 2 - lx * zoom, window.innerHeight / 2 - ly * zoom, zoom);

  if (messageId) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!el) return;
        const scrollContainer = findScrollableAncestor(el as HTMLElement);
        if (!scrollContainer) return;
        const elRect = el.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        scrollContainer.scrollTo({
          top: scrollContainer.scrollTop + elRect.top - containerRect.top,
          behavior: 'smooth',
        });
      });
    });
  }
}

// 找最近的可纵向滚动祖先（节点内消息容器是 overflowY:auto + maxHeight 480）。
// 不直接用 element.parentElement——节点 DOM 嵌套较深（bubble div → 消息列表 → 节点外框），
// 中间层未必是滚动容器；按 computedStyle 找最稳。同时校验 scrollHeight > clientHeight，
// 避免误把"声明 overflow:auto 但内容未溢出"的容器当作滚动祖先。
function findScrollableAncestor(start: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = start.parentElement;
  while (cur) {
    const overflowY = window.getComputedStyle(cur).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * 编辑用户消息后重新生成 AI 回复。
 *
 * 流程：截断式删除 sequence ≥ editedSequence 的所有消息（含被编辑消息本身），
 * 然后用新内容走标准 sendMessage 路径——sequence 因截断而自然接续，等价"重新发送"。
 *
 * 后端 truncate API 自带分支引用守卫（2c 硬阻断），UI 层在按钮 disabled 阶段已挡掉
 * 危险编辑；后端守卫是防竞态兜底（编辑期间另一会话可能创建了新分支）。
 */
export async function performEditMessage(
  nodeId: string,
  editedSequence: number,
  newContent: string,
): Promise<void> {
  const store = useCanvasStore.getState();
  try {
    await api.truncateMessages(nodeId, editedSequence);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (msg.includes('branch_referenced')) {
      alert('该消息已被分支引用，无法编辑（请先删除相关子分支）');
      return;
    }
    if (msg.includes('streaming')) {
      alert('节点正在流式回复中，请稍后再试');
      return;
    }
    console.error('truncateMessages failed', e);
    alert(`编辑失败：${msg}`);
    return;
  }
  store.removeMessagesFromSequence(nodeId, editedSequence);
  await performSendMessage(nodeId, newContent);
}

/** 从节点的某条 AI 消息分支出新对话节点。 */
export async function performBranch(parentNodeId: string, fromMessageId: string): Promise<void> {
  try {
    const { node, edge } = await api.branchNode({ parentNodeId, fromMessageId });
    const store = useCanvasStore.getState();
    store.upsertNode(node);
    store.upsertEdge(edge);
    store.setActiveNode(node.id);
  } catch (e) {
    console.error('branch failed', e);
  }
}

/**
 * 重新提炼（Q5 / D008）：复用当前提炼节点的源节点，生成一份新的提炼结果。
 * 后端 createRefine 总是产出新节点（不替换），用户可手动删旧节点保留对比。
 */
export async function performRetryRefine(refinedNodeId: string): Promise<void> {
  const allEdges = useCanvasStore.getState().edges;
  const sourceIds = Object.values(allEdges)
    .filter((e) => e.childNodeId === refinedNodeId && e.edgeKind === 'refine_input')
    .map((e) => e.parentNodeId);
  if (sourceIds.length === 0) {
    alert('找不到提炼来源节点，无法重新提炼');
    return;
  }
  try {
    const { node: refinedNode, edges, streamUrl } = await api.refine({
      sourceNodeIds: sourceIds,
      intentQuestion: null,
    });
    const store = useCanvasStore.getState();
    store.upsertNode(refinedNode);
    edges.forEach(store.upsertEdge);

    const msgId = newMsgId();
    store.upsertMessage({
      id: msgId,
      nodeId: refinedNode.id,
      role: 'assistant',
      content: '',
      reasoningContent: '',
      sequence: 0,
      status: 'streaming',
      createdAt: new Date().toISOString(),
    });
    store.setStreaming(refinedNode.id, 'streaming');
    store.setActiveNode(refinedNode.id);

    await api.streamRefine(streamUrl, (evt) => applyStreamEvent(evt, msgId));
    store.setStreaming(refinedNode.id, 'idle');
  } catch (e) {
    console.error('retry refine failed', e);
    alert(`重新提炼失败：${(e as Error).message ?? e}`);
  }
}
