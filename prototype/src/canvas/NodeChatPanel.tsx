import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { useCanvasStore, selectMessagesOfNode, selectBranchesFromMessage, selectIsMessageReferencedByBranch } from '../store/canvasStore';
import { toast } from '../store/toastStore';
import type { Node as NodeType, Message } from '../types';
import { RefinedContent } from './RefinedContent';
import { MarkdownContent } from './MarkdownContent';
import { AgentTrace } from './AgentTrace';
import { performSendMessage, performBranch, performAbort, focusNodeOnMessage, performEditMessage } from './nodeActions';

// inline：节点展开态内嵌（高度上限 480px，宽度跟随 360px 节点）；
// fullscreen：大屏 Modal（高度 flex 占满 Modal 内容区，宽度由 Modal 容器决定）。
type ChatMode = 'inline' | 'fullscreen';

// UserBubbleEditor 取消/提交按钮的胶囊形状（仅这两个按钮还需要胶囊视觉，
// 因为它们出现在编辑模式下需要明确"主/次按钮"对比，与气泡尾部的工具栏语义不同）。
const pillBase: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 10px',
  borderRadius: 12,
};

// 消息工具栏容器：贴在气泡的左下（assistant）或右下（user）外缘，hover 才显示。
// 自身无背景/边框，只负责按钮的横向排列与定位；onPointerDown 阻止冒泡，
// 防止画布的拖拽逻辑把工具栏点击当成节点拖动。
function MessageToolbar({ side, children }: { side: 'left' | 'right'; children: React.ReactNode }) {
  return (
    <div
      style={{ position: 'absolute', [side]: 0, bottom: -8, display: 'flex', gap: 6 }}
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
  fontWeight?: 400 | 500;
  children: React.ReactNode;
}

// 静态样式部分（不依赖 props）提取为模块级常量，避免每次渲染新建对象
const toolbarButtonBaseStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  fontSize: 13,
  padding: '2px 4px',
  lineHeight: 1,
  transition: 'color 120ms ease',
};

