import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { useCanvasStore, selectMessagesOfNode } from '../store/canvasStore';
import type { Node as NodeType, Message } from '../types';
import { RefinedContent } from './RefinedContent';
import { MarkdownContent } from './MarkdownContent';
import { AgentTrace } from './AgentTrace';
import { performSendMessage, performBranch, performAbort } from './nodeActions';

// inline：节点展开态内嵌（高度上限 480px，宽度跟随 360px 节点）；
// fullscreen：大屏 Modal（高度 flex 占满 Modal 内容区，宽度由 Modal 容器决定）。
type ChatMode = 'inline' | 'fullscreen';

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
  const padding = mode === 'fullscreen' ? '12px 24px' : '8px 12px';
  const fontSize = mode === 'fullscreen' ? 14 : 13;
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
  const fontSize = mode === 'fullscreen' ? 14 : 13;
  const maxWidth = mode === 'fullscreen' ? '78%' : '94%';
  if (message.role === 'user') {
    return <UserBubble content={message.content} fontSize={fontSize} maxWidth={maxWidth} />;
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

function UserBubble({ content, fontSize, maxWidth }: { content: string; fontSize: number; maxWidth: string }) {
  return (
    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <div
        style={{
          maxWidth,
          background: '#eef2ff',
          color: '#1e293b',
          padding: '6px 10px',
          borderRadius: 6,
          fontSize,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
        }}
      >
        {content}
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

// 助手气泡：含 AgentTrace / Reasoning / 启动提示 / 流式光标 / 分支按钮。
// hover 状态本身只影响"分支按钮显隐"，封装在此组件内部，避免污染 UserBubble。
function AssistantBubble({ message, onBranch, fontSize, maxWidth }: AssistantBubbleProps) {
  const [hover, setHover] = useState(false);
  const [showBranchBtn, setShowBranchBtn] = useState(false);

  // 80ms hover 延迟避免快速划过时按钮闪烁（视觉规范文档"微交互手感"建议）
  useEffect(() => {
    if (!hover) {
      setShowBranchBtn(false);
      return;
    }
    const timer = setTimeout(() => setShowBranchBtn(true), 80);
    return () => clearTimeout(timer);
  }, [hover]);

  const hasReasoning = !!message.reasoningContent && message.reasoningContent.length > 0;
  const hasAgentTrace = !!message.agentTrace && message.agentTrace.length > 0;
  const isStreaming = message.status === 'streaming';
  // 启动过渡（文档 §4.5）：streaming 已开始但 content/reasoning/trace 全空的瞬间
  // 显示"AI 正在准备工具调用…"，让用户对按下 Enter 后的等待有明确反馈
  const showStartupHint = isStreaming && !hasAgentTrace && !hasReasoning && !message.content;
  const showBranchControl = message.status === 'complete' && showBranchBtn;

  return (
    <div
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
          lineHeight: 1.6,
        }}
      >
        <MarkdownContent content={message.content} isStreaming={isStreaming} />
        {isStreaming && <span style={{ color: '#6366f1', marginLeft: 2 }}>▍</span>}
      </div>
      {showBranchControl && <BranchButton onBranch={onBranch} />}
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
      style={{
        position: 'absolute',
        right: 0,
        bottom: -8,
        fontSize: 11,
        color: '#6366f1',
        background: '#ffffff',
        border: '1px solid #c7d2fe',
        padding: '2px 8px',
        borderRadius: 12,
        cursor: 'pointer',
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
      }}
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
          <div style={{ marginTop: 4, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {content}
          </div>
        </>
      ) : (
        <span>💭 思考过程（点击展开）</span>
      )}
    </div>
  );
}
