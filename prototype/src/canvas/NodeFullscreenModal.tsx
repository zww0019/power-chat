import { useEffect, useState } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { NodeChatPanel } from './NodeChatPanel';
import { useTitleRegeneration } from './useTitleRegeneration';

// 节点大屏对话 Modal（节点的第三态 fullscreen，决策来自规划阶段）：
// - 覆盖层 Modal：半透明遮罩 + 居中容器，画布在背后保持原状
// - 关闭路径：ESC / 点遮罩 / 点 ×；关闭后 fullscreenNodeId 清空（节点保持折叠态）
// - 同时只能一个节点全屏，由 store.openFullscreen 保证
// - 内部消息区/输入区复用 NodeChatPanel（mode='fullscreen'，放开尺寸）
export function NodeFullscreenModal() {
  const fullscreenNodeId = useCanvasStore((s) => s.fullscreenNodeId);
  const node = useCanvasStore((s) => (fullscreenNodeId ? s.nodes[fullscreenNodeId] : null));
  const isStreaming = useCanvasStore((s) =>
    fullscreenNodeId ? s.streamingByNode[fullscreenNodeId] === 'streaming' : false,
  );
  const closeFullscreen = useCanvasStore((s) => s.closeFullscreen);

  // ESC 关闭。挂在 window 冒泡阶段；因为 Modal 内输入框 keydown 不会 stopPropagation ESC，
  // 所以冒泡即可覆盖所有关闭路径，无需捕获阶段。
  useEffect(() => {
    if (!fullscreenNodeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreenNodeId, closeFullscreen]);

  if (!fullscreenNodeId || !node) return null;

  const isRefined = node.type === 'refined';
  // 仅对话节点支持标题重新生成（提炼节点的 title 是系统定值，不参与）
  const canRegenerateTitle = !isRefined && !isStreaming;
  const headerBg = isRefined ? '#F5E2C0' : '#FAFAF7';
  const headerBorder = isRefined ? '#EAD4A8' : '#EFEDE5';
  const headerTextColor = isRefined ? '#412402' : '#475569';
  const iconColor = isRefined ? '#BA7517' : '#94a3b8';
  const containerBg = isRefined ? '#FAEEDA' : '#FFFFFF';
  const containerBorder = isRefined ? '1px solid #EF9F27' : '0.5px solid #E5E3DA';
  const fallbackTitle = isRefined ? '提炼节点' : '新节点';

  return (
    <div
      onClick={closeFullscreen}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(70vw, 900px)',
          height: 'min(80vh, 800px)',
          background: containerBg,
          border: containerBorder,
          borderRadius: 8,
          boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", sans-serif',
        }}
      >
        <FullscreenHeader
          headerBg={headerBg}
          headerBorder={headerBorder}
          iconColor={iconColor}
          headerTextColor={headerTextColor}
          isRefined={isRefined}
          title={node.title ?? fallbackTitle}
          isStreaming={isStreaming}
          canRegenerateTitle={canRegenerateTitle}
          nodeId={fullscreenNodeId}
          onClose={closeFullscreen}
        />
        <NodeChatPanel node={node} isStreaming={isStreaming} mode="fullscreen" />
      </div>
    </div>
  );
}

interface FullscreenHeaderProps {
  headerBg: string;
  headerBorder: string;
  iconColor: string;
  headerTextColor: string;
  isRefined: boolean;
  title: string;
  isStreaming: boolean;
  canRegenerateTitle: boolean;
  nodeId: string;
  onClose: () => void;
}

// 大屏 header：图标 + 标题 + (hover 时) 刷新按钮 + 流式徽章 + 关闭按钮。
// 拆出独立组件是为了让 hover 状态局部化（hover 状态变更不应触发整个 Modal 重渲染）。
function FullscreenHeader({
  headerBg,
  headerBorder,
  iconColor,
  headerTextColor,
  isRefined,
  title,
  isStreaming,
  canRegenerateTitle,
  nodeId,
  onClose,
}: FullscreenHeaderProps) {
  const [hovered, setHovered] = useState(false);
  const { loading, trigger: handleRegenerate } = useTitleRegeneration(nodeId);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '12px 20px',
        borderBottom: `0.5px solid ${headerBorder}`,
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        background: headerBg,
        height: 48,
        boxSizing: 'border-box',
        flex: '0 0 auto',
      }}
    >
      <span style={{ fontSize: 14, color: iconColor }}>{isRefined ? '◆' : '💬'}</span>
      <span style={{ flex: 1, fontWeight: 500, color: headerTextColor, fontSize: 16, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
        {title}
      </span>
      {canRegenerateTitle && hovered && (
        <button
          onClick={handleRegenerate}
          disabled={loading}
          title={loading ? '生成中…' : '重新生成标题'}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: loading ? 'wait' : 'pointer',
            fontSize: 16,
            color: '#94a3b8',
            width: 28,
            height: 28,
            borderRadius: 4,
            padding: 0,
            opacity: loading ? 0.5 : 1,
            lineHeight: 1,
          }}
        >
          <span style={{ display: 'inline-block', animation: loading ? 'spin 1s linear infinite' : 'none' }}>↻</span>
        </button>
      )}
      {isStreaming && <span style={{ fontSize: 12, color: '#185FA5' }}>● 思考中</span>}
      <button
        onClick={onClose}
        title="关闭大屏（ESC）"
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontSize: 18,
          color: '#94a3b8',
          width: 28,
          height: 28,
          borderRadius: 4,
          padding: 0,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}
