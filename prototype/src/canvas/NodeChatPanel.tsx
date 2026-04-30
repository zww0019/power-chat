import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { Pencil, Copy, GitBranch, ChevronDown, ChevronRight, Brain, CornerDownRight, Loader2, MessageSquarePlus } from 'lucide-react';
import { useCanvasStore, selectMessagesOfNode, selectBranchesFromMessage, selectIsMessageReferencedByBranch } from '../store/canvasStore';
import { toast } from '../store/toastStore';
import type { Node as NodeType, Message } from '../types';
import { RefinedContent } from './RefinedContent';
import { MarkdownContent } from './MarkdownContent';
import { AgentTrace } from './AgentTrace';
import { performSendMessage, performBranch, performAbort, focusNodeOnMessage, performEditMessage, performAskOnRefined } from './nodeActions';
import { useStickyBottom } from './useStickyBottom';
import { color, text, space, radius, shadow, motion } from '../styles/theme';

// inline：节点展开态内嵌（高度上限 480px，宽度跟随 360px 节点）；
// fullscreen：大屏 Modal（高度 flex 占满 Modal 内容区，宽度由 Modal 容器决定）。
type ChatMode = 'inline' | 'fullscreen';

// 编辑模式提交/取消按钮的胶囊基线
const pillBase: React.CSSProperties = {
  fontSize: text.xs,
  padding: '5px 14px',
  borderRadius: radius.pill,
  fontWeight: 500,
  cursor: 'pointer',
};

// 消息工具栏容器：贴在气泡的左下（assistant）或右下（user）外缘，hover 才显示。
// 自身无背景/边框，只负责按钮的横向排列与定位；onPointerDown 阻止冒泡，
// 防止画布的拖拽逻辑把工具栏点击当成节点拖动。
function MessageToolbar({ side, children }: { side: 'left' | 'right'; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        [side]: 0,
        bottom: -10,
        display: 'flex',
        gap: 4,
        background: color.raised,
        padding: '3px 4px',
        borderRadius: radius.pill,
        border: `0.5px solid ${color.ink200}`,
        boxShadow: shadow.sm,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

interface ToolbarIconButtonProps {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  disabled?: boolean;
  // "持续强调态"：区别于 HTML :active 按下瞬态，这里是受控的常驻高亮
  // （用于 BranchBadge popover 打开期间按钮保持主色，提示当前浮层归属）
  highlighted?: boolean;
  children: React.ReactNode;
}

const toolbarButtonBaseStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  width: 24,
  height: 24,
  borderRadius: radius.pill,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1,
  fontSize: text.xs,
  fontWeight: 500,
  gap: 3,
};

// 工具栏内的图标按钮：默认 ink-500，hover/highlighted 切到 accent-500 + 暖色底。
function ToolbarIconButton({ onClick, title, disabled, highlighted, children }: ToolbarIconButtonProps) {
  const [hovered, setHovered] = useState(false);
  const active = !disabled && (hovered || highlighted);
  const textColor = disabled ? color.ink300 : (active ? color.accent600 : color.ink500);
  const bg = active ? color.accent50 : 'transparent';
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        onClick(e);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={title}
      disabled={disabled}
      style={{
        ...toolbarButtonBaseStyle,
        color: textColor,
        background: bg,
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: 'auto',
        minWidth: 24,
        padding: '0 6px',
      }}
    >
      {children}
    </button>
  );
}

interface NodeChatPanelProps {
  node: NodeType;
  isStreaming: boolean;
  mode: ChatMode;
}

