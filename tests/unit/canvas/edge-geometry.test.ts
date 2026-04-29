import { describe, it, expect } from 'vitest';
import type { Node } from '../../../src/types';
import { chooseAnchors, buildBezierPath } from '../../../prototype/src/canvas/edge-geometry';
import {
  getNodeSize,
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

// 默认尺寸函数（无分支来源）：测大多数走默认路径的场景。
const noBranchSize = (n: Node) => getNodeSize(n, false);
// 带分支来源的尺寸函数：用于"折叠对话节点带来源行"场景。
const withBranchSize = (n: Node) => getNodeSize(n, true);

describe('chooseAnchors', () => {
  it('水平相邻（子在父右侧）：父右中 → 子左中', () => {
    const parent = makeNode({ positionX: 0, positionY: 0 });
    const child = makeNode({ positionX: 800, positionY: 0 });
    const { p, c } = chooseAnchors(parent, child, noBranchSize);
    expect(p).toEqual({ x: EXPANDED_NODE_W, y: EXPANDED_NODE_H / 2, side: 'right' });
    expect(c).toEqual({ x: 800, y: EXPANDED_NODE_H / 2, side: 'left' });
  });

  it('反向水平（子在父左侧）：父左中 → 子右中', () => {
    const parent = makeNode({ positionX: 800, positionY: 0 });
    const child = makeNode({ positionX: 0, positionY: 0 });
    const { p, c } = chooseAnchors(parent, child, noBranchSize);
    expect(p.side).toBe('left');
    expect(c.side).toBe('right');
    expect(p.x).toBe(800);
    expect(c.x).toBe(EXPANDED_NODE_W);
  });

  it('主垂直（子在父正下方）：父底中 → 子顶中', () => {
    const parent = makeNode({ positionX: 0, positionY: 0 });
    const child = makeNode({ positionX: 0, positionY: 600 });
    const { p, c } = chooseAnchors(parent, child, noBranchSize);
    expect(p.side).toBe('bottom');
    expect(c.side).toBe('top');
    expect(p.y).toBe(EXPANDED_NODE_H);
    expect(c.y).toBe(600);
  });

  it('反向垂直（子在父正上方）：父顶中 → 子底中', () => {
    const parent = makeNode({ positionX: 0, positionY: 600 });
    const child = makeNode({ positionX: 0, positionY: 0 });
    const { p, c } = chooseAnchors(parent, child, noBranchSize);
    expect(p.side).toBe('top');
    expect(c.side).toBe('bottom');
    expect(p.y).toBe(600);
    expect(c.y).toBe(EXPANDED_NODE_H);
  });

  it('父折叠态（无来源行）走垂直分支：底锚贴合卡片真实底边 68', () => {
    const parent = makeNode({ positionX: 0, positionY: 0, collapsed: true, type: 'dialogue' });
    const child = makeNode({ positionX: 0, positionY: 600 });
    const { p } = chooseAnchors(parent, child, noBranchSize);
    expect(p.y).toBe(COLLAPSED_DIALOGUE_BASE_H);
  });

  it('父折叠态（带来源行）走垂直分支：底锚贴合卡片真实底边 88', () => {
    const parent = makeNode({ positionX: 0, positionY: 0, collapsed: true, type: 'dialogue' });
    const child = makeNode({ positionX: 0, positionY: 600 });
    const { p } = chooseAnchors(parent, child, withBranchSize);
    expect(p.y).toBe(COLLAPSED_DIALOGUE_WITH_SOURCE_H);
  });

  it('折叠提炼节点走垂直分支：底锚贴合卡片真实底边 72', () => {
    const parent = makeNode({ positionX: 0, positionY: 0, collapsed: true, type: 'refined' });
    const child = makeNode({ positionX: 0, positionY: 600 });
    const { p } = chooseAnchors(parent, child, noBranchSize);
    expect(p.y).toBe(COLLAPSED_REFINED_H);
  });

  it('折叠态水平相邻：起点 y 居中于折叠卡片真实高度，不悬空', () => {
    // bug 现场：折叠节点用旧常量 56 算中心，但实际渲染 68。
    // 修复后：水平相邻时 y 取折叠卡真实中线 = 68/2 = 34。
    const parent = makeNode({ positionX: 0, positionY: 0, collapsed: true, type: 'dialogue' });
    const child = makeNode({ positionX: 440, positionY: 0, collapsed: true, type: 'dialogue' });
    const { p, c } = chooseAnchors(parent, child, noBranchSize);
    expect(p).toEqual({ x: COLLAPSED_NODE_W, y: COLLAPSED_DIALOGUE_BASE_H / 2, side: 'right' });
    expect(c).toEqual({ x: 440, y: COLLAPSED_DIALOGUE_BASE_H / 2, side: 'left' });
  });

  it('|dx|=|dy| 边界：归入水平分支（>= 走水平）', () => {
    const parent = makeNode({ positionX: 0, positionY: 0 });
    const child = makeNode({ positionX: 500, positionY: 500 });
    const { p } = chooseAnchors(parent, child, noBranchSize);
    expect(p.side === 'right' || p.side === 'left').toBe(true);
  });

  it('默认 sizeFn（无传入）按"无分支来源"分支返回，等价于显式传 noBranchSize', () => {
    const parent = makeNode({ positionX: 0, positionY: 0, collapsed: true, type: 'dialogue' });
    const child = makeNode({ positionX: 0, positionY: 600 });
    const withDefault = chooseAnchors(parent, child);
    const withExplicit = chooseAnchors(parent, child, noBranchSize);
    expect(withDefault).toEqual(withExplicit);
  });
});

describe('buildBezierPath', () => {
  it('水平边：控制点沿 x 轴外推 |dx|/2，y 与端点相等', () => {
    const path = buildBezierPath(
      { x: 0, y: 100, side: 'right' },
      { x: 200, y: 100, side: 'left' },
    );
    expect(path).toBe('M 0 100 C 100 100, 100 100, 200 100');
  });

  it('垂直边：控制点沿 y 轴外推 |dy|/2，x 与端点相等', () => {
    const path = buildBezierPath(
      { x: 100, y: 0, side: 'bottom' },
      { x: 100, y: 200, side: 'top' },
    );
    expect(path).toBe('M 100 0 C 100 100, 100 100, 100 200');
  });

  it('反向水平（left → right）：sign 反转，控制点仍朝端点外推', () => {
    const path = buildBezierPath(
      { x: 200, y: 50, side: 'left' },
      { x: 0, y: 50, side: 'right' },
    );
    expect(path).toBe('M 200 50 C 100 50, 100 50, 0 50');
  });
});
