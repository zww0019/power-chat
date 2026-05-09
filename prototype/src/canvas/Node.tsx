import { useState } from 'react';
import { MessageSquare, Sparkle, Feather, Maximize2, Minimize2, RotateCw, RefreshCw, CornerDownRight } from 'lucide-react';
import { useCanvasStore, selectMessagesOfNode, selectBranchSourceOfNode } from '../store/canvasStore';
import { api } from '../api/client';
import type { Node as NodeType, Message } from '../types';
import { NodeChatPanel } from './NodeChatPanel';
import { performRetryRefine, focusNodeOnMessage } from './nodeActions';
import { useTitleRegeneration } from './useTitleRegeneration';
import { color, text, space, radius, shadow, font, motion } from '../styles/theme';
import { COLLAPSED_NODE_W, COLLAPSED_REFINED_H, getCollapsedDialogueHeight } from './node-dimensions';

// 摘要长度：折叠卡/header 横幅都用同一个值。25 字在 200/360px 宽度下能容纳一行不溢出
const SOURCE_SUMMARY_MAX = 25;

/**
 * 把消息原文剥成"一行摘要"。剥离常见 markdown 噪音（标题/列表/引用/代码块标记/链接外壳），
 * 折叠空白后截断；超长时在末尾接 "…"。仅用于来源标注的视觉摘要，不影响任何持久化数据。
 */
function summarizeMessage(content: string, maxLen: number = SOURCE_SUMMARY_MAX): string {
  const stripped = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*]+\s*/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= maxLen) return stripped;
  return stripped.slice(0, maxLen) + '…';
}

interface NodeProps {
  node: NodeType;
  isActive: boolean;
  isSelected: boolean;
  isStreaming: boolean;
  dimmed: boolean; // 焦点对比：当画布存在 active node 时，其他节点 opacity 0.92
  onPointerDownHeader: (e: React.PointerEvent, nodeId: string) => void;
}

// 展开态固定宽 360，折叠态由 CollapsedCard 覆写为 200——R013 几何硬约束。
function buildNodeStyle(node: NodeType, isActive: boolean, isSelected: boolean, dimmed: boolean): React.CSSProperties {
  const isRefined = node.type === 'refined';
  const isWritten = node.type === 'written';
  let border: string;
  if (isActive) border = `1.5px solid ${color.accent500}`;
  else if (isSelected) border = `1.5px solid ${color.moss500}`;
  else if (isRefined) border = `1px solid ${color.accent300}`;
  else if (isWritten) border = `1px solid ${color.moss300}`;
  else border = `0.5px solid ${color.ink200}`;

  return {
    position: 'absolute',
    left: node.positionX,
    top: node.positionY,
    width: 360,
    background: isRefined ? color.warm : isWritten ? color.mint : color.paper,
    border,
    borderRadius: radius.lg,
    boxShadow: isActive ? shadow.lg : shadow.md,
    opacity: dimmed ? 0.92 : 1,
    // z-index: 1 让节点稳定盖在 SVG 边层（zIndex 0）之上，不依赖 DOM 顺序的隐式层叠。
    zIndex: 1,
    transformOrigin: 'top left',
    transition: `border-color ${motion.durBase}ms ${motion.easeOutSoft}, box-shadow ${motion.durBase}ms ${motion.easeOutSoft}, opacity ${motion.durBase}ms ${motion.easeOutSoft}, transform ${motion.durFast}ms ${motion.easeOutSoft}`,
    fontFamily: font.sans,
    fontSize: text.sm,
    overflow: 'hidden',
  };
}

