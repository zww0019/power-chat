// 视口自适应工具：把节点群居中到屏幕。
//
// 设计取舍：
// - zoom 固定 1：避免节点过小，启动时优先让用户认得节点，而不是看到全貌
// - 节点中心 = (positionX + 180, positionY + 120)：与 performBranch / focusNodeOnMessage 中
//   "节点中心"公式保持一致（节点逻辑宽 360 / 高约 240），三处共用同一锚点定义
// - 包围盒中心 = (minX+maxX)/2, (minY+maxY)/2：取所有节点中心的 x/y 极值平均，对单节点退化为该节点中心

import type { Node } from '../types';

const NODE_CENTER_X_OFFSET = 180;
const NODE_CENTER_Y_OFFSET = 120;

export interface FitViewport {
  viewportX: number;
  viewportY: number;
  viewportZoom: number;
}

/**
 * 计算让所有节点群居中到屏幕的视口参数。
 *
 * zoom 固定为 1（不缩小以显示全貌）：启动时优先让用户认得节点内容，而非看到整体布局。
 * 这与 Minimap 兜底按钮行为一致，两处都用 zoom=1 保持预期统一。
 *
 * @param nodes 当前画布上的所有节点（含 collapsed 与 dialogue/refined 类型）
 * @param screenW window.innerWidth
 * @param screenH window.innerHeight
 * @returns 新视口的 X/Y/Zoom；nodes 为空时返回 (0,0,1) 兜底（首次空画布的合理默认）
 */
export function computeFitToNodesViewport(
  nodes: Node[],
  screenW: number,
  screenH: number,
): FitViewport {
  if (nodes.length === 0) {
    return { viewportX: 0, viewportY: 0, viewportZoom: 1 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const cx = n.positionX + NODE_CENTER_X_OFFSET;
    const cy = n.positionY + NODE_CENTER_Y_OFFSET;
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const zoom = 1;
  return {
    viewportX: screenW / 2 - centerX * zoom,
    viewportY: screenH / 2 - centerY * zoom,
    viewportZoom: zoom,
  };
}