// 节点的"消息列表 + 输入区"共享面板。
// 由展开态节点（Node.tsx）和大屏 Modal（NodeFullscreenModal.tsx）共用，避免双份漂移。
// 自身不渲染 header / 节点外框，只负责中间和底部两段；外层容器应提供 flex column 布局
// 以让 fullscreen 模式下消息区能 flex:1 占满剩余空间。
export function NodeChatPanel({ node, isStreaming, mode }: NodeChatPanelProps) {
  const messages = useCanvasStore((s) => selectMessagesOfNode(s, node.id));
  const setActiveNode = useCanvasStore((s) => s.setActiveNode);
  const isRefined = node.type === 'refined';

  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleActivate = useCallback(() => setActiveNode(node.id), [setActiveNode, node.id]);

  // fullscreen 模式打开后焦点直接进输入框；inline 模式由原 ExpandedNodeView 控制（不抢焦点）。
  // 依赖 node.id：performBranch 触发 openFullscreen 切换 fullscreenNodeId 时，NodeFullscreenModal
  // 内部不重新挂载本组件（无 key），effect 默认不会重跑。把 node.id 纳入依赖让节点切换时重新聚焦，
  // 否则用户在大屏 Modal 内分支后焦点会停留在上一节点（组件实例复用，textarea DOM 未重建，
  // focus 状态停在原位），新节点的输入框不会自动获焦。
  // rAF 兜底首帧时序：openFullscreen 与 textarea commit 之间可能有微妙时序，rAF 让 commit 完成后再读 ref。
  useEffect(() => {
    if (isStreaming || mode !== 'fullscreen') return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [mode, isStreaming, node.id]);

  const handleSend = async () => {
    const textContent = draft.trim();
    if (!textContent || isStreaming) return;
    setDraft('');
    await performSendMessage(node.id, textContent);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      {isRefined ? (
        <RefinedNodeBody nodeId={node.id} messages={messages} onActivate={handleActivate} mode={mode} />
      ) : (
        <DialogueNodeBody node={node} messages={messages} onActivate={handleActivate} mode={mode} />
      )}
      {isRefined ? (
        <RefinedNodeFooter nodeId={node.id} isStreaming={isStreaming} mode={mode} />
      ) : (
        <NodeFooter
          isStreaming={isStreaming}
          draft={draft}
          setDraft={setDraft}
          handleKeyDown={handleKeyDown}
          onActivate={handleActivate}
          inputRef={inputRef}
          mode={mode}
        />
      )}
    </>
  );
}

/**
 * 提炼节点底部的"继续追问"按钮，替代原输入框。
 * 点击后调 performAskOnRefined：孵化常规对话子节点（branch 边继承提炼输出）+ 直达大屏。
 * 流式期间禁用，避免在提炼未完成时产生半成品分支。
 *
 * @param mode - 决定内边距规格；fullscreen 用更宽的侧边距以匹配大屏容器的文本行宽。
 */
function RefinedNodeFooter({ nodeId, isStreaming, mode }: { nodeId: string; isStreaming: boolean; mode: ChatMode }) {
  const [hover, setHover] = useState(false);
  const padding = mode === 'fullscreen' ? `${space.s4}px ${space.s7}px ${space.s5}px` : `${space.s3}px ${space.s4}px ${space.s4}px`;
  const disabled = isStreaming;
  const bg = hover && !disabled ? color.accent50 : 'transparent';
  return (
    <div style={{ borderTop: `0.5px solid ${color.accent200}`, padding, background: color.warm }}>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); performAskOnRefined(nodeId); }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        disabled={disabled}
        title={disabled ? '提炼仍在进行中，请等待完成' : '基于提炼结果开启新对话（不带入原节点完整对话）'}
        style={{
          width: '100%',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: `${space.s2}px ${space.s4}px`,
          borderRadius: radius.md,
          border: `1px dashed ${color.accent400}`,
          background: bg,
          color: disabled ? color.ink400 : color.accent700,
          fontSize: text.sm,
          fontWeight: 500,
          fontFamily: 'inherit',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: `background ${motion.durFast}ms ${motion.easeInOut}`,
        }}
      >
        <MessageSquarePlus size={14} strokeWidth={1.8} />
        基于此提炼继续追问
      </button>
    </div>
  );
}

