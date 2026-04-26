import type { Node, Edge } from '../types';

interface EdgeProps {
  edge: Edge;
  parent: Node;
  child: Node;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

// 边：细灰色 cubic bezier 平滑曲线，从父节点底中心到子节点顶中心。
// 控制点放在两节点垂直中点附近，形成自然的"垂坠"曲线（视觉规范文档 §2.6）。
// PRD §3.2：克制视觉——无箭头、无彩色、无文本标签。
//
// 命中策略：双 path——透明粗 path 承担鼠标命中（pointerEvents="stroke"），
// 视觉 path 仅负责显示。父 svg 设 pointerEvents="none" 防吞背景双击。
const NODE_WIDTH = 360;
const NODE_ESTIMATED_HEIGHT = 200;
const HITBOX_WIDTH = 14;
const DELETE_BTN_RADIUS = 9;

function buildBezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

export function EdgeLine({ edge, parent, child, isSelected, onSelect, onDelete }: EdgeProps) {
  const x1 = parent.positionX + NODE_WIDTH / 2;
  const y1 = parent.positionY + NODE_ESTIMATED_HEIGHT;
  const x2 = child.positionX + NODE_WIDTH / 2;
  const y2 = child.positionY;
  const path = buildBezierPath(x1, y1, x2, y2);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  return (
    <g>
      {/* 命中区：透明加粗 path */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={HITBOX_WIDTH}
        strokeLinecap="round"
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect(edge.id);
        }}
      />
      {/* 视觉线：1px 浅灰曲线，选中时变紫 + 加粗 */}
      <path
        d={path}
        fill="none"
        stroke={isSelected ? '#a78bfa' : '#C8C6BD'}
        strokeWidth={isSelected ? 2 : 1}
        strokeLinecap="round"
        style={{ pointerEvents: 'none' }}
      />
      {/* 选中态：边中点显示 × 删除按钮 */}
      {isSelected && (
        <g style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
          <circle
            cx={mx}
            cy={my}
            r={DELETE_BTN_RADIUS}
            fill="#ffffff"
            stroke="#a78bfa"
            strokeWidth={1.5}
            onPointerDown={(e) => {
              e.stopPropagation();
              onDelete(edge.id);
            }}
          />
          <text
            x={mx}
            y={my + 1}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={11}
            fill="#7c3aed"
            fontWeight={500}
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            ×
          </text>
        </g>
      )}
    </g>
  );
}