// 工具栏内的图标按钮：透明背景，无边框/阴影，仅靠颜色变化提示交互。
// 默认 #94a3b8（与节点 placeholder 同色），hover/highlighted 变 #6366f1（主色紫），disabled 变 #cbd5e1。
function ToolbarIconButton({ onClick, title, disabled, highlighted, fontWeight = 400, children }: ToolbarIconButtonProps) {
  const [hovered, setHovered] = useState(false);
  const color = disabled ? '#cbd5e1' : (hovered || highlighted ? '#6366f1' : '#94a3b8');
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
        color,
        fontWeight,
        cursor: disabled ? 'not-allowed' : 'pointer',
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
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft('');
    await performSendMessage(node.id, text);
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
      style={bodyContainerStyle(mode, mode === 'fullscreen' ? '16px 24px' : '8px 12px')}
      onClick={onActivate}
      onWheel={mode === 'inline' ? handleNodeWheel : undefined}
    >
      {messages.length === 0 && (
        <div style={{ color: '#94a3b8', fontSize: 12, fontStyle: 'italic', padding: '8px 0' }}>
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
  const borderColor = isRefined ? '#EAD4A8' : '#EFEDE5';
  const bg = isRefined ? '#FAEEDA' : '#FCFCFA';
  const textColor = isRefined ? '#412402' : '#1e293b';
  const placeholder = isStreaming ? 'AI 正在回复…' : '继续这个对话…';
  const padding = mode === 'fullscreen' ? '12px 24px' : '10px 14px';
  const fontSize = 14;
  const rows = mode === 'fullscreen' ? 3 : 2;

  return (
    <div style={{ borderTop: `0.5px solid ${borderColor}`, padding, display: 'flex', alignItems: 'flex-end', gap: 6, background: bg }}>
      {isRefined && (
        <span title="此节点继续对话只用提炼内容作为上下文，不带入原节点完整对话" style={{ fontSize: 11, color: '#BA7517', cursor: 'help' }}>
          ⓘ
        </span>
      )}
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onClick={onActivate}
        placeholder={placeholder}
        disabled={isStreaming}
        rows={rows}
        style={{
          flex: 1,
          border: 'none',
          outline: 'none',
          resize: 'none',
          fontSize,
          fontFamily: 'inherit',
          background: 'transparent',
          color: textColor,
        }}
      />
    </div>
  );
}

interface BubbleProps {
  message: Message;
  onBranch: () => void;
  mode: ChatMode;
}

// MessageBubble 只做用户/助手分流，把渲染细节下沉到 UserBubble / AssistantBubble。
// 拆分原因：原 MessageBubble 单函数承载 7 类条件渲染（启动提示/AgentTrace/Reasoning/
// 用户气泡/助手气泡/流式光标/分支按钮）+ mode 参数三元，CCN 23 超阈值（>15）。
function MessageBubble({ message, onBranch, mode }: BubbleProps) {
  const fontSize = 14;
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

// 用户气泡：纯文本展示 + hover 显示工具栏（编辑按钮）+ 内联编辑模式。
// 编辑提交走 performEditMessage（截断 + 重发）；按钮在节点流式中或消息被分支引用时禁用。
function UserBubble({ message, fontSize, maxWidth }: { message: Message; fontSize: number; maxWidth: string }) {
  const [hover, setHover] = useState(false);
  // hover 触发后需等 80ms 延迟计时器到期才翻 true，以过滤快速划过的误触（与 AssistantBubble 同款）
  const [showToolbar, setShowToolbar] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  // 两次独立订阅而非合并：让两个条件各自精确追踪所需切片，
  // 避免合并后任一无关状态变化（如其他节点 streaming）触发整个 UserBubble 重渲
  const isReferenced = useCanvasStore((s) => selectIsMessageReferencedByBranch(s, message.nodeId, message.sequence));
  const isNodeStreaming = useCanvasStore((s) => s.streamingByNode[message.nodeId] === 'streaming');

  // 80ms hover 延迟避免快速划过时按钮闪烁（视觉规范文档"微交互手感"建议）
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
    const text = draft.trim();
    // 空内容或内容未改变时静默取消——避免触发一次无意义的截断+重发
    if (!text || text === message.content) {
      setEditing(false);
      return;
    }
    setEditing(false);
    void performEditMessage(message.nodeId, message.sequence, text);
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
      style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}
    >
      <div style={{ position: 'relative', maxWidth }}>
        <div
          style={{
            background: '#eef2ff',
            color: '#1e293b',
            padding: '8px 12px',
            borderRadius: 6,
            fontSize,
            lineHeight: 1.65,
            whiteSpace: 'pre-wrap',
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
              ✎
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
    <div data-message-id={messageId} style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <div style={{ maxWidth, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onPointerDown={(e) => e.stopPropagation()}
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          style={{
            width: '100%',
            background: '#eef2ff',
            color: '#1e293b',
            padding: '8px 12px',
            border: '1px solid #c7d2fe',
            borderRadius: 6,
            fontSize,
            fontFamily: 'inherit',
            lineHeight: 1.65,
            resize: 'vertical',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 6, fontSize: 11 }}>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            style={{ ...pillBase, border: '1px solid #e2e8f0', background: '#ffffff', color: '#64748b', cursor: 'pointer' }}
          >
            取消
          </button>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onSubmit(); }}
            style={{ ...pillBase, border: '1px solid #6366f1', background: '#6366f1', color: '#ffffff', cursor: 'pointer' }}
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

// 助手气泡：含 AgentTrace / Reasoning / 启动提示 / 流式光标 / 工具栏（复制 / 分支 / 分支徽章）。
// 工具栏左下浮出，hover 80ms 触发显示；BranchBadge popover 打开时强制保持工具栏可见，
// 避免用户鼠标移到浮层上时工具栏消失带飞 popover。
function AssistantBubble({ message, onBranch, fontSize, maxWidth }: AssistantBubbleProps) {
  const [hover, setHover] = useState(false);
  // hover 触发后需等 80ms 延迟计时器到期才翻 true，以过滤快速划过的误触
  const [hoverDelayElapsed, setHoverDelayElapsed] = useState(false);
  // 分支徽章 popover 状态提升到这里：popover 打开时即使 hover 离开气泡，工具栏也要保持显示
  const [popoverOpen, setPopoverOpen] = useState(false);
  const hasBranches = useCanvasStore(
    (s) => selectBranchesFromMessage(s, message.nodeId, message.sequence).length > 0,
  );

  // 80ms hover 延迟避免快速划过时按钮闪烁（视觉规范文档"微交互手感"建议）
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
  // 启动过渡（文档 §4.5）：streaming 已开始但 content/reasoning/trace 全空的瞬间
  // 显示"AI 正在准备工具调用…"，让用户对按下 Enter 后的等待有明确反馈
  const showStartupHint = isStreaming && !hasAgentTrace && !hasReasoning && !message.content;
  // 工具栏显示条件：消息完成 && (hover 延迟到期 || popover 打开)；popoverOpen 兜底确保
  // 用户点开分支徽章浮层后即使鼠标离开气泡，工具栏与浮层都保持可见，直到用户点击外部关闭
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
        marginBottom: 12,
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
          color: '#1e293b',
          fontSize,
          lineHeight: 1.65,
        }}
      >
        <MarkdownContent content={message.content} isStreaming={isStreaming} />
        {isStreaming && <span style={{ color: '#6366f1', marginLeft: 2 }}>▍</span>}
      </div>
      {showToolbar && (
        <MessageToolbar side="left">
          <ToolbarIconButton onClick={handleCopy} title="复制此消息原文（保留 markdown）">
            📋
          </ToolbarIconButton>
          <ToolbarIconButton onClick={onBranch} title="从这里分支（基于此消息创建子节点）">
            ↳
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
// 插入到屏幕外（left:-9999px）而非 display:none，是因为 select() 对不可见元素无效。
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

// 工具栏内的"已派生 N 个分支"按钮：图标态（⑂N），点击展开浮层列出所有子分支。
// open 状态由父 AssistantBubble 受控，让父组件能在 popover 打开时延长工具栏的可见时间。
interface BranchBadgeButtonProps {
  nodeId: string;
  sequence: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function BranchBadgeButton({ nodeId, sequence, open, onOpenChange }: BranchBadgeButtonProps) {
  const branches = useCanvasStore((s) => selectBranchesFromMessage(s, nodeId, sequence));
  const containerRef = useRef<HTMLDivElement>(null);

  // 浮层打开时监听全局 pointerdown，点击容器外即关闭；onOpenChange 同步翻转，
  // 让父组件能据此释放工具栏 popoverOpen 状态
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
        fontWeight={500}
      >
        ⑂ {branches.length}
      </ToolbarIconButton>
      {open && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            bottom: 28,
            minWidth: 180,
            maxWidth: 260,
            background: '#ffffff',
            border: '1px solid #c7d2fe',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            padding: 4,
            zIndex: 10,
          }}
        >
          <div style={{ fontSize: 10, color: '#94a3b8', padding: '4px 8px' }}>
            派生分支（{branches.length}）
          </div>
          {branches.map(({ edge, childNode }) => (
            <button
              key={edge.id}
              onClick={(e) => {
                e.stopPropagation();
                // 跳子节点定位到它的"分支起点"——sequence=0 的第一条消息（通常是 user 首问）；
                // 子节点尚无消息时传 null，focusNodeOnMessage 跳过滚动只展开 + pan。
                // 通过 getState() 按需读取避免订阅整个 messages 字典导致任意消息更新都重渲徽章
                const allMessages = useCanvasStore.getState().messages;
                const firstMsg = Object.values(allMessages)
                  .filter((m) => m.nodeId === childNode.id)
                  .sort((a, b) => a.sequence - b.sequence)[0];
                focusNodeOnMessage(childNode.id, firstMsg?.id ?? null);
                onOpenChange(false);
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                padding: '6px 8px',
                borderRadius: 4,
                fontSize: 12,
                color: '#1e293b',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                overflow: 'hidden',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F3FF')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              ↳ {childNode.title ?? '新节点'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StartupHint() {
  return (
    <div style={{ fontSize: 11, color: '#cbd5e1', fontStyle: 'italic', marginBottom: 4 }}>
      AI 正在准备工具调用…
    </div>
  );
}

// AI reasoning（思考过程）展示块：边沿触发自动折叠，仅在 streaming → complete 那一次状态转换时
// 触发自动折叠定时器；用户后续手动展开不会被定时器吞掉（依赖只有 isStreaming）。
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
        fontSize: 11,
        color: '#94a3b8',
        background: '#f8fafc',
        border: '1px dashed #e2e8f0',
        borderRadius: 4,
        padding: '4px 8px',
        marginBottom: 4,
        maxWidth: '94%',
      }}
    >
      {expanded ? (
        <>
          <span style={{ fontWeight: 500 }}>💭 思考过程</span>
          <div style={{ marginTop: 4, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
            {content}
          </div>
        </>
      ) : (
        <span>💭 思考过程（点击展开）</span>
      )}
    </div>
  );
}