function bodyContainerStyle(mode: ChatMode, padding: string): React.CSSProperties {
  // userSelect: 'text' 是必需的：App 根 div 全局设了 user-select: none 以避免画布
  // 拖拽期间误选 UI 文本（节点 header / 折叠卡 / 边等），但展开态消息体里的 AI 回复
  // 与用户提问需要让用户随手框选复制，所以在此局部覆盖回 text。cursor: text 同步给出
  // I-beam 视觉提示。WebKit 内核需带前缀（Electron / Tauri WebView 走的是 WebKit）。
  const selectable: React.CSSProperties = {
    userSelect: 'text',
    WebkitUserSelect: 'text',
    cursor: 'text',
  };
  if (mode === 'fullscreen') {
    return { padding, flex: 1, minHeight: 0, overflowY: 'auto', ...selectable };
  }
  return { padding, maxHeight: 480, overflowY: 'auto', ...selectable };
}

function RefinedNodeBody({ nodeId, messages, onActivate, mode }: { nodeId: string; messages: Message[]; onActivate: () => void; mode: ChatMode }) {
  // 提炼纲要恒为 sequence=0 的 assistant 消息（refine.streamRefine 与 RefinePopover 乐观消息均落 sequence=0）。
  // 砍掉直接聊天后新场景只剩这一条；旧数据若有 sequence>0 的 user/assistant 是历史追问遗留，进 LegacyHistory 展示。
  // 三个变量通过单遍完成分类，避免 find + filter + sort 各遍历一次（n 虽小，语义更明确）。
  let refinedMessage: Message | null = null;
  const legacyHistory: Message[] = [];
  for (const m of messages) {
    if (m.sequence === 0 && m.role === 'assistant') {
      refinedMessage = m;
    } else if (m.sequence > 0) {
      legacyHistory.push(m);
    }
  }
  legacyHistory.sort((a, b) => a.sequence - b.sequence);
  // 流式增量可能落在 content / reasoningContent / agentTrace 任一字段。
  const stickySignal = `${refinedMessage?.content?.length ?? 0}:${refinedMessage?.reasoningContent?.length ?? 0}:${refinedMessage?.agentTrace?.length ?? 0}`;
  // resetKey：本节点是否处于大屏态。inline ↔ fullscreen 切换时 inline 侧组件不卸载，
  // 需主动通过 resetKey 把 sticky 翻回 true（fullscreen 侧每次新挂载，天然 true）。
  const isThisNodeFullscreen = useCanvasStore((s) => s.fullscreenNodeId === nodeId);
  const { containerRef, onScroll } = useStickyBottom<HTMLDivElement>(stickySignal, { resetKey: isThisNodeFullscreen });
  return (
    <div
      ref={containerRef}
      style={bodyContainerStyle(mode, '0')}
      onClick={onActivate}
      onScroll={onScroll}
      data-canvas-node-scroll={mode === 'inline' ? '' : undefined}
    >
      <RefinedContent message={refinedMessage} />
      {legacyHistory.length > 0 && <LegacyRefinedHistory messages={legacyHistory} mode={mode} />}
    </div>
  );
}

/**
 * 旧数据兼容：refined 节点上历史追问消息的只读折叠区。
 *
 * 由于"refined 节点支持继续聊天"已被砍掉，新场景下 refined 节点只有 sequence=0 的提炼纲要；
 * 但本次改动不删除旧数据，旧的 user/assistant 历史消息仍在数据库里——这里以折叠区方式只读展示，
 * 让用户能回看以前在该节点上聊过什么。默认收起，避免污染纲要主体的视觉。
 *
 * @param messages - 调用方传入 sequence > 0 的消息子集，已按 sequence 升序排列；
 *                   此组件不再做筛选/排序，保持单一职责。
 * @param mode      - 决定内边距规格（fullscreen 用更宽的侧边距以适应大屏容器）。
 */