// 主组件只负责"折叠/展开"分支，具体实现下沉到 CollapsedCard / ExpandedNodeView。
export function CanvasNode({ node, isActive, isSelected, isStreaming, dimmed, onPointerDownHeader }: NodeProps) {
  const messages = useCanvasStore((s) => selectMessagesOfNode(s, node.id));
  const isRefined = node.type === 'refined';
  const isWritten = node.type === 'written';
  const styleBase = buildNodeStyle(node, isActive, isSelected, dimmed);

  if (node.collapsed) {
    return (
      <CollapsedCard
        node={node}
        isRefined={isRefined}
        isWritten={isWritten}
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
      isWritten={isWritten}
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
  isWritten: boolean;
  styleBase: React.CSSProperties;
  onPointerDownHeader: (e: React.PointerEvent, nodeId: string) => void;
}

// 展开态：header + 内容区（对话/提炼分支）+ 输入区。
// 单独成组件而非内联在 CanvasNode：CanvasNode 同时持有折叠态和展开态分支，
// 内联会让 useState/useRef/useEffect 在折叠态也被创建，造成无用的 hook 开销；
// 抽出后 React 只在展开态挂载此组件，折叠态不会执行任何 hook。
//
// 消息列表 + 输入区由共享组件 NodeChatPanel 渲染（与大屏 Modal 共用）。
function ExpandedNodeView({
  node,
  isActive,
  isStreaming,
  isRefined,
  isWritten,
  styleBase,
  onPointerDownHeader,
}: ExpandedNodeViewProps) {
  const updateNode = useCanvasStore((s) => s.updateNode);
  const openFullscreen = useCanvasStore((s) => s.openFullscreen);
  const branchSource = useCanvasStore((s) => selectBranchSourceOfNode(s, node.id));

  const handleFold = () => {
    updateNode(node.id, { collapsed: true });
    api.updateNode(node.id, { collapsed: true }).catch(() => {});
  };

  const handleOpenFullscreen = () => {
    // 大屏 Modal 期间画布上的节点应保持折叠态（决策 F）
    updateNode(node.id, { collapsed: true });
    api.updateNode(node.id, { collapsed: true }).catch(() => {});
    openFullscreen(node.id);
  };

  return (
    <div style={styleBase}>
      {/* 提炼/撰写节点顶部饰条：3px 横条强化节点身份。提炼=焦糖渐变、撰写=薄荷渐变 */}
      {isRefined && (
        <div style={{ height: 3, background: `linear-gradient(90deg, ${color.accent400}, ${color.accent500})` }} />
      )}
      {isWritten && (
        <div style={{ height: 3, background: `linear-gradient(90deg, ${color.moss300}, ${color.moss500})` }} />
      )}
      <NodeHeader
        node={node}
        isRefined={isRefined}
        isWritten={isWritten}
        isStreaming={isStreaming}
        isActive={isActive}
        onPointerDownHeader={onPointerDownHeader}
        onRetryRefine={() => performRetryRefine(node.id)}
        onFold={handleFold}
        onOpenFullscreen={handleOpenFullscreen}
      />
      {branchSource && (
        <BranchSourceLine
          parentNode={branchSource.parentNode}
          sourceMessage={branchSource.sourceMessage}
          variant="banner"
        />
      )}
      <NodeChatPanel node={node} isStreaming={isStreaming} mode="inline" />
    </div>
  );
}

interface NodeHeaderProps {
  node: NodeType;
  isRefined: boolean;
  isWritten: boolean;
  isStreaming: boolean;
  isActive: boolean;
  onPointerDownHeader: (e: React.PointerEvent, nodeId: string) => void;
  onRetryRefine: () => void;
  onFold: () => void;
  onOpenFullscreen: () => void;
}

function NodeHeader({ node, isRefined, isWritten, isStreaming, isActive, onPointerDownHeader, onRetryRefine, onFold, onOpenFullscreen }: NodeHeaderProps) {
  const [hovered, setHovered] = useState(false);
  const headerBg = isRefined ? color.warm : isWritten ? color.mint : color.paper;
  const headerBorder = isRefined ? color.accent200 : isWritten ? color.moss200 : color.ink200;
  const headerTextColor = isRefined ? color.accent700 : isWritten ? color.moss700 : color.ink800;
  const iconColor = isRefined ? color.accent600 : isWritten ? color.moss600 : color.ink500;
  const fallbackTitle = isRefined ? '提炼节点' : isWritten ? '撰写节点' : '新节点';

  return (
    <div
      data-drag-handle
      onPointerDown={(e) => onPointerDownHeader(e, node.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: `0 ${space.s4}px`,
        borderBottom: `0.5px solid ${headerBorder}`,
        display: 'flex',
        gap: space.s2,
        alignItems: 'center',
        cursor: 'grab',
        userSelect: 'none',
        background: headerBg,
        height: 44,
        boxSizing: 'border-box',
      }}
    >
      <span style={{ display: 'inline-flex', color: iconColor }}>
        {isRefined ? (
          <Sparkle size={16} strokeWidth={1.8} />
        ) : isWritten ? (
          <Feather size={16} strokeWidth={1.8} />
        ) : (
          <MessageSquare size={16} strokeWidth={1.6} />
        )}
      </span>
      <span
        style={{
          flex: 1,
          fontWeight: 600,
          color: headerTextColor,
          fontSize: text.md,
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
        }}
      >
        {node.title ?? fallbackTitle}
      </span>
      {/* 对话/撰写节点 hover 时显示标题刷新按钮；提炼节点 title 由系统按内容定值，不开放用户重新生成 */}
      {!isRefined && hovered && !isStreaming && (
        <RegenerateTitleButton nodeId={node.id} />
      )}
      <HeaderStatusBadge isStreaming={isStreaming} isActive={isActive} expanded />
      {isRefined && !isStreaming && (
        <IconButton
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRetryRefine(); }}
          title="重新提炼（基于相同来源节点生成一份新的提炼结果）"
        >
          <RefreshCw size={15} strokeWidth={1.6} />
        </IconButton>
      )}
      <IconButton
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onOpenFullscreen(); }}
        title="展开为大屏对话框"
      >
        <Maximize2 size={15} strokeWidth={1.6} />
      </IconButton>
      <IconButton
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onFold(); }}
        title="折叠"
      >
        <Minimize2 size={15} strokeWidth={1.6} />
      </IconButton>
    </div>
  );
}

