import type { Node } from '../types';
import { getNodeSize } from './node-dimensions';

// 边的几何计算：纯函数，无 React/SVG 依赖，便于单测。
// Edge.tsx 仅负责 SVG 渲染与命中区，几何坐标全部委托给本文件。
//
// 节点尺寸来源统一在 node-dimensions.ts。chooseAnchors 接受 sizeFn 参数，
// 由调用方注入，是为了让"折叠对话节点是否有分支来源"这一只能从 store 派生
// 的信息穿过纯函数边界，同时保持本文件不依赖 store。

export type AnchorSide = 'top' | 'right' | 'bottom' | 'left';

export interface Anchor {
  x: number;
  y: number;
  side: AnchorSide;
}

export type NodeSizeFn = (node: Node) => { w: number; h: number };

// 默认尺寸：折叠对话节点按"无分支来源"的最小高度返回。
// 仅用于调用方无法传入 sizeFn 时的保守兜底；生产渲染路径
// 由 Edge.tsx 注入查过 store 的 sizeFn，不走此默认值。
const defaultSizeFn: NodeSizeFn = (n) => getNodeSize(n, false);

export function chooseAnchors(
  parent: Node,
  child: Node,
  sizeFn: NodeSizeFn = defaultSizeFn,
): { p: Anchor; c: Anchor } {
  const pBox = sizeFn(parent);
  const cBox = sizeFn(child);
  const pcx = parent.positionX + pBox.w / 2;
  const pcy = parent.positionY + pBox.h / 2;
  const ccx = child.positionX + cBox.w / 2;
  const ccy = child.positionY + cBox.h / 2;
  const dx = ccx - pcx;
  const dy = ccy - pcy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) {
      return {
        p: { x: parent.positionX + pBox.w, y: pcy, side: 'right' },
        c: { x: child.positionX, y: ccy, side: 'left' },
      };
    }
    return {
      p: { x: parent.positionX, y: pcy, side: 'left' },
      c: { x: child.positionX + cBox.w, y: ccy, side: 'right' },
    };
  }
  if (dy >= 0) {
    return {
      p: { x: pcx, y: parent.positionY + pBox.h, side: 'bottom' },
      c: { x: ccx, y: child.positionY, side: 'top' },
    };
  }
  return {
    p: { x: pcx, y: parent.positionY, side: 'top' },
    c: { x: ccx, y: child.positionY + cBox.h, side: 'bottom' },
  };
}

export function buildBezierPath(p: Anchor, c: Anchor): string {
  const isHorizontal = p.side === 'left' || p.side === 'right';
  let c1x = p.x;
  let c1y = p.y;
  let c2x = c.x;
  let c2y = c.y;
  if (isHorizontal) {
    // k = 端点间距的一半，使控制点外推量与弦长成比例，
    // 贝塞尔切线在锚点处的斜率趋于水平，曲线自然切出后弯入对端。
    const k = Math.abs(c.x - p.x) / 2;
    const sign = p.side === 'right' ? 1 : -1;
    c1x = p.x + sign * k;
    c2x = c.x - sign * k;
  } else {
    const k = Math.abs(c.y - p.y) / 2;
    const sign = p.side === 'bottom' ? 1 : -1;
    c1y = p.y + sign * k;
    c2y = c.y - sign * k;
  }
  return `M ${p.x} ${p.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${c.x} ${c.y}`;
}