function LegacyRefinedHistory({ messages, mode }: { messages: Message[]; mode: ChatMode }) {
  const [expanded, setExpanded] = useState(false);
  const padding = mode === 'fullscreen' ? `${space.s3}px ${space.s7}px` : `${space.s2}px ${space.s4}px`;
  return (
    <div style={{ borderTop: `0.5px dashed ${color.accent200}`, marginTop: space.s3, padding, background: color.warm }}>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        style={{
          width: '100%',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: `${space.s1}px 0`,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: color.accent700,
          fontSize: text.xs,
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        {expanded ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}
        历史追问（{messages.length} 条 · 只读存档）
      </button>
      {expanded && (
        <div style={{ paddingTop: space.s2, paddingBottom: space.s2, display: 'flex', flexDirection: 'column', gap: space.s2 }}>
          {messages.map((m) => (
            <LegacyHistoryItem key={m.id} message={m} />
          ))}
        </div>
      )}
    </div>
  );
}

// 旧追问消息的只读渲染单元：不挂工具栏（编辑/分支），避免对无法修改的历史数据触发写操作。
function LegacyHistoryItem({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div
      style={{
        padding: `${space.s2}px ${space.s3}px`,
        borderRadius: radius.sm,
        background: isUser ? color.accent50 : color.raised,
        fontSize: text.sm,
        lineHeight: 1.55,
        color: color.ink800,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      <div style={{ fontSize: text.xs, color: color.ink500, marginBottom: 2 }}>
        {isUser ? '你（追问）' : 'AI（追问回答）'}
      </div>
      {message.content}
    </div>
  );
}

function DialogueNodeBody({ node, messages, onActivate, mode }: { node: NodeType; messages: Message[]; onActivate: () => void; mode: ChatMode }) {
  // 流式增量信号：消息数 + 末条消息的可变字段长度。SSE 每帧追加 content / reasoningContent
  // / agentTrace 任意一项都会改变此字符串，触发 useStickyBottom 内部 effect 调度置底。
  const last = messages[messages.length - 1];
  const stickySignal = `${messages.length}:${last?.content?.length ?? 0}:${last?.reasoningContent?.length ?? 0}:${last?.agentTrace?.length ?? 0}`;
  // resetKey：本节点是否处于大屏态。inline ↔ fullscreen 切换时 inline 侧组件不卸载，
  // 需主动通过 resetKey 把 sticky 翻回 true（fullscreen 侧每次新挂载，天然 true）。
  const isThisNodeFullscreen = useCanvasStore((s) => s.fullscreenNodeId === node.id);
  const { containerRef, onScroll } = useStickyBottom<HTMLDivElement>(stickySignal, { resetKey: isThisNodeFullscreen });
  return (
    <div
      ref={containerRef}
      style={bodyContainerStyle(mode, mode === 'fullscreen' ? `${space.s5}px ${space.s7}px` : `${space.s4}px ${space.s4}px`)}
      onClick={onActivate}
      onScroll={onScroll}
      data-canvas-node-scroll={mode === 'inline' ? '' : undefined}
    >
      {messages.length === 0 && (
        <div style={{ color: color.ink400, fontSize: text.sm, fontStyle: 'italic', padding: `${space.s2}px 0` }}>
          输入第一句话开始 →
        </div>
      )}
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} onBranch={() => performBranch(node.id, m.id)} mode={mode} />
      ))}
    </div>
  );
}

interface NodeFooterProps {
  isStreaming: boolean;
  draft: string;
  setDraft: (v: string) => void;
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onActivate: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  mode: ChatMode;
}