// 展开态的状态徽章：与折叠态 StatusBadge 独立实现。
// 展开态空间充裕，streaming 时显示"思考中"文字（而非折叠态的纯 ●）。
// 两者不合并，是因为折叠态宽 200px，文字徽章会撑破布局。
function HeaderStatusBadge({ isStreaming, isActive }: { isStreaming: boolean; isActive: boolean; expanded?: boolean }) {
  if (isStreaming) {
    return (
      <span style={{ ...statusBadgeBase, color: color.accent600, background: color.accent50 }}>
        <span style={{ ...statusDot, background: color.accent500, animation: 'blink 1.4s ease-in-out infinite' }} />
        思考中
      </span>
    );
  }
  if (isActive) {
    return (
      <span style={{ ...statusBadgeBase, color: color.moss600, background: 'rgba(92, 117, 86, 0.12)' }}>
        <span style={{ ...statusDot, background: color.moss500 }} />
        活跃
      </span>
    );
  }
  return null;
}

const statusBadgeBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: text.xs,
  fontWeight: 500,
  padding: '3px 8px',
  borderRadius: radius.pill,
  letterSpacing: '0.01em',
};

const statusDot: React.CSSProperties = {
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
};

// header 内的图标按钮：28×28 圆角，hover 显示暖色底色，提供更明确的可点反馈。
function IconButton({
  children,
  onClick,
  onPointerDown,
  title,
  disabled,
  hoverBg = color.ink100,
  size = 28,
}: {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  title?: string;
  disabled?: boolean;
  hoverBg?: string;
  size?: number;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onPointerDown={onPointerDown}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      disabled={disabled}
      style={{
        background: hover && !disabled ? hoverBg : 'transparent',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? color.ink300 : color.ink600,
        width: size,
        height: size,
        borderRadius: radius.sm,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

/**
 * 标题刷新按钮：用户点击主动触发标题重新生成。
 * loading 期间按钮 disabled + 旋转动画。
 */
function RegenerateTitleButton({ nodeId }: { nodeId: string }) {
  const { loading, trigger } = useTitleRegeneration(nodeId);
  return (
    <IconButton
      onPointerDown={(e) => e.stopPropagation()}
      onClick={trigger}
      disabled={loading}
      title={loading ? '生成中…' : '重新生成标题'}
    >
      <span style={{ display: 'inline-flex', animation: loading ? 'spin 1s linear infinite' : 'none' }}>
        <RotateCw size={15} strokeWidth={1.6} />
      </span>
    </IconButton>
  );
}

interface CollapsedCardProps {
  node: NodeType;
  isRefined: boolean;
  isWritten: boolean;
  isStreaming: boolean;
  isActive: boolean;
  styleBase: React.CSSProperties;
  messageCount: number;
  onPointerDownHeader: (e: React.PointerEvent, nodeId: string) => void;
}

// 折叠态分发：按节点类型选择具体卡片实现，避免单组件承载多套配色与文案分支。
// 独立成 CollapsedCard 而非在 CanvasNode 直接三元，是为了保留一个可以加折叠
// 动画/过渡的扩展点，同时让 CanvasNode 主体只关心折叠/展开分支本身的跳转逻辑。
function CollapsedCard(props: CollapsedCardProps) {
  if (props.isRefined) return <CollapsedRefinedCard {...props} />;
  if (props.isWritten) return <CollapsedWrittenCard {...props} />;
  return <CollapsedDialogueCard {...props} />;
}

// 双行布局通用样式
const collapsedShellBase: React.CSSProperties = {
  padding: `${space.s3}px ${space.s4}px`,
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 6,
};

// 状态徽章：流式 ● / 活跃 ● 活跃中（互斥）
function StatusBadge({ isStreaming, isActive }: { isStreaming: boolean; isActive: boolean }) {
  if (isStreaming) {
    return (
      <span style={{ ...statusDot, width: 7, height: 7, background: color.accent500, animation: 'blink 1.4s ease-in-out infinite' }} />
    );
  }
  if (isActive) {
    return (
      <span style={{ ...statusBadgeBase, color: color.moss600, background: 'rgba(92, 117, 86, 0.12)' }}>
        <span style={{ ...statusDot, background: color.moss500 }} />
        活跃
      </span>
    );
  }
  return null;
}

// 折叠态对话节点：meta "对话 · N 轮" / title / 可选"分支自..."来源行
function CollapsedDialogueCard({ node, isStreaming, isActive, styleBase, messageCount, onPointerDownHeader }: CollapsedCardProps) {
  const [hovered, setHovered] = useState(false);
  const roundCount = Math.max(0, Math.ceil(messageCount / 2));
  const title = node.title ?? '新节点';
  const branchSource = useCanvasStore((s) => selectBranchSourceOfNode(s, node.id));
  const hasSource = !!branchSource;
  // 高度由 node-dimensions 单一来源管理：渲染层与连线几何层共用同一个数字。
  const cardHeight = getCollapsedDialogueHeight(hasSource);
  return (
    <div
      style={{ ...styleBase, ...collapsedShellBase, width: COLLAPSED_NODE_W, height: cardHeight }}
      onPointerDown={(e) => onPointerDownHeader(e, node.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: text.xs, color: color.ink500 }}>
        <MessageSquare size={12} strokeWidth={1.8} />
        <span style={{ flex: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
          {`对话 · ${roundCount} 轮`}
        </span>
        <StatusBadge isStreaming={isStreaming} isActive={isActive} />
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span
          style={{
            flex: 1,
            fontSize: text.sm,
            fontWeight: 600,
            color: color.ink900,
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
          }}
        >
          {title}
        </span>
        {hovered && !isStreaming && <RegenerateTitleButton nodeId={node.id} />}
      </div>
      {branchSource && (
        <BranchSourceLine
          parentNode={branchSource.parentNode}
          sourceMessage={branchSource.sourceMessage}
          variant="collapsed"
        />
      )}
    </div>
  );
}

interface BranchSourceLineProps {
  parentNode: NodeType;
  sourceMessage: Message;
  // collapsed: 折叠卡内单行紧凑文本；banner: 展开态 header 下方的浅紫横幅
  variant: 'collapsed' | 'banner';
}

/**
 * 子节点视角的"分支来源"标注。
 * 点击调 focusNodeOnMessage：展开父节点（如折叠）+ 设为活跃 + pan 画布到节点 + 滚动到对应消息开头。
 * 让用户能"一键回到分支起源"而不只是把父节点设为活跃。
 * 同一组件支持折叠/展开两种视觉变体，避免双份样式漂移。
 */
// 阻止指针事件冒泡到拖拽层；不依赖任何组件状态，提升到模块级避免每次渲染重建
function stopEventPropagation(e: React.PointerEvent) {
  e.stopPropagation();
}

function BranchSourceLine({ parentNode, sourceMessage, variant }: BranchSourceLineProps) {
  const parentTitle = parentNode.title ?? '新节点';
  const summary = summarizeMessage(sourceMessage.content);
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    focusNodeOnMessage(parentNode.id, sourceMessage.id);
  };

  if (variant === 'collapsed') {
    return (
      <div
        onPointerDown={stopEventPropagation}
        onClick={handleClick}
        title={`分支自《${parentTitle}》第 ${sourceMessage.sequence + 1} 条：${summary}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: text.xs,
          color: color.moss600,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
        }}
      >
        <CornerDownRight size={12} strokeWidth={1.8} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>分支自《{parentTitle}》</span>
      </div>
    );
  }

  return (
    <div
      onPointerDown={stopEventPropagation}
      onClick={handleClick}
      title="点击跳转到父节点"
      style={{
        padding: `${space.s2}px ${space.s4}px`,
        background: 'rgba(92, 117, 86, 0.08)',
        borderBottom: `0.5px solid rgba(92, 117, 86, 0.18)`,
        fontSize: text.xs,
        color: color.moss600,
        cursor: 'pointer',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
      }}
    >
      <CornerDownRight size={13} strokeWidth={1.8} style={{ flexShrink: 0 }} />
      <span style={{ flexShrink: 0, fontWeight: 500 }}>分支自《{parentTitle}》第 {sourceMessage.sequence + 1} 条</span>
      <span
        style={{
          flex: 1,
          color: color.moss500,
          opacity: 0.85,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        · {summary}
      </span>
    </div>
  );
}

// 折叠态提炼节点：第一行显示节点标题，第二行显示状态描述
function CollapsedRefinedCard({ node, isStreaming, isActive, styleBase, messageCount, onPointerDownHeader }: CollapsedCardProps) {
  const nodeTitle = node.title ?? '提炼节点';
  const statusDesc = messageCount > 0 ? '已提炼，点击查看' : '等待提炼…';
  return (
    <div
      style={{ ...styleBase, ...collapsedShellBase, width: COLLAPSED_NODE_W, height: COLLAPSED_REFINED_H }}
      onPointerDown={(e) => onPointerDownHeader(e, node.id)}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: text.xs, color: color.accent600 }}>
        <Sparkle size={12} strokeWidth={1.8} />
        <span
          style={{
            flex: 1,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            fontWeight: 500,
          }}
        >
          {nodeTitle}
        </span>
        <StatusBadge isStreaming={isStreaming} isActive={isActive} />
      </div>
      <div
        style={{
          fontSize: text.sm,
          fontWeight: 600,
          color: color.accent700,
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
        }}
      >
        {statusDesc}
      </div>
    </div>
  );
}

// 折叠态撰写节点：双行布局对照 CollapsedRefinedCard，配色用 mint/moss 系列与提炼形成冷暖对照
function CollapsedWrittenCard({ node, isStreaming, isActive, styleBase, messageCount, onPointerDownHeader }: CollapsedCardProps) {
  const nodeTitle = node.title ?? '撰写节点';
  const statusDesc = messageCount > 0 ? '已撰写，点击查看' : '撰写中…';
  return (
    <div
      style={{ ...styleBase, ...collapsedShellBase, width: COLLAPSED_NODE_W, height: COLLAPSED_REFINED_H }}
      onPointerDown={(e) => onPointerDownHeader(e, node.id)}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: text.xs, color: color.moss600 }}>
        <Feather size={12} strokeWidth={1.8} />
        <span
          style={{
            flex: 1,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            fontWeight: 500,
          }}
        >
          {nodeTitle}
        </span>
        <StatusBadge isStreaming={isStreaming} isActive={isActive} />
      </div>
      <div
        style={{
          fontSize: text.sm,
          fontWeight: 600,
          color: color.moss700,
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
        }}
      >
        {statusDesc}
      </div>
    </div>
  );
}
