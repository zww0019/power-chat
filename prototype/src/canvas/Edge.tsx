import type { Node, Edge } from '../types';
import { chooseAnchors, buildBezierPath } from './edge-geometry';

interface EdgeProps {
  edge: Edge;
  parent: Node;
  child: Node;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

// 边：细灰色 cubic bezier 平滑曲线，自适应锚点。
// 起终点与控制点几何全部委托给 edge-geometry.ts 的纯函数（便于单测）。
// PRD §3.2：克制视觉——无箭头、无彩色、无文本标签。
//
// 命中策略：双 path——透明粗 path 承担鼠标命中（pointerEvents="stroke"），
// 视觉 path 仅负责显示。父 svg 设 pointerEvents="none" 防吞背景双击。
const HITBOX_WIDTH = 14;
const DELETE_BTN_RADIUS = 9;

export function EdgeLine({ edge, parent, child, isSelected, onSelect, onDelete }: EdgeProps) {
  const { p, c } = chooseAnchors(parent, child);
  const path = buildBezierPath(p, c);
  const mx = (p.x + c.x) / 2;
  const my = (p.y + c.y) / 2;

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
