import type { Node } from '../types';

// 节点尺寸的单一事实来源。
// 渲染层（Node.tsx）与几何层（edge-geometry.ts）必须共用这里的常量，
// 历史教训：折叠卡新增"分支自《》"行后渲染高度从 68 → 88，但几何层
// 单独维护的常量没跟上，导致连线锚点落入卡片内、曲线穿过其他卡片正面。
// 任何会改变折叠卡视觉高度的改动都必须同时更新此文件并跑单测兜底。

export const EXPANDED_NODE_W = 360;
export const EXPANDED_NODE_H = 200;
export const COLLAPSED_NODE_W = 200;

// 折叠态对话节点：两行布局 68px；带"分支自《》"来源行的三行布局 88px。
export const COLLAPSED_DIALOGUE_BASE_H = 68;
export const COLLAPSED_DIALOGUE_WITH_SOURCE_H = 88;

// 折叠态提炼节点：两行固定布局。
export const COLLAPSED_REFINED_H = 72;

export function getCollapsedDialogueHeight(hasBranchSource: boolean): number {
  return hasBranchSource ? COLLAPSED_DIALOGUE_WITH_SOURCE_H : COLLAPSED_DIALOGUE_BASE_H;
}

// 节点尺寸：展开态全类型相同；折叠态按 type + hasBranchSource 区分。
// hasBranchSource 不在 Node 接口上（它派生自 edges 表中本节点的 branch 入边），
// 必须由调用方查 store 后传入。
//
// refined 分支有意忽略 hasBranchSource：当前折叠态提炼卡片（CollapsedRefinedCard）
// 不渲染"分支自《》"来源行，所以即使该提炼节点存在 branch 入边，渲染高度仍是
// COLLAPSED_REFINED_H = 72。若未来给折叠提炼卡补上来源行渲染，必须同时把该参数
// 透传到此分支并新增对应高度常量，否则连线锚点会再次与卡片底边错位。
export function getNodeSize(node: Node, hasBranchSource: boolean): { w: number; h: number } {
  if (!node.collapsed) return { w: EXPANDED_NODE_W, h: EXPANDED_NODE_H };
  if (node.type === 'refined') return { w: COLLAPSED_NODE_W, h: COLLAPSED_REFINED_H };
  return { w: COLLAPSED_NODE_W, h: getCollapsedDialogueHeight(hasBranchSource) };
}
