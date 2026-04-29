import type { Node, Edge } from '../types';
import { chooseAnchors, buildBezierPath } from './edge-geometry';
import { getNodeSize } from './node-dimensions';
import { useCanvasStore, selectBranchSourceOfNode } from '../store/canvasStore';
import { color } from '../styles/theme';

interface EdgeProps {
  edge: Edge;
  parent: Node;
  child: Node;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

// 边：克制视觉的 cubic bezier 平滑曲线，自适应锚点。
// 起终点与控制点几何全部委托给 edge-geometry.ts 的纯函数（便于单测）。
// PRD §3.2：克制视觉——无箭头、无彩色、无文本标签。
//
// 命中策略：双 path——透明粗 path 承担鼠标命中（pointerEvents="stroke"），
// 视觉 path 仅负责显示。父 svg 设 pointerEvents="none" 防吞背景双击。
const HITBOX_WIDTH = 14;
const DELETE_BTN_RADIUS = 10;

export function EdgeLine({ edge, parent, child, isSelected, onSelect, onDelete }: EdgeProps) {
  // 折叠态对话节点的"分支来源"行决定卡片高度（68 vs 88），从 store 派生。
  // 两个节点合并为一次订阅，避免每条边发起两次独立 selector 调用；
  // 返回原始 boolean 值，zustand 做严格相等比较，只有 true/false 真正切换时才重渲染。
  // selectBranchSourceOfNode 内部做 Object.values 全量遍历，订阅次数直接影响每帧开销。
  const { parentHasBranchSource, childHasBranchSource } = useCanvasStore((s) => ({
    parentHasBranchSource: !!selectBranchSourceOfNode(s, parent.id),
    childHasBranchSource: !!selectBranchSourceOfNode(s, child.id),
  }), (a, b) => a.parentHasBranchSource === b.parentHasBranchSource && a.childHasBranchSource === b.childHasBranchSource);
  const sizeFn = (n: Node) => getNodeSize(n, n.id === parent.id ? parentHasBranchSource : childHasBranchSource);
  const { p, c } = chooseAnchors(parent, child, sizeFn);
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
      {/* 视觉线：选中态焦糖色加粗，默认暖灰 */}
      <path
        d={path}
        fill="none"
        stroke={isSelected ? color.accent500 : color.ink300}
        strokeWidth={isSelected ? 1.75 : 1.25}
        strokeLinecap="round"
        style={{ pointerEvents: 'none', transition: 'stroke 200ms cubic-bezier(0.16, 1, 0.3, 1), stroke-width 200ms cubic-bezier(0.16, 1, 0.3, 1)' }}
      />
      {/* 选中态：边中点显示 × 删除按钮 */}
      {isSelected && (
        <g style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
          <circle
            cx={mx}
            cy={my}
            r={DELETE_BTN_RADIUS + 1}
            fill={color.accent500}
            opacity={0.18}
          />
          <circle
            cx={mx}
            cy={my}
            r={DELETE_BTN_RADIUS}
            fill={color.raised}
            stroke={color.accent500}
            strokeWidth={1.25}
            onPointerDown={(e) => {
              e.stopPropagation();
              onDelete(edge.id);
            }}
          />
          {/* lucide-X 风格：两条交叉直线，与图标系统的 stroke 视觉一致 */}
          <g
            stroke={color.accent600}
            strokeWidth={1.6}
            strokeLinecap="round"
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            <line x1={mx - 3.2} y1={my - 3.2} x2={mx + 3.2} y2={my + 3.2} />
            <line x1={mx + 3.2} y1={my - 3.2} x2={mx - 3.2} y2={my + 3.2} />
          </g>
        </g>
      )}
    </g>
  );
}