function NodeFooter({ isStreaming, draft, setDraft, handleKeyDown, onActivate, inputRef, mode }: NodeFooterProps) {
  const [focused, setFocused] = useState(false);
  const placeholder = isStreaming ? 'AI 正在回复…' : '继续这个对话…';
  const padding = mode === 'fullscreen' ? `${space.s4}px ${space.s7}px ${space.s5}px` : `${space.s3}px ${space.s4}px ${space.s4}px`;
  const rows = mode === 'fullscreen' ? 3 : 2;

  return (
    <div style={{ borderTop: `0.5px solid ${color.ink200}`, padding, background: color.paper }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: space.s2,
          background: color.raised,
          padding: `${space.s2}px ${space.s3}px`,
          borderRadius: radius.md,
          border: `1px solid ${focused ? color.accent400 : color.ink200}`,
          boxShadow: focused ? `0 0 0 3px ${color.accent50}` : 'none',
          transition: `border-color ${motion.durFast}ms ${motion.easeInOut}, box-shadow ${motion.durFast}ms ${motion.easeInOut}`,
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onClick={onActivate}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          disabled={isStreaming}
          rows={rows}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontSize: text.base,
            lineHeight: 1.6,
            fontFamily: 'inherit',
            background: 'transparent',
            color: color.ink900,
          }}
        />
      </div>
    </div>
  );
}

interface BubbleProps {
  message: Message;
  // 返回 Promise 以便 AssistantBubble 在 await 期间显示 loading 态。
  // performBranch 在新版中向上抛错，由这里的 try/finally 兜底清理 loading。
  onBranch: () => Promise<void>;
  mode: ChatMode;
}

// MessageBubble 只做用户/助手分流，把渲染细节下沉到 UserBubble / AssistantBubble。
function MessageBubble({ message, onBranch, mode }: BubbleProps) {
  const fontSize = text.base;
  const maxWidth = mode === 'fullscreen' ? '78%' : '94%';
  if (message.role === 'user') {
    return <UserBubble message={message} fontSize={fontSize} maxWidth={maxWidth} />;
  }
  return (
    <AssistantBubble
      message={message}
      onBranch={onBranch}
      fontSize={fontSize}
      maxWidth={maxWidth}
    />
  );
}

// 用户气泡：暖色底（accent-50）+ 圆角 md。hover 显示工具栏（编辑按钮）+ 内联编辑模式。
function UserBubble({ message, fontSize, maxWidth }: { message: Message; fontSize: number; maxWidth: string }) {
  const [hover, setHover] = useState(false);
  const [showToolbar, setShowToolbar] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const isReferenced = useCanvasStore((s) => selectIsMessageReferencedByBranch(s, message.nodeId, message.sequence));
  const isNodeStreaming = useCanvasStore((s) => s.streamingByNode[message.nodeId] === 'streaming');

  // 80ms hover 延迟避免快速划过时按钮闪烁
  useEffect(() => {
    if (!hover) {
      setShowToolbar(false);
      return;
    }
    const t = setTimeout(() => setShowToolbar(true), 80);
    return () => clearTimeout(t);
  }, [hover]);

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };
  const cancelEdit = () => setEditing(false);
  const submitEdit = () => {
    const textContent = draft.trim();
    if (!textContent || textContent === message.content) {
      setEditing(false);
      return;
    }
    setEditing(false);
    void performEditMessage(message.nodeId, message.sequence, textContent);
  };

  if (editing) {
    return (
      <UserBubbleEditor
        messageId={message.id}
        draft={draft}
        setDraft={setDraft}
        onSubmit={submitEdit}
        onCancel={cancelEdit}
        fontSize={fontSize}
        maxWidth={maxWidth}
      />
    );
  }

  const editDisabled = isReferenced || isNodeStreaming;
  const disabledTooltip = isNodeStreaming
    ? 'AI 回复中，无法编辑'
    : isReferenced
      ? '此消息已被分支引用，编辑会破坏分支上下文'
      : '';

  return (
    <div
      data-message-id={message.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ marginBottom: space.s5, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}
    >
      <div style={{ position: 'relative', maxWidth }}>
        <div
          style={{
            background: color.tint,
            color: color.ink900,
            padding: `${space.s3}px ${space.s4}px`,
            borderRadius: radius.md,
            borderTopRightRadius: radius.sm,
            fontSize,
            lineHeight: 1.65,
            whiteSpace: 'pre-wrap',
            border: `0.5px solid ${color.accent100}`,
          }}
        >
          {message.content}
        </div>
        {showToolbar && (
          <MessageToolbar side="right">
            <ToolbarIconButton
              onClick={startEdit}
              disabled={editDisabled}
              title={editDisabled ? disabledTooltip : '编辑此消息并重新生成 AI 回复'}
            >
              <Pencil size={13} strokeWidth={1.8} />
            </ToolbarIconButton>
          </MessageToolbar>
        )}
      </div>
    </div>
  );
}

