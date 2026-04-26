import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { useCanvasStore, selectMessagesOfNode } from '../store/canvasStore';
import { api } from '../api/client';
import type { Node as NodeType, Message } from '../types';
import { RefinedContent } from './RefinedContent';
import { MarkdownContent } from './MarkdownContent';
import { AgentTrace } from './AgentTrace';
import { performSendMessage, performBranch, performRetryRefine, performAbort } from './nodeActions';

interface NodeProps {
  node: NodeType;
  isActive: boolean;
  isSelected: boolean;
  isStreaming: boolean;
  dimmed: boolean; // 焦点对比：当画布存在 active node 时，其他节点 opacity 0.9
  onPointerDownHeader: (e: React.PointerEvent, nodeId: string) => void;
}

/**
 * 计算节点外框的 CSSProperties。配色与几何严格遵守 R013 视觉硬约束。
 * 优先级：active > selected > refined > 默认。
 * - 边框 0.5px（默认/refined）/ 2px（active/selected）；过渡 150ms
 * - 配色 token 取自视觉规范文档 §二
 * - 折叠态宽 200 / 展开态宽 360（由调用方覆写 width）
 */
function buildNodeStyle(node: NodeType, isActive: boolean, isSelected: boolean, dimmed: boolean): React.CSSProperties {
  const isRefined = node.type === 'refined';
  let border: string;
  if (isActive) border = '2px solid #185FA5';        // 深蓝活跃
  else if (isSelected) border = '2px solid #a78bfa'; // 紫色多选（与边删除选中态共用紫色）
  else if (isRefined) border = '1px solid #EF9F27';  // 提炼节点琥珀
  else border = '0.5px solid #E5E3DA';               // 对话节点浅灰

  return {
    position: 'absolute',
    left: node.positionX,
    top: node.positionY,
    width: 360,
    background: isRefined ? '#FAEEDA' : '#FFFFFF',
    border,
    borderRadius: 8,
    boxShadow: isActive ? '0 4px 16px rgba(24,95,165,0.12)' : '0 1px 3px rgba(0,0,0,0.03)',
    opacity: dimmed ? 0.9 : 1,
    transformOrigin: 'top left',
    transition: 'border-color 150ms ease, border-width 150ms ease, opacity 150ms ease, box-shadow 150ms ease',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", sans-serif',
    fontSize: 13,
    overflow: 'hidden',
  };
}

// 单个节点的 UI。PRD §5：
// - 对话节点：白底、细灰色边框、左上角对话气泡图标
// - 提炼节点：浅米色背景、稍粗边框、棱形图标
// - 活跃节点：淡蓝边框、103% 放大、其他节点 90% 透明度
//
// 主组件只负责"折叠/展开"分支，具体实现下沉到 CollapsedCard / ExpandedNodeView。
export function CanvasNode({ node, isActive, isSelected, isStreaming, dimmed, onPointerDownHeader }: NodeProps) {
  const messages = useCanvasStore((s) => selectMessagesOfNode(s, node.id));
  const isRefined = node.type === 'refined';
  const styleBase = buildNodeStyle(node, isActive, isSelected, dimmed);

  if (node.collapsed) {
    return (
      <CollapsedCard
        node={node}
        isRefined={isRefined}
        isStreaming={isStreaming}
        isActive={isActive}
        styleBase={styleBase}
        messageCount={messages.length}
        onPointerDownHeader={onPointerDownHeader}
      />
    );
  }

  return (
    <ExpandedNodeView
      node={node}
      isActive={isActive}
      isStreaming={isStreaming}
      isRefined={isRefined}
      messages={messages}
      styleBase={styleBase}
      onPointerDownHeader={onPointerDownHeader}
    />
  );
}

interface ExpandedNodeViewProps {
  node: NodeType;
  isActive: boolean;
  isStreaming: boolean;
  isRefined: boolean;
  messages: Message[];
  styleBase: React.CSSProperties;
  onPointerDownHeader: (e: React.PointerEvent, nodeId: string) => void;
}

