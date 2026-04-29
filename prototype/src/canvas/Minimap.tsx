import { useEffect, useRef, useState } from 'react';
import { Crosshair } from 'lucide-react';
import { useCanvasStore } from '../store/canvasStore';
import { computeFitToNodesViewport } from './viewport-fit';
import { color, radius, shadow } from '../styles/theme';

// 画布右下角的全局预览小视窗：
// - 节点矩形（按位置/尺寸缩放，颜色区分对话/提炼/活跃/折叠）
// - 当前视口框（半透明描边矩形）
// - 点击 minimap 任意位置 → 视口居中跳转到对应逻辑坐标
// - 拖拽视口框 → 实时同步画布视口

const MINIMAP_W = 200;
const MINIMAP_H = 132;
const LOGICAL_PADDING = 80;

export function Minimap() {
  const nodes = useCanvasStore((s) => s.nodes);
  const canvas = useCanvasStore((s) => s.canvas);
  const activeNodeId = useCanvasStore((s) => s.activeNodeId);
  const setViewport = useCanvasStore((s) => s.setViewport);

  const [winSize, setWinSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const vx = canvas?.viewportX ?? 0;
  const vy = canvas?.viewportY ?? 0;
  const zoom = canvas?.viewportZoom ?? 1;

  const viewLogicalX = -vx / zoom;
  const viewLogicalY = -vy / zoom;
  const viewLogicalW = winSize.w / zoom;
  const viewLogicalH = winSize.h / zoom;

  const allNodes = Object.values(nodes);
  const nodeEstimates = allNodes.map((n) => ({
    node: n,
    w: n.collapsed ? 200 : 360,
    h: n.collapsed ? 60 : 360,
  }));
  let minX = viewLogicalX;
  let minY = viewLogicalY;
  let maxX = viewLogicalX + viewLogicalW;
  let maxY = viewLogicalY + viewLogicalH;
  nodeEstimates.forEach(({ node: n, w, h }) => {
    if (n.positionX < minX) minX = n.positionX;
    if (n.positionY < minY) minY = n.positionY;
    if (n.positionX + w > maxX) maxX = n.positionX + w;
    if (n.positionY + h > maxY) maxY = n.positionY + h;
  });
  minX -= LOGICAL_PADDING;
  minY -= LOGICAL_PADDING;
  maxX += LOGICAL_PADDING;
  maxY += LOGICAL_PADDING;

  const bboxW = Math.max(1, maxX - minX);
  const bboxH = Math.max(1, maxY - minY);
  const scale = Math.min(MINIMAP_W / bboxW, MINIMAP_H / bboxH);
  const offsetX = (MINIMAP_W - bboxW * scale) / 2;
  const offsetY = (MINIMAP_H - bboxH * scale) / 2;

  const vpRectX = (viewLogicalX - minX) * scale + offsetX;
  const vpRectY = (viewLogicalY - minY) * scale + offsetY;
  const vpRectW = viewLogicalW * scale;
  const vpRectH = viewLogicalH * scale;

  const dragRef = useRef<{ startClientX: number; startClientY: number; startVx: number; startVy: number } | null>(null);

  const centerOn = (lx: number, ly: number) => {
    setViewport(winSize.w / 2 - lx * zoom, winSize.h / 2 - ly * zoom, zoom);
  };

  const handleMinimapPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const insideViewport = mx >= vpRectX && mx <= vpRectX + vpRectW && my >= vpRectY && my <= vpRectY + vpRectH;
    if (insideViewport) {
      dragRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startVx: vx,
        startVy: vy,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } else {
      const lx = (mx - offsetX) / scale + minX;
      const ly = (my - offsetY) / scale + minY;
      centerOn(lx, ly);
    }
  };

  const handleMinimapPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dmx = e.clientX - d.startClientX;
    const dmy = e.clientY - d.startClientY;
    setViewport(
      d.startVx - (dmx * zoom) / scale,
      d.startVy - (dmy * zoom) / scale,
      zoom,
    );
  };

  const handleMinimapPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      onPointerDown={handleMinimapPointerDown}
      onPointerMove={handleMinimapPointerMove}
      onPointerUp={handleMinimapPointerUp}
      onPointerCancel={handleMinimapPointerUp}
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        width: MINIMAP_W,
        height: MINIMAP_H,
        background: 'rgba(251, 249, 242, 0.82)',
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        border: `0.5px solid ${color.ink200}`,
        borderRadius: radius.lg,
        boxShadow: shadow.md,
        cursor: dragRef.current ? 'grabbing' : 'pointer',
        overflow: 'hidden',
        zIndex: 90,
        userSelect: 'none',
      }}
    >
      <FitToNodesButton />
      <svg width={MINIMAP_W} height={MINIMAP_H} style={{ display: 'block' }}>
        {nodeEstimates.map(({ node: n, w, h }) => {
          const rx = (n.positionX - minX) * scale + offsetX;
          const ry = (n.positionY - minY) * scale + offsetY;
          const rw = Math.max(2.5, w * scale);
          const rh = Math.max(2.5, h * scale);
          const isRefined = n.type === 'refined';
          const isActive = activeNodeId === n.id;
          let fill: string;
          if (isActive) fill = color.accent500;
          else if (isRefined) fill = color.accent300;
          else fill = color.ink400;
          return (
            <rect
              key={n.id}
              x={rx}
              y={ry}
              width={rw}
              height={rh}
              fill={fill}
              opacity={isActive ? 0.95 : 0.55}
              rx={2}
            />
          );
        })}
        {/* 视口框 */}
        <rect
          x={vpRectX}
          y={vpRectY}
          width={Math.max(4, vpRectW)}
          height={Math.max(4, vpRectH)}
          fill={`${color.accent500}15`}
          stroke={color.accent500}
          strokeWidth={1.25}
          rx={3}
        />
      </svg>
    </div>
  );
}

/**
 * minimap 右上角的"回到节点群"按钮：当用户视口漂离节点群（节点全部不在屏幕内）时，
 * 一键调用 fit-to-nodes 居中。是 fit-to-nodes 的兜底入口，与启动钩子共用同一计算函数。
 *
 * 此处显式调 setViewport（用户主动）而非 setSystemViewport：用户点击的语义就是"我想看节点"，
 * 应该把 userHasMovedViewport 置 true，避免下次启动又自动居中覆盖此次结果。
 */
function FitToNodesButton() {
  const setViewport = useCanvasStore((s) => s.setViewport);
  const [hover, setHover] = useState(false);
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const allNodes = Object.values(useCanvasStore.getState().nodes);
    if (allNodes.length === 0) return;
    const fit = computeFitToNodesViewport(allNodes, window.innerWidth, window.innerHeight);
    setViewport(fit.viewportX, fit.viewportY, fit.viewportZoom);
  };
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="回到节点群（自动居中所有节点）"
      style={{
        position: 'absolute',
        top: 6,
        right: 6,
        width: 24,
        height: 24,
        padding: 0,
        background: hover ? color.accent50 : 'rgba(255,255,255,0.7)',
        border: `0.5px solid ${color.ink200}`,
        borderRadius: radius.sm,
        cursor: 'pointer',
        color: hover ? color.accent600 : color.ink600,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1,
      }}
    >
      <Crosshair size={13} strokeWidth={1.8} />
    </button>
  );
}