interface UserBubbleEditorProps {
  messageId: string;
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  fontSize: number;
  maxWidth: string;
}

// 编辑模式：textarea 替代气泡 + 提交/取消按钮。Enter=提交，Shift+Enter=换行，ESC=取消。
function UserBubbleEditor({ messageId, draft, setDraft, onSubmit, onCancel, fontSize, maxWidth }: UserBubbleEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    taRef.current?.focus();
    taRef.current?.setSelectionRange(draft.length, draft.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      data-message-id={messageId}
      style={{ marginBottom: space.s5, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}
    >
      <div style={{ maxWidth, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: space.s2 }}>
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onPointerDown={(e) => e.stopPropagation()}
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          style={{
            width: '100%',
            background: color.tint,
            color: color.ink900,
            padding: `${space.s3}px ${space.s4}px`,
            border: `1px solid ${color.accent400}`,
            borderRadius: radius.md,
            fontSize,
            fontFamily: 'inherit',
            lineHeight: 1.65,
            resize: 'vertical',
            outline: 'none',
            boxSizing: 'border-box',
            boxShadow: `0 0 0 3px ${color.accent50}`,
          }}
        />
        <div style={{ display: 'flex', gap: space.s2 }}>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            style={{
              ...pillBase,
              border: `1px solid ${color.ink200}`,
              background: color.raised,
              color: color.ink600,
            }}
          >
            取消
          </button>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onSubmit(); }}
            style={{
              ...pillBase,
              border: `1px solid ${color.accent500}`,
              background: color.accent500,
              color: '#FFFFFF',
              boxShadow: shadow.accent,
            }}
          >
            提交并重新生成
          </button>
        </div>
      </div>
    </div>
  );
}

interface AssistantBubbleProps {
  message: Message;
  onBranch: () => Promise<void>;
  fontSize: number;
  maxWidth: string;
}