// 展开态：header + 内容区（对话/提炼分支）+ 输入区。
// 单独成组件而非内联在 CanvasNode：CanvasNode 同时持有折叠态和展开态分支，
// 内联会让 useState/useRef/useEffect 在折叠态也被创建，造成无用的 hook 开销；
// 抽出后 React 只在展开态挂载此组件，折叠态不会执行任何 hook。
function ExpandedNodeView({
  node,
  isActive,
  isStreaming,
  isRefined,
  messages,
  styleBase,
  onPointerDownHeader,
}: ExpandedNodeViewProps) {
  const updateNode = useCanvasStore((s) => s.updateNode);
  const setActiveNode = useCanvasStore((s) => s.setActiveNode);

  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 提取到 useCallback 外，避免每次渲染向三个子组件各自传入新 inline 函数对象
  const handleActivate = useCallback(() => setActiveNode(node.id), [setActiveNode, node.id]);

  // 活跃节点自动 focus 输入框
  useEffect(() => {
    if (isActive && !isStreaming && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isActive, isStreaming]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft('');
    await performSendMessage(node.id, text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行（OpenAI 风格）
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFold = () => {
    updateNode(node.id, { collapsed: true });
    api.updateNode(node.id, { collapsed: true }).catch(() => {});
  };

  return (
    <div style={styleBase}>
      <NodeHeader
        node={node}
        isRefined={isRefined}
        isStreaming={isStreaming}
        isActive={isActive}
        onPointerDownHeader={onPointerDownHeader}
        onRetryRefine={() => performRetryRefine(node.id)}
        onFold={handleFold}
      />
      {isRefined ? (
        <RefinedNodeBody messages={messages} onActivate={handleActivate} />
      ) : (
        <DialogueNodeBody node={node} messages={messages} onActivate={handleActivate} />
      )}
      <NodeFooter
        isRefined={isRefined}
        isStreaming={isStreaming}
        draft={draft}
        setDraft={setDraft}
        handleKeyDown={handleKeyDown}
        onActivate={handleActivate}
        inputRef={inputRef}
      />
    </div>
  );
}

interface NodeHeaderProps {
  node: NodeType;
  isRefined: boolean;
  isStreaming: boolean;
  isActive: boolean;
  onPointerDownHeader: (e: React.PointerEvent, nodeId: string) => void;
  onRetryRefine: () => void;
  onFold: () => void;
}

function NodeHeader({ node, isRefined, isStreaming, isActive, onPointerDownHeader, onRetryRefine, onFold }: NodeHeaderProps) {
  const headerBg = isRefined ? '#F5E2C0' : '#FAFAF7';
  const headerBorder = isRefined ? '#EAD4A8' : '#EFEDE5';
  const headerTextColor = isRefined ? '#412402' : '#475569';
  const iconColor = isRefined ? '#BA7517' : '#94a3b8';
  const fallbackTitle = isRefined ? '提炼节点' : '新节点';

  return (
    <div
      data-drag-handle
      onPointerDown={(e) => onPointerDownHeader(e, node.id)}
      style={{
        padding: '8px 12px',
        borderBottom: `0.5px solid ${headerBorder}`,
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        cursor: 'grab',
        userSelect: 'none',
        background: headerBg,
        height: 36,
        boxSizing: 'border-box',
      }}
    >
      <span style={{ fontSize: 11, color: iconColor }}>{isRefined ? '◆' : '💬'}</span>
      <span style={{ flex: 1, fontWeight: 500, color: headerTextColor, fontSize: 13, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
        {node.title ?? fallbackTitle}
      </span>
      <HeaderStatusBadge isStreaming={isStreaming} isActive={isActive} expanded />
      {isRefined && !isStreaming && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRetryRefine(); }}
          style={iconBtn}
          title="重新提炼（基于相同来源节点生成一份新的提炼结果）"
        >
          ⟳
        </button>
      )}
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onFold(); }}
        style={iconBtn}
        title="折叠"
      >
        −
      </button>
    </div>
  );
}

// 展开态的状态徽章：与折叠态 StatusBadge 独立实现。
// 展开态空间充裕，streaming 时显示"思考中"文字（而非折叠态的纯 ●）。
// 两者不合并，是因为折叠态宽 200px，文字徽章会撑破布局。
function HeaderStatusBadge({ isStreaming, isActive }: { isStreaming: boolean; isActive: boolean; expanded?: boolean }) {
  if (isStreaming) return <span style={{ fontSize: 11, color: '#185FA5' }}>● 思考中</span>;
  if (isActive) return <span style={{ fontSize: 11, color: '#185FA5' }}>● 活跃中</span>;
  return null;
}

