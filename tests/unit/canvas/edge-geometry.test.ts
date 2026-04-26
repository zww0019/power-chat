import { describe, it, expect } from 'vitest';
import type { Node } from '../../../src/types';
import {
  nodeBox,
  chooseAnchors,
  buildBezierPath,
  COLLAPSED_W,
  COLLAPSED_H_DIALOGUE,
  COLLAPSED_H_REFINED,
  EXPANDED_W,
  EXPANDED_H,
} from '../../../prototype/src/canvas/edge-geometry';

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

describe('nodeBox', () => {
  it('展开态返回 360x200', () => {
    const n = makeNode({ collapsed: false, type: 'dialogue' });
    expect(nodeBox(n)).toEqual({ w: EXPANDED_W, h: EXPANDED_H });
  });

  it('折叠 dialogue 返回 200x56', () => {
    const n = makeNode({ collapsed: true, type: 'dialogue' });
    expect(nodeBox(n)).toEqual({ w: COLLAPSED_W, h: COLLAPSED_H_DIALOGUE });
  });

  it('折叠 refined 返回 200x60', () => {
    const n = makeNode({ collapsed: true, type: 'refined' });
    expect(nodeBox(n)).toEqual({ w: COLLAPSED_W, h: COLLAPSED_H_REFINED });
  });
});

describe('chooseAnchors', () => {
  it('水平相邻（子在父右侧）：父右中 → 子左中', () => {
    const parent = makeNode({ positionX: 0, positionY: 0 });
    const child = makeNode({ positionX: 800, positionY: 0 });
    const { p, c } = chooseAnchors(parent, child);
    expect(p).toEqual({ x: 360, y: 100, side: 'right' });
    expect(c).toEqual({ x: 800, y: 100, side: 'left' });
  });

  it('反向水平（子在父左侧）：父左中 → 子右中', () => {
    const parent = makeNode({ positionX: 800, positionY: 0 });
    const child = makeNode({ positionX: 0, positionY: 0 });
    const { p, c } = chooseAnchors(parent, child);
    expect(p.side).toBe('left');
    expect(c.side).toBe('right');
    expect(p.x).toBe(800);
    expect(c.x).toBe(360);
  });

  it('主垂直（子在父正下方）：父底中 → 子顶中', () => {
    const parent = makeNode({ positionX: 0, positionY: 0 });
    const child = makeNode({ positionX: 0, positionY: 600 });
    const { p, c } = chooseAnchors(parent, child);
    expect(p.side).toBe('bottom');
    expect(c.side).toBe('top');
    expect(p.y).toBe(200);
    expect(c.y).toBe(600);
  });

  it('反向垂直（子在父正上方）：父顶中 → 子底中', () => {
    const parent = makeNode({ positionX: 0, positionY: 600 });
    const child = makeNode({ positionX: 0, positionY: 0 });
    const { p, c } = chooseAnchors(parent, child);
    expect(p.side).toBe('top');
    expect(c.side).toBe('bottom');
    expect(p.y).toBe(600);
    expect(c.y).toBe(200);
  });

  it('父折叠态时锚点贴合卡片底边而非估算高度', () => {
    // 折叠 dialogue 高度 56；中心 y=28；父在子上方走垂直分支时底边 y=56
    const parent = makeNode({ positionX: 0, positionY: 0, collapsed: true, type: 'dialogue' });
    const child = makeNode({ positionX: 0, positionY: 600 });
    const { p } = chooseAnchors(parent, child);
    expect(p.y).toBe(56);
  });

  it('折叠态水平相邻：起点 y 居中于折叠卡片，不悬空', () => {
    // bug 现场：折叠节点高度 56，旧实现 y1=positionY+200 悬空到 200。
    // 新实现走水平分支，y 取折叠卡中心 28。
    const parent = makeNode({ positionX: 0, positionY: 0, collapsed: true, type: 'dialogue' });
    const child = makeNode({ positionX: 440, positionY: 0, collapsed: true, type: 'dialogue' });
    const { p, c } = chooseAnchors(parent, child);
    expect(p).toEqual({ x: 200, y: 28, side: 'right' });
    expect(c).toEqual({ x: 440, y: 28, side: 'left' });
  });

  it('|dx|=|dy| 边界：归入水平分支（>= 走水平）', () => {
    const parent = makeNode({ positionX: 0, positionY: 0 });
    const child = makeNode({ positionX: 500, positionY: 500 });
    const { p } = chooseAnchors(parent, child);
    expect(p.side === 'right' || p.side === 'left').toBe(true);
  });
});

describe('buildBezierPath', () => {
  it('水平边：控制点沿 x 轴外推 |dx|/2，y 与端点相等', () => {
    const path = buildBezierPath(
      { x: 0, y: 100, side: 'right' },
      { x: 200, y: 100, side: 'left' },
    );
    // M 0 100 C 100 100, 100 100, 200 100  （k=100，控制点 c1x=100, c2x=100）
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
    // p.side='left' sign=-1, k=100, c1x=200-100=100; c2x=0+100=100
    expect(path).toBe('M 200 50 C 100 50, 100 50, 0 50');
  });
});
