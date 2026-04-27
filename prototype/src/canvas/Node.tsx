import { useState } from 'react';
import { useCanvasStore, selectMessagesOfNode, selectBranchSourceOfNode } from '../store/canvasStore';
import { api } from '../api/client';
import type { Node as NodeType, Message } from '../types';
import { NodeChatPanel } from './NodeChatPanel';
import { performRetryRefine, focusNodeOnMessage } from './nodeActions';
import { useTitleRegeneration } from './useTitleRegeneration';

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
      <NodeHeader
        node={node}
        isRefined={isRefined}
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
  isStreaming: boolean;
  isActive: boolean;
  onPointerDownHeader: (e: React.PointerEvent, nodeId: string) => void;
  onRetryRefine: () => void;
  onFold: () => void;
  onOpenFullscreen: () => void;
}

function NodeHeader({ node, isRefined, isStreaming, isActive, onPointerDownHeader, onRetryRefine, onFold, onOpenFullscreen }: NodeHeaderProps) {
  const [hovered, setHovered] = useState(false);
  const headerBg = isRefined ? '#F5E2C0' : '#FAFAF7';
  const headerBorder = isRefined ? '#EAD4A8' : '#EFEDE5';
  const headerTextColor = isRefined ? '#412402' : '#475569';
  const iconColor = isRefined ? '#BA7517' : '#94a3b8';
  const fallbackTitle = isRefined ? '提炼节点' : '新节点';

  return (
    <div
      data-drag-handle
      onPointerDown={(e) => onPointerDownHeader(e, node.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
      <span style={{ fontSize: 13, color: iconColor }}>{isRefined ? '◆' : '💬'}</span>
      <span style={{ flex: 1, fontWeight: 500, color: headerTextColor, fontSize: 14, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
        {node.title ?? fallbackTitle}
      </span>
      {/* 仅对话节点 + hover 时显示标题刷新按钮（提炼节点的 title 由系统定值，不参与重新生成）*/}
      {!isRefined && hovered && !isStreaming && (
        <RegenerateTitleButton nodeId={node.id} />
      )}
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
        onClick={(e) => { e.stopPropagation(); onOpenFullscreen(); }}
        style={iconBtn}
        title="展开为大屏对话框"
      >
        ⛶
      </button>
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

/**
 * 标题刷新按钮：用户点击主动触发标题重新生成（替代旧的"按对话轮数自动触发"）。
 *
 * 视觉与交互：
 * - 父容器 hover 时才挂载（由调用方控制）；置于标题文本右侧、状态徽章左侧
 * - loading 期间按钮 disabled + 旋转动画，避免重复点击
 * - 失败时由 performRegenerateTitle 内部 toast 提示，按钮自身只负责状态切换
 */
function RegenerateTitleButton({ nodeId }: { nodeId: string }) {
  const { loading, trigger } = useTitleRegeneration(nodeId);
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={trigger}
      disabled={loading}
      style={{ ...iconBtn, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.5 : 1 }}
      title={loading ? '生成中…' : '重新生成标题'}
    >
      <span style={{ display: 'inline-block', animation: loading ? 'spin 1s linear infinite' : 'none' }}>↻</span>
    </button>
  );
}

// 注入旋转动画 keyframes（仅一次）。放在模块级而非组件内，避免每次渲染重复 append。
if (typeof document !== 'undefined' && !document.getElementById('node-title-spin-keyframes')) {
  const styleEl = document.createElement('style');
  styleEl.id = 'node-title-spin-keyframes';
  styleEl.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
  document.head.appendChild(styleEl);
}

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
  gap: 4,
};

// 状态徽章：流式 ● / 活跃 ● 活跃中（互斥）
function StatusBadge({ isStreaming, isActive }: { isStreaming: boolean; isActive: boolean }) {
  if (isStreaming) return <span style={{ fontSize: 10, color: '#185FA5' }}>●</span>;
  if (isActive) return <span style={{ fontSize: 11, color: '#185FA5' }}>● 活跃中</span>;
  return null;
}

// 折叠态对话节点（按文档 §2.1）：meta "对话 · N 轮" / title / 可选"分支自..."来源行
function CollapsedDialogueCard({ node, isStreaming, isActive, styleBase, messageCount, onPointerDownHeader }: CollapsedCardProps) {
  const [hovered, setHovered] = useState(false);
  const roundCount = Math.max(0, Math.ceil(messageCount / 2));
  const title = node.title ?? '新节点';
  const branchSource = useCanvasStore((s) => selectBranchSourceOfNode(s, node.id));
  const hasSource = !!branchSource;
  // 三行卡（多了来源行）需要更高的高度避免内容裁切
  const cardHeight = hasSource ? 76 : 56;
  return (
    <div
      style={{ ...styleBase, ...collapsedShellBase, width: 200, height: cardHeight }}
      onPointerDown={(e) => onPointerDownHeader(e, node.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#94a3b8', fontWeight: 400 }}>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>💬</span>
        <span style={{ flex: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{`对话 · ${roundCount} 轮`}</span>
        <StatusBadge isStreaming={isStreaming} isActive={isActive} />
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: '#1e293b', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
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
          fontSize: 11,
          color: '#6366f1',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
        }}
      >
        ↳ 分支自《{parentTitle}》
      </div>
    );
  }

  return (
    <div
      onPointerDown={stopEventPropagation}
      onClick={handleClick}
      title="点击跳转到父节点"
      style={{
        padding: '6px 12px',
        background: '#EEF2FF',
        borderBottom: '0.5px solid #C7D2FE',
        fontSize: 12,
        color: '#4F46E5',
        cursor: 'pointer',
        display: 'flex',
        gap: 6,
        alignItems: 'baseline',
      }}
    >
      <span style={{ flexShrink: 0 }}>↳ 分支自《{parentTitle}》第 {sourceMessage.sequence + 1} 条</span>
      <span
        style={{
          flex: 1,
          color: '#6366f1',
          opacity: 0.8,
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
