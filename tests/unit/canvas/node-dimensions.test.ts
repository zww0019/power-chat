import { describe, it, expect } from 'vitest';
import type { Node } from '../../../src/types';
import {
  getNodeSize,
  getCollapsedDialogueHeight,
  EXPANDED_NODE_W,
  EXPANDED_NODE_H,
  COLLAPSED_NODE_W,
  COLLAPSED_DIALOGUE_BASE_H,
  COLLAPSED_DIALOGUE_WITH_SOURCE_H,
  COLLAPSED_REFINED_H,
} from '../../../prototype/src/canvas/node-dimensions';

function makeNode(overrides: Partial<Node>): Node {
  return {
    id: 'n',
    canvasId: 'c',
    type: 'dialogue',
    positionX: 0,
    positionY: 0,
    width: 360,
    collapsed: false,
    title: null,
    createdAt: '',
    updatedAt: '',
    lastFocusedAt: null,
    ...overrides,
  };
}

describe('getCollapsedDialogueHeight', () => {
  it('无分支来源：返回基础高度 68', () => {
    expect(getCollapsedDialogueHeight(false)).toBe(COLLAPSED_DIALOGUE_BASE_H);
    expect(getCollapsedDialogueHeight(false)).toBe(68);
  });

  it('带分支来源：返回三行高度 88', () => {
    expect(getCollapsedDialogueHeight(true)).toBe(COLLAPSED_DIALOGUE_WITH_SOURCE_H);
    expect(getCollapsedDialogueHeight(true)).toBe(88);
  });
});

describe('getNodeSize', () => {
  it('展开态对话节点：360 × 200', () => {
    const n = makeNode({ collapsed: false, type: 'dialogue' });
    expect(getNodeSize(n, false)).toEqual({ w: EXPANDED_NODE_W, h: EXPANDED_NODE_H });
  });

  it('展开态提炼节点：360 × 200（与对话节点一致）', () => {
    const n = makeNode({ collapsed: false, type: 'refined' });
    expect(getNodeSize(n, false)).toEqual({ w: EXPANDED_NODE_W, h: EXPANDED_NODE_H });
  });

  it('展开态时 hasBranchSource 不影响尺寸', () => {
    const n = makeNode({ collapsed: false, type: 'dialogue' });
    expect(getNodeSize(n, true)).toEqual(getNodeSize(n, false));
  });

  it('折叠对话节点（无来源行）：200 × 68', () => {
    const n = makeNode({ collapsed: true, type: 'dialogue' });
    expect(getNodeSize(n, false)).toEqual({ w: COLLAPSED_NODE_W, h: COLLAPSED_DIALOGUE_BASE_H });
  });

  it('折叠对话节点（带来源行）：200 × 88', () => {
    const n = makeNode({ collapsed: true, type: 'dialogue' });
    expect(getNodeSize(n, true)).toEqual({ w: COLLAPSED_NODE_W, h: COLLAPSED_DIALOGUE_WITH_SOURCE_H });
  });

  it('折叠提炼节点：200 × 72，hasBranchSource 不影响（无来源行）', () => {
    const n = makeNode({ collapsed: true, type: 'refined' });
    expect(getNodeSize(n, false)).toEqual({ w: COLLAPSED_NODE_W, h: COLLAPSED_REFINED_H });
    expect(getNodeSize(n, true)).toEqual({ w: COLLAPSED_NODE_W, h: COLLAPSED_REFINED_H });
  });
});

// 不变式守卫：渲染层 Node.tsx 与几何层 edge-geometry.ts 必须共用这里的常量。
// 上次走丢就是因为两份高度数字独立维护——加这条断言可视化锁定数字本身，
// 任何一方未来再被独立调整都会让此测试 fail，强制人工对齐。
describe('折叠节点高度常量锁定（避免重复走丢）', () => {
  it('折叠对话节点基础高度 = 68', () => {
    expect(COLLAPSED_DIALOGUE_BASE_H).toBe(68);
  });
  it('折叠对话节点带来源行高度 = 88', () => {
    expect(COLLAPSED_DIALOGUE_WITH_SOURCE_H).toBe(88);
  });
  it('折叠提炼节点高度 = 72', () => {
    expect(COLLAPSED_REFINED_H).toBe(72);
  });
});
