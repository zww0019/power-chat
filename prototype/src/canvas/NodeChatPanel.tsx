import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { Pencil, Copy, GitBranch, Info, ChevronDown, ChevronRight, Brain, CornerDownRight } from 'lucide-react';
import { useCanvasStore, selectMessagesOfNode, selectBranchesFromMessage, selectIsMessageReferencedByBranch } from '../store/canvasStore';
import { toast } from '../store/toastStore';
import type { Node as NodeType, Message } from '../types';
import { RefinedContent } from './RefinedContent';
import { MarkdownContent } from './MarkdownContent';
import { AgentTrace } from './AgentTrace';
import { performSendMessage, performBranch, performAbort, focusNodeOnMessage, performEditMessage } from './nodeActions';
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

  // fullscreen 模式打开后焦点直接进输入框；inline 模式由原 ExpandedNodeView 控制
  useEffect(() => {
    if (mode === 'fullscreen' && !isStreaming && inputRef.current) {
      inputRef.current.focus();
    }
  }, [mode, isStreaming]);

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
        <RefinedNodeBody messages={messages} onActivate={handleActivate} mode={mode} />
      ) : (
        <DialogueNodeBody node={node} messages={messages} onActivate={handleActivate} mode={mode} />
      )}
      <NodeFooter
        isRefined={isRefined}
        isStreaming={isStreaming}
        draft={draft}
        setDraft={setDraft}
        handleKeyDown={handleKeyDown}
        onActivate={handleActivate}
        inputRef={inputRef}
        mode={mode}
      />
    </>
  );
}

// 节点内滚动容器的 wheel 拦截（仅 inline 模式生效）：内部还能滚时阻断冒泡防止画布同时平移；
// 滚到顶/底边界时放行，让画布接管。fullscreen 模式下 Modal 已脱离画布层，无需拦截。
function handleNodeWheel(e: React.WheelEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  if (e.deltaY > 0 && atBottom) return;
  if (e.deltaY < 0 && atTop) return;
  e.stopPropagation();
}

function bodyContainerStyle(mode: ChatMode, padding: string): React.CSSProperties {
  if (mode === 'fullscreen') {
    return { padding, flex: 1, minHeight: 0, overflowY: 'auto' };
  }
  return { padding, maxHeight: 480, overflowY: 'auto' };
}

function RefinedNodeBody({ messages, onActivate, mode }: { messages: Message[]; onActivate: () => void; mode: ChatMode }) {
  let lastAssistant: Message | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') { lastAssistant = messages[i]!; break; }
  }
  return (
    <div style={bodyContainerStyle(mode, '0')} onClick={onActivate} onWheel={mode === 'inline' ? handleNodeWheel : undefined}>
      <RefinedContent message={lastAssistant} />
    </div>
  );
}

function DialogueNodeBody({ node, messages, onActivate, mode }: { node: NodeType; messages: Message[]; onActivate: () => void; mode: ChatMode }) {
  return (
    <div
      style={bodyContainerStyle(mode, mode === 'fullscreen' ? `${space.s5}px ${space.s7}px` : `${space.s4}px ${space.s4}px`)}
      onClick={onActivate}
      onWheel={mode === 'inline' ? handleNodeWheel : undefined}
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
  isRefined: boolean;
  isStreaming: boolean;
  draft: string;
  setDraft: (v: string) => void;
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onActivate: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  mode: ChatMode;
}

function NodeFooter({ isRefined, isStreaming, draft, setDraft, handleKeyDown, onActivate, inputRef, mode }: NodeFooterProps) {
  const [focused, setFocused] = useState(false);
  const borderColor = isRefined ? color.accent200 : color.ink200;
  const bg = isRefined ? color.warm : color.paper;
  const innerBg = isRefined ? '#FBF3DF' : color.raised;
  const textColor = isRefined ? color.accent700 : color.ink900;
  const placeholder = isStreaming ? 'AI 正在回复…' : '继续这个对话…';
  const padding = mode === 'fullscreen' ? `${space.s4}px ${space.s7}px ${space.s5}px` : `${space.s3}px ${space.s4}px ${space.s4}px`;
  const rows = mode === 'fullscreen' ? 3 : 2;

  return (
    <div style={{ borderTop: `0.5px solid ${borderColor}`, padding, background: bg }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: space.s2,
          background: innerBg,
          padding: `${space.s2}px ${space.s3}px`,
          borderRadius: radius.md,
          border: `1px solid ${focused ? color.accent400 : color.ink200}`,
          boxShadow: focused ? `0 0 0 3px ${color.accent50}` : 'none',
          transition: `border-color ${motion.durFast}ms ${motion.easeInOut}, box-shadow ${motion.durFast}ms ${motion.easeInOut}`,
        }}
      >
        {isRefined && (
          <span
            title="此节点继续对话只用提炼内容作为上下文，不带入原节点完整对话"
            style={{ display: 'inline-flex', color: color.accent500, cursor: 'help', paddingTop: 4 }}
          >
            <Info size={14} strokeWidth={1.8} />
          </span>
        )}
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
            color: textColor,
          }}
        />
      </div>
    </div>
  );
}

interface BubbleProps {
  message: Message;
  onBranch: () => void;
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
  onBranch: () => void;
  fontSize: number;
  maxWidth: string;
}

// 助手气泡：浅暖白底（surface-soft）+ 圆角 md。
// 含 AgentTrace / Reasoning / 启动提示 / 流式光标 / 工具栏（复制 / 分支 / 分支徽章）。
function AssistantBubble({ message, onBranch, fontSize, maxWidth }: AssistantBubbleProps) {
  const [hover, setHover] = useState(false);
  const [hoverDelayElapsed, setHoverDelayElapsed] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const hasBranches = useCanvasStore(
    (s) => selectBranchesFromMessage(s, message.nodeId, message.sequence).length > 0,
  );

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
          <ToolbarIconButton onClick={onBranch} title="从这里分支（基于此消息创建子节点）">
            <GitBranch size={13} strokeWidth={1.8} />
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
