import { describe, it, expect } from 'vitest';
import type { Node } from '../../../src/types';
import { computeFitToNodesViewport } from '../../../prototype/src/canvas/viewport-fit';

function makeNode(overrides: Partial<Node>): Node {
  return {
    id: 'n',
    canvasId: 'c',
    type: 'dialogue',
    positionX: 0,
    positionY: 0,
    title: null,
    collapsed: false,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  } as Node;
}

describe('computeFitToNodesViewport', () => {
  // 节点中心 = (positionX + 180, positionY + 120)；屏幕居中 = 屏幕一半 - 节点中心 * zoom
  const SCREEN_W = 1440;
  const SCREEN_H = 900;

  it('空节点列表返回 (0,0,1) 兜底', () => {
    const r = computeFitToNodesViewport([], SCREEN_W, SCREEN_H);
    expect(r).toEqual({ viewportX: 0, viewportY: 0, viewportZoom: 1 });
  });

  it('单节点居中：viewport 让该节点中心落到屏幕正中央', () => {
    const node = makeNode({ positionX: 1000, positionY: 500 });
    const r = computeFitToNodesViewport([node], SCREEN_W, SCREEN_H);
    // 节点中心 = (1180, 620)；目标视口 = (720 - 1180, 450 - 620) = (-460, -170)
    expect(r.viewportX).toBe(SCREEN_W / 2 - 1180);
    expect(r.viewportY).toBe(SCREEN_H / 2 - 620);
    expect(r.viewportZoom).toBe(1);
  });

  it('多节点居中：viewport 让节点群包围盒中心落到屏幕正中央', () => {
    // 4 个节点构成对角矩形：包围盒中心 = ((100+1000)/2+180, (200+1500)/2+120) = (730, 970)
    // 但函数对节点中心取极值，不是 positionX 取极值
    const nodes = [
      makeNode({ id: 'a', positionX: 100, positionY: 200 }),   // 中心 (280, 320)
      makeNode({ id: 'b', positionX: 1000, positionY: 200 }),  // 中心 (1180, 320)
      makeNode({ id: 'c', positionX: 100, positionY: 1500 }),  // 中心 (280, 1620)
      makeNode({ id: 'd', positionX: 1000, positionY: 1500 }), // 中心 (1180, 1620)
    ];
    const r = computeFitToNodesViewport(nodes, SCREEN_W, SCREEN_H);
    // 中心 X 极值 280 / 1180 → 中点 730；中心 Y 极值 320 / 1620 → 中点 970
    expect(r.viewportX).toBe(SCREEN_W / 2 - 730);
    expect(r.viewportY).toBe(SCREEN_H / 2 - 970);
    expect(r.viewportZoom).toBe(1);
  });

  it('Y 漂移到 1500+ 的真实场景：节点群居中后用户能看到节点', () => {
    // 模拟用户报告的现象：5 个节点 Y 落在 1149-1895
    const nodes = [
      makeNode({ id: '1', positionX: 200, positionY: 1149 }),
      makeNode({ id: '2', positionX: 800, positionY: 1300 }),
      makeNode({ id: '3', positionX: 200, positionY: 1500 }),
      makeNode({ id: '4', positionX: 800, positionY: 1700 }),
      makeNode({ id: '5', positionX: 500, positionY: 1895 }),
    ];
    const r = computeFitToNodesViewport(nodes, SCREEN_W, SCREEN_H);
    // 节点群在屏幕中央可见 → viewportY 必须为负（把屏幕往下移到节点群所在区域）
    expect(r.viewportY).toBeLessThan(0);
    // 节点群中心点变换到屏幕坐标后应在屏幕范围内
    const groupCenterY = (1149 + 120 + 1895 + 120) / 2;
    const screenY = groupCenterY * r.viewportZoom + r.viewportY;
    expect(screenY).toBeCloseTo(SCREEN_H / 2);
    expect(screenY).toBeGreaterThan(0);
    expect(screenY).toBeLessThan(SCREEN_H);
  });
});
