// 节点级业务动作（发消息 / 分支 / 重新提炼）。
// 提到模块顶层是为了让 CanvasNode 组件主体只负责状态与 JSX，避免单组件 CCN 失控。
// 函数内部通过 useCanvasStore.getState() 直接访问 store，不接受 store 参数，
// 调用方仅传业务参数（nodeId / text 等）。

import { useCanvasStore } from '../store/canvasStore';
import { api } from '../api/client';
import { toast } from '../store/toastStore';
import type { Edge, Message, Node, StreamEvent } from '../types';

const newMsgId = () => `m_${Math.random().toString(36).slice(2, 11)}`;

/**
 * SSE 事件 → store 的统一分发：避免 performSendMessage / performRetryRefine 回调各自手写 switch。
 *
 * 注意：user_persisted 和 done 两个事件需要同步更新调用方的闭包 ID 变量，不能被这层函数
 * 完全封装——performSendMessage 在外层拦截这两个事件后再调用本函数（或直接处理）；
 * performRetryRefine 无乐观 ID 场景，可直接 `(evt) => applyStreamEvent(evt, msgId)` 使用。
 *
 * 命名辨析：同名函数 `runAssistantStream`（src/modules/_utils.ts）在后端做 buffer 累加
 * + 持久化；本函数仅做前端内存 store 更新，两者职责完全不同，不要混淆。
 */
export function applyStreamEvent(evt: StreamEvent, asstMsgId: string): void {
  const store = useCanvasStore.getState();
  switch (evt.type) {
    case 'reasoning': store.appendMessageContent(asstMsgId, '', evt.delta); break;
    case 'reasoning_details': store.appendMessageReasoningDetails(asstMsgId, evt.delta); break;
    case 'content': store.appendMessageContent(asstMsgId, evt.delta); break;
    case 'done':
      // 先把乐观 ID 替换为后端真实 ID，再 finalize——否则用户立即对该消息发起 branch
      // 时，前端传给后端的 ID 是乐观 ID，后端查不到 → 400 not_found。
      store.replaceMessageId(asstMsgId, evt.messageId);
      store.finalizeMessage(evt.messageId);
      break;
    case 'title':
      // D006 双轨制 · 自动轨成功：每 3 轮触发一次后端 onComplete → SSE title 事件。
      // 静默更新内存 store 即可，不弹 toast 避免对话流中频繁打扰用户。
      store.updateNode(evt.nodeId, { title: evt.title });
      break;
    case 'title_error':
      // 自动轨失败：toast 提示用户检查配置。
      // prefix 用"自动生成标题失败"而非"标题生成失败"，让用户能区分是后台自动触发的失败
      // 还是主动点击按钮触发的失败（两条路径的 prefix 故意不同，非漏改）。
      // error code 由后端 classifyTitleError 归类成与 HTTP 路径相同的简化 code。
      console.error('[auto-title]', evt.error);
      toast.error(titleErrorMessage(evt.error, '自动生成标题失败'));
      break;
    case 'error':
      // D021 配套：错误同时写入 message + DevTools console。
      // 仅 console.error 会让 UI 静默无反馈，用户看不到失败原因（如 context_overflow / 400）
      console.error('[stream]', evt.error);
      store.markMessageError(asstMsgId, evt.error);
      break;
  }
}

