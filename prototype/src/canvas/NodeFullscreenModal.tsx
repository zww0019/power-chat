import { useEffect, useState } from 'react';
import { X, MessageSquare, Sparkle, RotateCw } from 'lucide-react';
import { useCanvasStore } from '../store/canvasStore';
import { NodeChatPanel } from './NodeChatPanel';
import { useTitleRegeneration } from './useTitleRegeneration';
import { color, text, space, radius, shadow, font, motion } from '../styles/theme';
import { IconButton } from './_dialogPrimitives';

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
  const canRegenerateTitle = !isRefined && !isStreaming;
  const headerBg = isRefined ? color.warm : color.paper;
  const headerBorder = isRefined ? color.accent200 : color.ink200;
  const headerTextColor = isRefined ? color.accent700 : color.ink900;
  const iconColor = isRefined ? color.accent600 : color.ink600;
  const containerBg = isRefined ? color.warm : color.paper;
  const containerBorder = isRefined ? `1px solid ${color.accent300}` : `0.5px solid ${color.ink200}`;
  const fallbackTitle = isRefined ? '提炼节点' : '新节点';

  return (
    <div
      onClick={closeFullscreen}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(42, 40, 32, 0.45)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
        animation: `overlay-in ${motion.durBase}ms ${motion.easeOutSoft}`,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(72vw, 920px)',
          height: 'min(82vh, 820px)',
          background: containerBg,
          border: containerBorder,
          borderRadius: radius.xl,
          boxShadow: shadow.xl,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: font.sans,
          animation: `modal-in ${motion.durBase}ms ${motion.easeOutSoft}`,
        }}
      >
        {isRefined && (
          <div style={{ height: 3, background: `linear-gradient(90deg, ${color.accent400}, ${color.accent500})`, flexShrink: 0 }} />
        )}
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
        padding: `0 ${space.s5}px`,
        borderBottom: `0.5px solid ${headerBorder}`,
        display: 'flex',
        gap: space.s3,
        alignItems: 'center',
        background: headerBg,
        height: 60,
        boxSizing: 'border-box',
        flex: '0 0 auto',
      }}
    >
      <span style={{ display: 'inline-flex', color: iconColor }}>
        {isRefined ? <Sparkle size={20} strokeWidth={1.8} /> : <MessageSquare size={20} strokeWidth={1.6} />}
      </span>
      <span
        style={{
          flex: 1,
          fontWeight: 700,
          color: headerTextColor,
          fontSize: text.lg,
          letterSpacing: '-0.015em',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
        }}
      >
        {title}
      </span>
      {canRegenerateTitle && hovered && (
        <IconButton
          onClick={handleRegenerate}
          disabled={loading}
          title={loading ? '生成中…' : '重新生成标题'}
          size={34}
        >
          <span style={{ display: 'inline-flex', animation: loading ? 'spin 1s linear infinite' : 'none' }}>
            <RotateCw size={16} strokeWidth={1.6} />
          </span>
        </IconButton>
      )}
      {isStreaming && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: text.xs,
            fontWeight: 500,
            color: color.accent600,
            background: color.accent50,
            padding: '4px 10px',
            borderRadius: radius.pill,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: color.accent500,
              animation: 'blink 1.4s ease-in-out infinite',
            }}
          />
          思考中
        </span>
      )}
      <IconButton onClick={onClose} title="关闭大屏（ESC）" size={34}>
        <X size={18} strokeWidth={1.8} />
      </IconButton>
    </div>
  );
}
