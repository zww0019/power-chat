import { useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../store/canvasStore';

// 画布右下角的全局预览小视窗：
// - 节点矩形（按位置/尺寸缩放，颜色区分对话/提炼/活跃/折叠）
// - 当前视口框（半透明描边矩形）
// - 点击 minimap 任意位置 → 视口居中跳转到对应逻辑坐标
// - 拖拽视口框 → 实时同步画布视口
//
// 不显示 edge：小尺寸下视觉收益低（按规划阶段决策 ②）。
// 不参与画布 transform，position:fixed 锁右下角。

const MINIMAP_W = 180;
const MINIMAP_H = 120;
// 逻辑坐标 padding：bbox 外扩，避免节点贴 minimap 边缘
const LOGICAL_PADDING = 80;

export function Minimap() {
  const nodes = useCanvasStore((s) => s.nodes);
  const canvas = useCanvasStore((s) => s.canvas);
  const activeNodeId = useCanvasStore((s) => s.activeNodeId);
  const setViewport = useCanvasStore((s) => s.setViewport);

  // 跟踪窗口尺寸：viewport 的逻辑可见范围 = (winW/zoom, winH/zoom)，
  // 必须感知窗口变化才能让视口框尺寸正确。
  const [winSize, setWinSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const vx = canvas?.viewportX ?? 0;
  const vy = canvas?.viewportY ?? 0;
  const zoom = canvas?.viewportZoom ?? 1;

  // 视口在画布逻辑坐标系的覆盖范围
  // 屏幕点 (sx, sy) → 逻辑点 ((sx - vx)/zoom, (sy - vy)/zoom)
  const viewLogicalX = -vx / zoom;
  const viewLogicalY = -vy / zoom;
  const viewLogicalW = winSize.w / zoom;
  const viewLogicalH = winSize.h / zoom;

  // bbox = 所有节点的逻辑包围盒 ∪ 视口逻辑范围（保证视口框始终在 minimap 内）
  // nodeEstimates 在 bbox 计算和 SVG 渲染两处都需要宽高，提前算好避免重复。
  const allNodes = Object.values(nodes);
  const nodeEstimates = allNodes.map((n) => ({
    node: n,
    // 折叠态约 200×60，展开态宽 360 / 高度受内容影响估 360（minimap 比例不敏感）
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
  // 居中：minimap 容器内的等比留白
  const offsetX = (MINIMAP_W - bboxW * scale) / 2;
  const offsetY = (MINIMAP_H - bboxH * scale) / 2;

  // 视口框在 minimap 坐标系内的位置与尺寸，事件处理和 SVG 渲染共用，避免重复计算。
  const vpRectX = (viewLogicalX - minX) * scale + offsetX;
  const vpRectY = (viewLogicalY - minY) * scale + offsetY;
  const vpRectW = viewLogicalW * scale;
  const vpRectH = viewLogicalH * scale;

  // 拖拽视口框：用 ref 记录起始指针位置 + 起始视口偏移
  const dragRef = useRef<{ startClientX: number; startClientY: number; startVx: number; startVy: number } | null>(null);

  // 把视口中心居中到逻辑点 (lx, ly)：
  // screenCenter = lx*zoom + newVx = winW/2 → newVx = winW/2 - lx*zoom
  const centerOn = (lx: number, ly: number) => {
    setViewport(winSize.w / 2 - lx * zoom, winSize.h / 2 - ly * zoom, zoom);
  };

  const handleMinimapPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // 命中视口框 → 进入拖拽；否则视为单击跳转
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
      // 单击跳转：以点击位置为新视口中心
      const lx = (mx - offsetX) / scale + minX;
      const ly = (my - offsetY) / scale + minY;
      centerOn(lx, ly);
    }
  };

  const handleMinimapPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // 视口框在 minimap 上的位移 (dmx, dmy) px ↔ 视口偏移 (newVx, newVy)
    // viewLogicalX = -vx/zoom；minimap 上 vp 起点 = (viewLogicalX - minX)*scale
    // 拖动 dmx px → viewLogicalX 变化 dmx/scale → vx 变化 -dmx*zoom/scale
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
        right: 16,
        bottom: 16,
        width: MINIMAP_W,
        height: MINIMAP_H,
        background: 'rgba(255, 255, 255, 0.92)',
        border: '0.5px solid #E5E3DA',
        borderRadius: 8,
        boxShadow: '0 2px 12px rgba(0, 0, 0, 0.06)',
        cursor: dragRef.current ? 'grabbing' : 'pointer',
        overflow: 'hidden',
        zIndex: 90,
        userSelect: 'none',
      }}
    >
      <svg width={MINIMAP_W} height={MINIMAP_H} style={{ display: 'block' }}>
        {nodeEstimates.map(({ node: n, w, h }) => {
          const rx = (n.positionX - minX) * scale + offsetX;
          const ry = (n.positionY - minY) * scale + offsetY;
          const rw = Math.max(2, w * scale);
          const rh = Math.max(2, h * scale);
          const isRefined = n.type === 'refined';
          const isActive = activeNodeId === n.id;
          let fill: string;
          if (isActive) fill = '#185FA5';
          else if (isRefined) fill = '#EF9F27';
          else fill = '#94a3b8';
          return (
            <rect
              key={n.id}
              x={rx}
              y={ry}
              width={rw}
              height={rh}
              fill={fill}
              opacity={isActive ? 0.9 : 0.55}
              rx={1.5}
            />
          );
        })}
        {/* 视口框 */}
        <rect
          x={vpRectX}
          y={vpRectY}
          width={Math.max(4, vpRectW)}
          height={Math.max(4, vpRectH)}
          fill="rgba(24, 95, 165, 0.08)"
          stroke="#185FA5"
          strokeWidth={1}
        />
      </svg>
    </div>
  );
}