// 节点内滚动容器的 wheel 拦截：内部还能滚时阻断冒泡防止画布同时平移；
// 滚到顶/底边界时放行，让画布接管（边界穿透是常见网页交互预期）。
// 1px 容差应对亚像素滚动 / DPR 缩放导致的浮点误差。
function handleNodeWheel(e: React.WheelEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  if (e.deltaY > 0 && atBottom) return;
  if (e.deltaY < 0 && atTop) return;
  e.stopPropagation();
}

// 提炼节点正文：一条 assistant 消息走 RefinedContent 四栏切分
function RefinedNodeBody({ messages, onActivate }: { messages: Message[]; onActivate: () => void }) {
  // 从尾部向前找，避免 reverse() 创建不必要的中间数组拷贝
  let lastAssistant: Message | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') { lastAssistant = messages[i]!; break; }
  }
  return (
    <div style={{ maxHeight: 480, overflowY: 'auto' }} onClick={onActivate} onWheel={handleNodeWheel}>
      <RefinedContent message={lastAssistant} />
    </div>
  );
}

// 对话节点正文：消息列表，空态显示引导文案
function DialogueNodeBody({ node, messages, onActivate }: { node: NodeType; messages: Message[]; onActivate: () => void }) {
  return (
    <div style={{ padding: '8px 12px', maxHeight: 480, overflowY: 'auto' }} onClick={onActivate} onWheel={handleNodeWheel}>
      {messages.length === 0 && (
        <div style={{ color: '#94a3b8', fontSize: 12, fontStyle: 'italic', padding: '8px 0' }}>
          输入第一句话开始 →
        </div>
      )}
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} onBranch={() => performBranch(node.id, m.id)} />
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
}

