import { useEffect } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { NodeChatPanel } from './NodeChatPanel';

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
        <div
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
          <span style={{ fontSize: 13, color: iconColor }}>{isRefined ? '◆' : '💬'}</span>
          <span style={{ flex: 1, fontWeight: 500, color: headerTextColor, fontSize: 15, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
            {node.title ?? fallbackTitle}
          </span>
          {isStreaming && <span style={{ fontSize: 12, color: '#185FA5' }}>● 思考中</span>}
          <button
            onClick={closeFullscreen}
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
        <NodeChatPanel node={node} isStreaming={isStreaming} mode="fullscreen" />
      </div>
    </div>
  );
}