// 把 error code 映射成中文 toast 文案。自动轨（title_error 事件）和主动轨（performRegenerateTitle 的 catch）
// 共用同一组 code 语义，统一维护避免两条路径各自定义后出现语义漂移（D006 双轨制设计意图）。
// prefix：调用方传入的路径描述，如"自动生成标题失败"或"标题生成失败"，
//         让用户在 toast 中看到是哪条路径触发的失败，而非统一的笼统文案。
function titleErrorMessage(code: string, prefix: string): string {
  if (code === 'empty_node') return `${prefix}：节点尚无对话消息`;
  if (code === 'not_configured') return `${prefix}：LLM 未配置，请先在设置中填写 baseURL / model / apiKey`;
  if (code === 'not_found') return `${prefix}：节点不存在或已被删除`;
  if (code === 'llm_failed') return `${prefix}：快模型不可达或返回为空，请检查设置`;
  return `${prefix}：${code}`;
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

  // user / asst 占位消息 ID 用 let：SSE user_persisted / done 事件到达后会被替换为
  // 后端真实 ID，闭包持有的 *MsgId 也需同步更新，以便后续 case（如再来一帧 reasoning）
  // 能命中替换后的 store key。
  let userMsgId = newMsgId();
  const userMsg: Message = {
    id: userMsgId,
    nodeId,
    role: 'user',
    content: text,
    sequence: userSequence,
    status: 'complete',
    createdAt: new Date().toISOString(),
  };
  store.upsertMessage(userMsg);

  let asstMsgId = newMsgId();
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
      // user_persisted / done 的 ID 替换需在 applyStreamEvent 之前/内部执行，
      // 以保证 done 之后立即触发的 branch / edit 能用到真实 ID。
      // user_persisted 不进 applyStreamEvent（后者不持有 userMsgId），就地处理。
      if (evt.type === 'user_persisted') {
        store.replaceMessageId(userMsgId, evt.messageId);
        userMsgId = evt.messageId;
        return;
      }
      if (evt.type === 'done') {
        // applyStreamEvent 内部会做 ID 替换 + finalize；这里同步更新闭包变量，
        // 防止之后任何按 asstMsgId 的引用落到已废弃的 oldId 上。
        applyStreamEvent(evt, asstMsgId);
        asstMsgId = evt.messageId;
        return;
      }
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

/**
 * 用户主动触发"标题重新生成"（点击节点标题旁的刷新图标，D006 双轨制 · 主动轨）。
 *
 * 永远强制重新生成（不判断 node.title 是否已有值），失败时 toast 提示原因，
 * 保留旧标题不变。与自动轨（title_error 事件 → applyStreamEvent）共用同一组
 * error code 语义：api.regenerateNodeTitle 抛出的 Error.message 形如
 * "[502] llm_failed: ..."，按 includes 提取 code 后走 titleErrorMessage 映射。
 */
export async function performRegenerateTitle(nodeId: string): Promise<void> {
  const store = useCanvasStore.getState();
  if (!store.nodes[nodeId]) {
    toast.error('节点不存在，无法生成标题');
    return;
  }
  try {
    const { title } = await api.regenerateNodeTitle(nodeId);
    store.updateNode(nodeId, { title });
    toast.success(`已生成新标题：${title}`);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const code = extractTitleErrorCode(msg);
    if (code === 'unknown') {
      console.error('regenerateNodeTitle failed', e);
      toast.error(`标题生成失败：${msg}`);
      return;
    }
    toast.error(titleErrorMessage(code, '标题生成失败'));
  }
}

// 从 HTTP 错误响应文本（"[502] llm_failed: ..."）中提取错误码。
// 与后端 conversation.classifyTitleError 的输出 code 严格对齐（同一组 code 字符串）。
// 命名差异说明：后端函数接受 exception 对象做类型分派（classify），
// 本函数接受字符串用 includes 做子串匹配（extract），职责不同，名字各自准确。
function extractTitleErrorCode(msg: string): string {
  if (msg.includes('empty_node')) return 'empty_node';
  if (msg.includes('not_configured')) return 'not_configured';
  if (msg.includes('not_found')) return 'not_found';
  if (msg.includes('llm_failed') || msg.includes('502')) return 'llm_failed';
  return 'unknown';
}

/**
 * 从节点的某条 AI 消息分支出新对话节点。
 *
 * 一键直达大屏对话框（用户原诉求："不想被打断对话情境"）：
 * 创建成功后直接把新节点装入大屏 Modal，无论分支动作来自 fullscreen 还是 inline 入口，
 * 落点都统一为新节点的大屏对话框——用户视觉上是"在大窗口里基于一句话开了个新对话"，
 * 输入框由 NodeChatPanel 的 fullscreen 聚焦逻辑自动获焦，可以立即打字。
 *
 * 动作清单：
 * 1) upsertNode/upsertEdge：写入 store。collapsed 字段沿用后端默认值，
 *    新节点直接进 Modal，画布上是否折叠不影响 Modal 内容渲染。
 * 2) openFullscreen：单例字段直接覆盖父节点 fullscreenNodeId，
 *    用户从 fullscreen 入口分支时是"对话内容切换"，不是关再开；
 *    openFullscreen 同时写 activeNodeId，无需再单独调 setActiveNode。
 * 3) 视口平移：让用户 ESC 关闭 Modal 后回到画布时，新节点已在视野中央。
 *    公式与 focusNodeOnMessage 一致（节点中心 = positionX+180, positionY+120）。
 *
 * 错误处理：抛错给调用方（AssistantBubble 的 handleBranchClick 会 try/finally 清 loading）。
 * 不在此处吞错——否则 UI 永远看不到失败原因。
 */
export async function performBranch(parentNodeId: string, fromMessageId: string): Promise<void> {
  const store = useCanvasStore.getState();
  const parent = store.nodes[parentNodeId];
  const positionOverride = parent ? computeBranchPlacement(parent, store) : null;
  const { node, edge } = await api.branchNode({ parentNodeId, fromMessageId, positionOverride });
  store.upsertNode(node);
  store.upsertEdge(edge);
  store.openFullscreen(node.id);
  const zoom = store.canvas?.viewportZoom ?? 1;
  const nodeCenterX = node.positionX + 180;
  const nodeCenterY = node.positionY + 120;
  store.setViewport(window.innerWidth / 2 - nodeCenterX * zoom, window.innerHeight / 2 - nodeCenterY * zoom, zoom);
}

/**
 * 计算新分支节点的逻辑坐标，避免漂移到屏外。
 *
 * 决策树：
 * - 父节点在视口可见范围内 → 沿用 parent.X+440 / Y+sibling*80（保持视觉层级关系）
 * - 父节点在视口外 → 落到当前视口中心稍偏右下，让用户立即看到新分支
 *
 * 返回 null 表示让后端走默认偏移；实际上分支永远落到 store.nodes 里有 fallback 兜底。
 */
function computeBranchPlacement(
  parent: Node,
  store: ReturnType<typeof useCanvasStore.getState>,
): { x: number; y: number } {
  const vx = store.canvas?.viewportX ?? 0;
  const vy = store.canvas?.viewportY ?? 0;
  const zoom = store.canvas?.viewportZoom ?? 1;
  // 视口可见范围（逻辑坐标系）：屏幕 (0,0)→(W,H) 对应逻辑 (-vx/zoom, -vy/zoom)→(...+W/zoom, ...+H/zoom)
  const viewLeft = -vx / zoom;
  const viewTop = -vy / zoom;
  const viewRight = viewLeft + window.innerWidth / zoom;
  const viewBottom = viewTop + window.innerHeight / zoom;
  // 以父节点几何中心（positionX+180, positionY+120）作为"可见"判定锚点。
  // 用中心而非节点四角：只要节点中心在视口里，用户就能看到节点主体，
  // 此时沿用相对偏移（+440/+sibling*80）的视觉关系仍然成立；
  // 若中心已出视口，说明节点整体大概率不可见，改为落到视口中央更合理。
  const parentCenterX = parent.positionX + 180;
  const parentCenterY = parent.positionY + 120;
  const parentVisible =
    parentCenterX >= viewLeft && parentCenterX <= viewRight && parentCenterY >= viewTop && parentCenterY <= viewBottom;

  const siblingCount = Object.values(store.edges).filter(
    (e) => e.parentNodeId === parent.id && e.edgeKind === 'branch',
  ).length;

  if (parentVisible) {
    // 与后端 fallback 完全一致：父右侧 +440，纵向按兄弟数错开 80
    return { x: parent.positionX + 440, y: parent.positionY + siblingCount * 80 };
  }
  // 父节点不可见：落到视口中心偏右下，避开视口正中央可能存在的其它节点
  const centerX = (viewLeft + viewRight) / 2;
  const centerY = (viewTop + viewBottom) / 2;
  // 节点尺寸 360x240：以中心为锚减去一半得到左上角，再追加偏移让兄弟错开
  return { x: centerX - 180 + siblingCount * 40, y: centerY - 120 + siblingCount * 40 };
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
  // 在 try 外声明，让 catch 分支也能在网络异常时翻回卡死状态
  let createdNodeId: string | null = null;
  let createdMsgId: string | null = null;
  try {
    const { node: refinedNode, edges, streamUrl } = await api.refine({
      sourceNodeIds: sourceIds,
      intentQuestion: null,
    });
    const store = useCanvasStore.getState();
    store.upsertNode(refinedNode);
    edges.forEach(store.upsertEdge);

    const msgId = newMsgId();
    createdNodeId = refinedNode.id;
    createdMsgId = msgId;
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
    // 网络异常 / fetch 抛错路径：SSE 流没起来，applyStreamEvent 不会被触发，
    // 必须显式翻回 streaming 并把消息标 error，避免节点永久卡在"提炼中"。
    const store = useCanvasStore.getState();
    if (createdNodeId) store.setStreaming(createdNodeId, 'idle');
    if (createdMsgId) store.markMessageError(createdMsgId, (e as Error).message ?? String(e));
    alert(`重新提炼失败：${(e as Error).message ?? e}`);
  }
}

/**
 * 在提炼节点上"继续追问"：孵化一个常规对话子节点，挂一条 branch 边继承提炼输出。
 *
 * 复用 conversation.branchNode 后端接口，语义一致：
 * - 父=提炼节点，子=新建 dialogue 节点
 * - inheritedUntilSequence = 提炼节点 assistant 消息（提炼输出那条）的 sequence
 * - assembleContextWithLimit 回溯到 refined 父时走 INV-2 守卫，只取该节点自身 messages
 *   → 子节点上下文 = 仅提炼输出 + 子节点新对话，与"提炼即减熵起点"语义一致
 *
 * UI 行为与"分支自助手消息"对齐（commit f1def36 一键直达大屏）：upsertNode/Edge → openFullscreen → pan 视口。
 */
export async function performAskOnRefined(refinedNodeId: string): Promise<void> {
  const store = useCanvasStore.getState();
  const messages = Object.values(store.messages)
    .filter((m) => m.nodeId === refinedNodeId && m.role === 'assistant')
    .sort((a, b) => a.sequence - b.sequence);
  const lastAssistant = messages[messages.length - 1];
  if (!lastAssistant) {
    toast.error('提炼尚未完成，无法继续追问');
    return;
  }
  if (lastAssistant.status === 'streaming') {
    toast.error('提炼仍在进行中，请等待完成');
    return;
  }
  try {
    const refinedNode = store.nodes[refinedNodeId];
    const positionOverride = refinedNode ? computeBranchPlacement(refinedNode, store) : null;
    const { node, edge } = await api.branchNode({
      parentNodeId: refinedNodeId,
      fromMessageId: lastAssistant.id,
      positionOverride,
    });
    store.upsertNode(node);
    store.upsertEdge(edge);
    store.openFullscreen(node.id);
    const zoom = store.canvas?.viewportZoom ?? 1;
    const nodeCenterX = node.positionX + 180;
    const nodeCenterY = node.positionY + 120;
    store.setViewport(window.innerWidth / 2 - nodeCenterX * zoom, window.innerHeight / 2 - nodeCenterY * zoom, zoom);
  } catch (e) {
    console.error('ask on refined failed', e);
    toast.error(`继续追问失败：${(e as Error).message ?? e}`);
  }
}

/**
 * 抓取删除节点所需的撤销快照：含节点本身、该节点所有消息、所有触及该节点的边。
 *
 * 必须在调用 api.deleteNode 之前执行——api.deleteNode 成功后 store.removeNodeAndEdges
 * 会立即清理关联消息和边，此时再读 store 已无数据可抓。
 *
 * 节点不存在（已被并发删除）时返回 null；调用方应跳过入栈。
 */
export function captureNodeDeleteSnapshot(nodeId: string): { node: Node; messages: Message[]; edges: Edge[] } | null {
  const state = useCanvasStore.getState();
  const node = state.nodes[nodeId];
  if (!node) return null;
  // 规范化流式中间态：前端 store 的 message.status 与后端流式状态可能短暂不同步
  // （流刚结束 status 未及时翻 'complete'）。恢复时 streamingByNode 不会被同步重建，
  // 写回 status='streaming' 的消息会让 UI 长期显示"流式中"但实际无 stream 在跑，引发状态错乱。
  // 转为 'error' 保留已累积的内容，让用户看到中断点而非伪流式态。
  // filter + map 合并为单次遍历，减少中间数组分配
  const messages = Object.values(state.messages).reduce<Message[]>((acc, m) => {
    if (m.nodeId !== nodeId) return acc;
    acc.push(m.status === 'streaming' ? { ...m, status: 'error' as const } : m);
    return acc;
  }, []);
  const edges = Object.values(state.edges).filter(
    (e) => e.parentNodeId === nodeId || e.childNodeId === nodeId,
  );
  return { node, messages, edges };
}

/**
 * 执行栈顶撤销动作（Cmd+Z 入口）。
 *
 * - node.move：用 pointerDown 时记录的前值精确还原坐标，不取近似（domain §1.7 INV-10）。
 * - node.delete：调 POST /api/nodes/restore 事务写回节点 + 消息 + 边，再更新 store。
 *
 * 失败策略：
 * - 网络 / 服务端 5xx → 保留条目，用户可重试，toast 提示原因。
 * - 后端 409（node id 已存在）→ 条目已失效，弹栈并 toast 说明。
 * - node.move 目标节点已不存在 → 条目失效，弹栈跳过。
 *
 * 仅处理 node.move / node.delete 两类（domain §1.7：新建节点不入栈）。
 */
export async function performUndo(): Promise<void> {
  const store = useCanvasStore.getState();
  const stack = store.undoStack;
  if (stack.length === 0) return;
  const entry = stack[stack.length - 1]!;

  try {
    if (entry.kind === 'node.move') {
      const node = store.nodes[entry.nodeId];
      if (!node) {
        // 节点已不存在（之前被删了又没撤删）——条目失效，弹栈跳过
        store.popUndoEntry();
        toast.info('节点已不存在，跳过此条撤销');
        return;
      }
      // INV-10：坐标精确还原，不取近似
      await api.updateNode(entry.nodeId, { positionX: entry.prevX, positionY: entry.prevY });
      store.updateNode(entry.nodeId, { positionX: entry.prevX, positionY: entry.prevY });
      store.popUndoEntry();
      toast.success('已撤销节点移动');
    } else if (entry.kind === 'node.delete') {
      // INV-3：snapshot 中的边（含 branch）原样写回，inheritedUntilSequence 保持不变
      await api.restoreNode(entry.snapshot);
      store.upsertNode(entry.snapshot.node);
      for (const m of entry.snapshot.messages) store.upsertMessage(m);
      for (const e of entry.snapshot.edges) store.upsertEdge(e);
      store.popUndoEntry();
      toast.success('已撤销节点删除');
    }
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (msg.includes('409') || msg.includes('already_exists')) {
      // 后端 409：node id 已存在。条目失效，弹栈避免反复尝试
      store.popUndoEntry();
      toast.error('节点已被重新创建，无法恢复');
    } else {
      // 网络/服务端其他错误：保留条目，用户可重试
      console.error('undo failed', e);
      toast.error(`撤销失败：${msg}`);
    }
  }
}