// 输入区：对话节点和提炼节点共享，仅配色 + 提炼节点多一个 ⓘ 提示
function NodeFooter({ isRefined, isStreaming, draft, setDraft, handleKeyDown, onActivate, inputRef }: NodeFooterProps) {
  const borderColor = isRefined ? '#EAD4A8' : '#EFEDE5';
  const bg = isRefined ? '#FAEEDA' : '#FCFCFA';
  const textColor = isRefined ? '#412402' : '#1e293b';
  const placeholder = isStreaming ? 'AI 正在回复…' : '继续这个对话…';

  return (
    <div style={{ borderTop: `0.5px solid ${borderColor}`, padding: '8px 12px', display: 'flex', alignItems: 'flex-end', gap: 6, background: bg }}>
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
        rows={2}
        style={{
          flex: 1,
          border: 'none',
          outline: 'none',
          resize: 'none',
          fontSize: 13,
          fontFamily: 'inherit',
          background: 'transparent',
          color: textColor,
        }}
      />
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontSize: 13,
  color: '#94a3b8',
  width: 22,
  height: 22,
  borderRadius: 4,
  padding: 0,
};

interface CollapsedCardProps {
  node: NodeType;
  isRefined: boolean;
  isStreaming: boolean;
  isActive: boolean;
  styleBase: React.CSSProperties;
  messageCount: number;
  onPointerDownHeader: (e: React.PointerEvent, nodeId: string) => void;
}

// 折叠态分发：根据 isRefined 选择具体卡片实现，避免单组件承载两套配色与文案分支。
// 独立成 CollapsedCard 而非在 CanvasNode 直接三元，是为了保留一个可以加折叠
// 动画/过渡的扩展点，同时让 CanvasNode 主体只关心折叠/展开分支本身的跳转逻辑。
function CollapsedCard(props: CollapsedCardProps) {
  return props.isRefined ? <CollapsedRefinedCard {...props} /> : <CollapsedDialogueCard {...props} />;
}

// 双行布局通用样式
const collapsedShellBase: React.CSSProperties = {
  padding: '10px 12px',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 2,
};

// 状态徽章：流式 ● / 活跃 ● 活跃中（互斥）
function StatusBadge({ isStreaming, isActive }: { isStreaming: boolean; isActive: boolean }) {
  if (isStreaming) return <span style={{ fontSize: 10, color: '#185FA5' }}>●</span>;
  if (isActive) return <span style={{ fontSize: 11, color: '#185FA5' }}>● 活跃中</span>;
  return null;
}

// 折叠态对话节点（按文档 §2.1）：meta "对话 · N 轮" / title
function CollapsedDialogueCard({ node, isStreaming, isActive, styleBase, messageCount, onPointerDownHeader }: CollapsedCardProps) {
  const roundCount = Math.max(0, Math.ceil(messageCount / 2));
  const title = node.title ?? '新节点';
  return (
    <div
      style={{ ...styleBase, ...collapsedShellBase, width: 200, height: 56 }}
      onPointerDown={(e) => onPointerDownHeader(e, node.id)}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#94a3b8', fontWeight: 400 }}>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>💬</span>
        <span style={{ flex: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{`对话 · ${roundCount} 轮`}</span>
        <StatusBadge isStreaming={isStreaming} isActive={isActive} />
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, color: '#1e293b', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
        {title}
      </div>
    </div>
  );
}

// 折叠态提炼节点（按文档 §2.3）：meta "提炼·N 节点" / title
function CollapsedRefinedCard({ node, isStreaming, isActive, styleBase, messageCount, onPointerDownHeader }: CollapsedCardProps) {
  const meta = node.title ?? '提炼节点';
  const title = messageCount > 0 ? '已提炼，点击查看' : '等待提炼…';
  return (
    <div
      style={{ ...styleBase, ...collapsedShellBase, width: 200, height: 60 }}
      onPointerDown={(e) => onPointerDownHeader(e, node.id)}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#854F0B', fontWeight: 400 }}>
        <span style={{ fontSize: 11, color: '#BA7517' }}>◆</span>
        <span style={{ flex: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{meta}</span>
        <StatusBadge isStreaming={isStreaming} isActive={isActive} />
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, color: '#412402', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
        {title}
      </div>
    </div>
  );
}

interface BubbleProps {
  message: Message;
  onBranch: () => void;
}

function MessageBubble({ message, onBranch }: BubbleProps) {
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

  const isUser = message.role === 'user';
  const hasReasoning = !!message.reasoningContent && message.reasoningContent.length > 0;
  const hasAgentTrace = !!message.agentTrace && message.agentTrace.length > 0;
  const isStreaming = message.status === 'streaming';
  // 启动过渡（文档 §4.5）：streaming 已开始但 content/reasoning/trace 全空的瞬间显示
  // "AI 正在准备工具调用…"，让用户对按下 Enter 后的等待有明确反馈
  const showStartupHint =
    !isUser && isStreaming && !hasAgentTrace && !hasReasoning && !message.content;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        marginBottom: 12,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
      }}
    >
      {showStartupHint && (
        <div style={{ fontSize: 11, color: '#cbd5e1', fontStyle: 'italic', marginBottom: 4 }}>
          AI 正在准备工具调用…
        </div>
      )}
      {!isUser && hasAgentTrace && (
        <AgentTrace
          trace={message.agentTrace!}
          isStreaming={isStreaming}
          nodeId={message.nodeId}
          onAbort={performAbort}
        />
      )}
      {!isUser && hasReasoning && (
        <ReasoningBlock content={message.reasoningContent!} isStreaming={isStreaming} />
      )}
      <div
        style={{
          maxWidth: '94%',
          background: isUser ? '#eef2ff' : 'transparent',
          color: '#1e293b',
          padding: isUser ? '6px 10px' : '0',
          borderRadius: 6,
          fontSize: 13,
          lineHeight: 1.6,
          whiteSpace: isUser ? 'pre-wrap' : 'normal',
        }}
      >
        {isUser ? (
          message.content
        ) : (
          <MarkdownContent content={message.content} isStreaming={message.status === 'streaming'} />
        )}
        {message.status === 'streaming' && <span style={{ color: '#6366f1', marginLeft: 2 }}>▍</span>}
      </div>
      {!isUser && message.status === 'complete' && showBranchBtn && (
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
      )}
    </div>
  );
}

// AI reasoning（思考过程）展示块。抽出独立组件保持 MessageBubble CCN 可控。
//
// 边沿触发自动折叠（与 AgentTrace 同模式）：仅在 streaming → complete 那一次状态转换时
// 触发自动折叠定时器；避免上轮 bug——用户后续手动展开会被定时器再次吞掉。
//
// 边沿"仅触发一次"的实现细节：
// useEffect 重跑时 prevStreamingRef.current 已被本轮赋值为最新 isStreaming，
// 下一次重跑读到的 wasStreaming 取的是"上一次 effect 结束时"的值。
// 因此 streaming(true) → complete(false) 只在那次状态转换的 effect 内 wasStreaming=true，
// 之后 isStreaming 恒为 false → wasStreaming 也恒为 false，定时器不再触发。
// 用户手动展开（complete 阶段切换 expanded 状态）不会重跑此 effect（依赖只有 isStreaming）。
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