// 助手气泡：浅暖白底（surface-soft）+ 圆角 md。
// 含 AgentTrace / Reasoning / 启动提示 / 流式光标 / 工具栏（复制 / 分支 / 分支徽章）。
function AssistantBubble({ message, onBranch, fontSize, maxWidth }: AssistantBubbleProps) {
  const [hover, setHover] = useState(false);
  const [hoverDelayElapsed, setHoverDelayElapsed] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  // 分支按钮的 loading 态：API 同步等待（创建节点 + 边）期间锁住按钮防重入并切换图标，
  // 让用户立即知道点击已被接收。失败时 toast 提示后解锁，避免用户对着失败按钮反复点。
  const [branching, setBranching] = useState(false);
  const hasBranches = useCanvasStore(
    (s) => selectBranchesFromMessage(s, message.nodeId, message.sequence).length > 0,
  );

  const handleBranchClick = async () => {
    if (branching) return;
    setBranching(true);
    try {
      await onBranch();
    } catch (e) {
      console.error('branch failed', e);
      toast.error(`分支创建失败：${(e as Error).message ?? e}`);
    } finally {
      setBranching(false);
    }
  };

  useEffect(() => {
    if (!hover) {
      setHoverDelayElapsed(false);
      return;
    }
    const timer = setTimeout(() => setHoverDelayElapsed(true), 80);
    return () => clearTimeout(timer);
  }, [hover]);

  const hasReasoning = !!message.reasoningContent && message.reasoningContent.length > 0;
  const hasAgentTrace = !!message.agentTrace && message.agentTrace.length > 0;
  const isStreaming = message.status === 'streaming';
  const showStartupHint = isStreaming && !hasAgentTrace && !hasReasoning && !message.content;
  const showToolbar = message.status === 'complete' && (hoverDelayElapsed || popoverOpen);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.content);
      } else {
        copyViaExecCommand(message.content);
      }
      toast.success('已复制');
    } catch {
      try {
        copyViaExecCommand(message.content);
        toast.success('已复制');
      } catch {
        toast.error('复制失败');
      }
    }
  };

  return (
    <div
      data-message-id={message.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        marginBottom: space.s5,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
      }}
    >
      {showStartupHint && <StartupHint />}
      {hasAgentTrace && (
        <AgentTrace
          trace={message.agentTrace!}
          isStreaming={isStreaming}
          nodeId={message.nodeId}
          onAbort={performAbort}
        />
      )}
      {hasReasoning && (
        <ReasoningBlock content={message.reasoningContent!} isStreaming={isStreaming} />
      )}
      <div
        style={{
          maxWidth,
          color: color.ink900,
          fontSize,
          lineHeight: 1.75,
          background: color.soft,
          padding: `${space.s3}px ${space.s4}px`,
          borderRadius: radius.md,
          borderTopLeftRadius: radius.sm,
          border: `0.5px solid ${color.ink200}`,
          position: 'relative',
        }}
      >
        <MarkdownContent content={message.content} isStreaming={isStreaming} />
        {isStreaming && (
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: '1em',
              background: color.accent500,
              marginLeft: 3,
              verticalAlign: 'text-bottom',
              animation: 'blink 1.06s step-end infinite',
              borderRadius: 1,
            }}
          />
        )}
      </div>
      {showToolbar && (
        <MessageToolbar side="left">
          <ToolbarIconButton onClick={handleCopy} title="复制此消息原文（保留 markdown）">
            <Copy size={13} strokeWidth={1.8} />
          </ToolbarIconButton>
          <ToolbarIconButton
            onClick={handleBranchClick}
            disabled={branching}
            title={branching ? '正在创建分支…' : '从这里分支（基于此消息创建子节点）'}
          >
            {branching ? (
              <span style={{ display: 'inline-flex', animation: 'spin 1s linear infinite' }}>
                <Loader2 size={13} strokeWidth={1.8} />
              </span>
            ) : (
              <GitBranch size={13} strokeWidth={1.8} />
            )}
          </ToolbarIconButton>
          {hasBranches && (
            <BranchBadgeButton
              nodeId={message.nodeId}
              sequence={message.sequence}
              open={popoverOpen}
              onOpenChange={setPopoverOpen}
            />
          )}
        </MessageToolbar>
      )}
    </div>
  );
}

// execCommand 兜底路径：navigator.clipboard 在 Electron file:// 协议或旧版 WebView
// 非安全上下文下会缺失或抛权限错误，此时退回 textarea+select+execCommand 方案。
function copyViaExecCommand(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('execCommand copy failed');
}

