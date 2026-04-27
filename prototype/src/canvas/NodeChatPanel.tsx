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

// 操作按钮共用的胶囊形状：编辑/复制/分支/分支徽章/编辑器提交&取消统一引用。
// 调整视觉规范（圆角/字号/padding）改 1 处即可。颜色相关属性由各按钮按变体覆盖。
const pillBase: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 10px',
  borderRadius: 12,
};

// 紫边白底主色胶囊：编辑/复制/分支三个 hover 触发的操作按钮共用。
// 支持 disabled 变体（编辑按钮在被分支引用 / 流式中时灰显）。
function pillPrimary(disabled = false): React.CSSProperties {
  return {
    ...pillBase,
    color: disabled ? '#cbd5e1' : '#6366f1',
    background: '#ffffff',
    border: `1px solid ${disabled ? '#e2e8f0' : '#c7d2fe'}`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    boxShadow: disabled ? 'none' : '0 1px 4px rgba(0,0,0,0.08)',
  };
}

// pillPrimary() 默认态（disabled=false）的固定结果，提取为常量避免 BranchButton /
// CopyButton 每次渲染重新调用函数、产生新对象引用，减少无用 style 对象分配。
const pillPrimaryDefault = pillPrimary();

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

// 用户气泡：纯文本展示 + hover 显示 ✎ 编辑按钮 + 内联编辑模式。
// 编辑提交走 performEditMessage（截断 + 重发）；按钮在节点流式中或消息被分支引用时禁用。
function UserBubble({ message, fontSize, maxWidth }: { message: Message; fontSize: number; maxWidth: string }) {
  const [hover, setHover] = useState(false);
  const [showEditBtn, setShowEditBtn] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  // 两次独立订阅而非合并：让两个条件各自精确追踪所需切片，
  // 避免合并后任一无关状态变化（如其他节点 streaming）触发整个 UserBubble 重渲
  const isReferenced = useCanvasStore((s) => selectIsMessageReferencedByBranch(s, message.nodeId, message.sequence));
  const isNodeStreaming = useCanvasStore((s) => s.streamingByNode[message.nodeId] === 'streaming');

  // 80ms hover 延迟避免快速划过时按钮闪烁（与 AssistantBubble 的分支按钮同款手感）
  useEffect(() => {
    if (!hover) {
      setShowEditBtn(false);
      return;
    }
    const t = setTimeout(() => setShowEditBtn(true), 80);
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
        {showEditBtn && (
          <EditButton onEdit={startEdit} disabled={editDisabled} disabledTooltip={disabledTooltip} />
        )}
      </div>
    </div>
  );
}

// ✎ 编辑按钮：与 AssistantBubble 的分支按钮镜像（左下 vs 右下），保持气泡尾部干净
function EditButton({ onEdit, disabled, disabledTooltip }: { onEdit: () => void; disabled: boolean; disabledTooltip: string }) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        onEdit();
      }}
      title={disabled ? disabledTooltip : '编辑此消息并重新生成 AI 回复'}
      disabled={disabled}
      style={{ position: 'absolute', left: 0, bottom: -8, ...pillPrimary(disabled) }}
    >
      ✎ 编辑
    </button>
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

// 助手气泡：含 AgentTrace / Reasoning / 启动提示 / 流式光标 / 分支按钮 / 复制按钮。
// hover 状态本身只影响"分支按钮 / 复制按钮显隐"，封装在此组件内部，避免污染 UserBubble。
function AssistantBubble({ message, onBranch, fontSize, maxWidth }: AssistantBubbleProps) {
  const [hover, setHover] = useState(false);
  // hover 触发后需等 80ms 延迟计时器到期才翻 true，以过滤快速划过的误触
  const [hoverDelayElapsed, setHoverDelayElapsed] = useState(false);
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
  // 消息完成 + 延迟到期 双重守卫：streaming 中途不应显示复制/分支按钮
  const showHoverControls = message.status === 'complete' && hoverDelayElapsed;

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
      {message.status === 'complete' && (
        <BranchBadge nodeId={message.nodeId} sequence={message.sequence} />
      )}
      {/* 复制按钮：与 UserBubble 编辑按钮位置对称（左下）。当该消息已派生分支（BranchBadge 占据
          left:0）时往右让位，避免 hover 时遮挡常驻的分支徽章。 */}
      {showHoverControls && <CopyButton content={message.content} hasBranchBadge={hasBranches} />}
      {showHoverControls && <BranchButton onBranch={onBranch} />}
    </div>
  );
}

// 📋 复制按钮：与 EditButton 镜像同款胶囊；点击调原生剪贴板 API（保留 markdown 原文），
// 失败回退到 execCommand 兜底，避免 Electron 非安全上下文（如 file:// 协议）下的可用性差异。
// hasBranchBadge=true 时 left 右移 56px，为常驻的 BranchBadge 腾出空间。
function CopyButton({ content, hasBranchBadge }: { content: string; hasBranchBadge: boolean }) {
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        copyViaExecCommand(content);
      }
      toast.success('已复制');
    } catch {
      try {
        copyViaExecCommand(content);
        toast.success('已复制');
      } catch {
        toast.error('复制失败');
      }
    }
  };
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={handleCopy}
      title="复制此消息原文（保留 markdown）"
      style={{ position: 'absolute', left: hasBranchBadge ? 56 : 0, bottom: -8, ...pillPrimaryDefault }}
    >
      📋 复制
    </button>
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

// 父节点视角的"已派生 N 个分支"徽章。常驻显示（不依赖 hover），
// 点击展开浮层列出所有子分支节点，点击条目切换活跃节点到该子节点。
// 浮层用 popover 而非 tooltip，是因为同消息可能派生多条，需要让用户在多个目标间挑选。
function BranchBadge({ nodeId, sequence }: { nodeId: string; sequence: number }) {
  const branches = useCanvasStore((s) => selectBranchesFromMessage(s, nodeId, sequence));
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 浮层打开时监听全局 pointerdown，点击容器外即关闭——避免遮挡画布操作
  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  if (branches.length === 0) return null;

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', left: 0, bottom: -8 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={`已派生 ${branches.length} 个分支`}
        style={{
          ...pillBase,
          color: '#6366f1',
          background: '#EEF2FF',
          border: '1px solid #c7d2fe',
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        ⑂ {branches.length}
      </button>
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
                // 通过 getState() 按需读取避免订阅整个 messages 字典导致任意消息更新都重渲 BranchBadge
                const allMessages = useCanvasStore.getState().messages;
                const firstMsg = Object.values(allMessages)
                  .filter((m) => m.nodeId === childNode.id)
                  .sort((a, b) => a.sequence - b.sequence)[0];
                focusNodeOnMessage(childNode.id, firstMsg?.id ?? null);
                setOpen(false);
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

function BranchButton({ onBranch }: { onBranch: () => void }) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onBranch();
      }}
      style={{ position: 'absolute', right: 0, bottom: -8, ...pillPrimaryDefault }}
    >
      ↳ 从这里分支
    </button>
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