// 工具栏内的"已派生 N 个分支"按钮：图标态（GitBranch + 数字），点击展开浮层列出所有子分支。
interface BranchBadgeButtonProps {
  nodeId: string;
  sequence: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function BranchBadgeButton({ nodeId, sequence, open, onOpenChange }: BranchBadgeButtonProps) {
  const branches = useCanvasStore((s) => selectBranchesFromMessage(s, nodeId, sequence));
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open, onOpenChange]);

  if (branches.length === 0) return null;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <ToolbarIconButton
        onClick={() => onOpenChange(!open)}
        title={`已派生 ${branches.length} 个分支`}
        highlighted={open}
      >
        <GitBranch size={13} strokeWidth={1.8} />
        <span style={{ fontSize: text.xs, fontWeight: 600 }}>{branches.length}</span>
      </ToolbarIconButton>
      {open && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            bottom: 32,
            minWidth: 200,
            maxWidth: 280,
            background: color.raised,
            border: `0.5px solid ${color.ink200}`,
            borderRadius: radius.md,
            boxShadow: shadow.lg,
            padding: space.s1,
            zIndex: 10,
            animation: `modal-in ${motion.durFast}ms ${motion.easeOutSoft}`,
          }}
        >
          <div style={{ fontSize: text.xs, color: color.ink500, padding: `6px 10px`, fontWeight: 500 }}>
            派生分支（{branches.length}）
          </div>
          {branches.map(({ edge, childNode }) => (
            <BranchListItem
              key={edge.id}
              childNodeId={childNode.id}
              title={childNode.title ?? '新节点'}
              onSelect={() => {
                const allMessages = useCanvasStore.getState().messages;
                const firstMsg = Object.values(allMessages)
                  .filter((m) => m.nodeId === childNode.id)
                  .sort((a, b) => a.sequence - b.sequence)[0];
                focusNodeOnMessage(childNode.id, firstMsg?.id ?? null);
                onOpenChange(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BranchListItem({ childNodeId, title, onSelect }: { childNodeId: string; title: string; onSelect: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-child-node-id={childNodeId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        textAlign: 'left',
        background: hover ? color.accent50 : 'transparent',
        border: 'none',
        padding: '7px 10px',
        borderRadius: radius.sm,
        fontSize: text.sm,
        color: color.ink800,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        overflow: 'hidden',
      }}
    >
      <CornerDownRight size={13} strokeWidth={1.8} style={{ color: color.accent500, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
    </button>
  );
}

const dotPulse0: React.CSSProperties = { width: 4, height: 4, borderRadius: '50%', background: color.accent400, animation: 'blink 1.2s ease-in-out 0s infinite' };
const dotPulse1: React.CSSProperties = { width: 4, height: 4, borderRadius: '50%', background: color.accent400, animation: 'blink 1.2s ease-in-out 0.2s infinite' };
const dotPulse2: React.CSSProperties = { width: 4, height: 4, borderRadius: '50%', background: color.accent400, animation: 'blink 1.2s ease-in-out 0.4s infinite' };

function StartupHint() {
  return (
    <div
      style={{
        fontSize: text.xs,
        color: color.ink400,
        fontStyle: 'italic',
        marginBottom: 6,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span style={{ display: 'inline-flex', gap: 3 }}>
        <span style={dotPulse0} />
        <span style={dotPulse1} />
        <span style={dotPulse2} />
      </span>
      AI 正在准备工具调用…
    </div>
  );
}

// AI reasoning（思考过程）展示块：边沿触发自动折叠。
function ReasoningBlock({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(isStreaming);
  const prevStreamingRef = useRef(isStreaming);

  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming && expanded) {
      const timer = setTimeout(() => setExpanded(false), 600);
      return () => clearTimeout(timer);
    }
  }, [isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      style={{
        cursor: 'pointer',
        fontSize: text.xs,
        color: color.ink600,
        background: 'rgba(245, 233, 210, 0.45)',
        border: `0.5px solid ${color.accent200}`,
        borderRadius: radius.md,
        padding: `${space.s2}px ${space.s3}px`,
        marginBottom: space.s2,
        maxWidth: '94%',
        display: 'flex',
        gap: 6,
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 500, color: color.accent700 }}>
        <Brain size={12} strokeWidth={1.8} />
        <span style={{ flex: 1 }}>思考过程</span>
        {expanded ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}
      </div>
      {expanded && (
        <div style={{ marginTop: 2, lineHeight: 1.7, whiteSpace: 'pre-wrap', fontStyle: 'italic' }}>
          {content}
        </div>
      )}
    </div>
  );
}
