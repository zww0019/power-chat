import { useEffect, useRef, useState, useCallback } from 'react';
import { useCanvasStore } from './store/canvasStore';
import { api } from './api/client';
import { CanvasNode } from './canvas/Node';
import { EdgeLine } from './canvas/Edge';
import { RefinePopover } from './canvas/RefinePopover';
import { SettingsDialog } from './canvas/SettingsDialog';
import { NodeFullscreenModal } from './canvas/NodeFullscreenModal';
import { Minimap } from './canvas/Minimap';

export default function App() {
  const canvas = useCanvasStore((s) => s.canvas);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const activeNodeId = useCanvasStore((s) => s.activeNodeId);
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const selectedEdgeId = useCanvasStore((s) => s.selectedEdgeId);
  const streamingByNode = useCanvasStore((s) => s.streamingByNode);
  const hydrated = useCanvasStore((s) => s.hydrated);

  const hydrate = useCanvasStore((s) => s.hydrate);
  const upsertNode = useCanvasStore((s) => s.upsertNode);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const setActiveNode = useCanvasStore((s) => s.setActiveNode);
  const toggleSelectNode = useCanvasStore((s) => s.toggleSelectNode);
  const clearSelection = useCanvasStore((s) => s.clearSelection);
  const setSelectedEdge = useCanvasStore((s) => s.setSelectedEdge);
  const removeEdge = useCanvasStore((s) => s.removeEdge);
  const removeNodeAndEdges = useCanvasStore((s) => s.removeNodeAndEdges);
  const setViewport = useCanvasStore((s) => s.setViewport);

  const [refinePos, setRefinePos] = useState<{ x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 首次进入：从 mock server 拉初始 canvas（单画布）
  useEffect(() => {
    if (hydrated) return;
    api.getCanvas().then(hydrate).catch((e) => console.error('hydrate failed', e));
  }, [hydrated, hydrate]);

  // 启动后检测是否已配置 LLM；未配置则强制弹出 SettingsDialog
  useEffect(() => {
    if (!hydrated) return;
    api.getSettings().then((s) => {
      if (!s.llmBaseUrl || !s.llmModel || !s.llmApiKey) {
        setSettingsOpen(true);
      }
    }).catch((e) => console.error('getSettings failed', e));
  }, [hydrated]);

  // 全局键盘监听：Delete / Backspace 删除 selectedEdgeId 或 activeNodeId。
  // 焦点在输入控件中时不响应，避免吞掉文本编辑。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      const state = useCanvasStore.getState();
      // 边删除优先级高于节点
      if (state.selectedEdgeId) {
        const edgeId = state.selectedEdgeId;
        e.preventDefault();
        api.deleteEdge(edgeId)
          .then(() => removeEdge(edgeId))
          .catch((err) => alert(`删除连线失败：${err.message ?? err}`));
        return;
      }
      if (state.activeNodeId) {
        const nodeId = state.activeNodeId;
        e.preventDefault();
        api.deleteNode(nodeId)
          .then(() => removeNodeAndEdges(nodeId))
          .catch((err) => {
            const msg = String(err.message ?? err);
            if (msg.includes('409') || msg.includes('streaming')) {
              alert('节点正在流式输出，无法删除。请等待完成或刷新页面后再试。');
            } else {
              alert(`删除节点失败：${msg}`);
            }
          });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [removeEdge, removeNodeAndEdges]);

  // 平移和缩放状态
  const containerRef = useRef<HTMLDivElement>(null);
  const [vx, setVx] = useState(0);
  const [vy, setVy] = useState(0);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (canvas) {
      setVx(canvas.viewportX);
      setVy(canvas.viewportY);
      setZoom(canvas.viewportZoom);
    }
  }, [canvas]);

  // 平移视野 + 节点拖动 - 用 ref 区分两种模式
  const dragRef = useRef<
    | { kind: 'pan'; startClientX: number; startClientY: number; startVx: number; startVy: number }
    | { kind: 'node'; nodeId: string; startClientX: number; startClientY: number; startNodeX: number; startNodeY: number }
    | null
  >(null);

  const handleBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    // 点击空白处：清除活跃 + 选中 + popover
    setActiveNode(null);
    clearSelection();
    setRefinePos(null);
    // 启动平移
    dragRef.current = {
      kind: 'pan',
      startClientX: e.clientX,
      startClientY: e.clientY,
      startVx: vx,
      startVy: vy,
    };
    // capture 保证 pointerup/pointermove 在鼠标拖出容器边界时仍能收到
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setVx(d.startVx + (e.clientX - d.startClientX));
      setVy(d.startVy + (e.clientY - d.startClientY));
    } else if (d.kind === 'node') {
      const dx = (e.clientX - d.startClientX) / zoom;
      const dy = (e.clientY - d.startClientY) / zoom;
      updateNode(d.nodeId, { positionX: d.startNodeX + dx, positionY: d.startNodeY + dy });
    }
  };

  // 位移小于该阈值视为单击（展开 collapsed 节点 / 不发位置 PATCH）。
  // setPointerCapture 会吞掉 click 事件，因此节点的"单击展开"必须在 pointerup 这里判定。
  const CLICK_THRESHOLD = 4;

  const handlePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (d?.kind === 'node') {
      const moved = Math.hypot(e.clientX - d.startClientX, e.clientY - d.startClientY) >= CLICK_THRESHOLD;
      const node = useCanvasStore.getState().nodes[d.nodeId];
      if (node) {
        if (moved) {
          api.updateNode(d.nodeId, { positionX: node.positionX, positionY: node.positionY }).catch(() => {});
        } else if (node.collapsed) {
          updateNode(d.nodeId, { collapsed: false });
          api.updateNode(d.nodeId, { collapsed: false }).catch(() => {});
        }
      }
    }
    if (d?.kind === 'pan') {
      setViewport(vx, vy, zoom);
    }
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const handleNodePointerDown = useCallback(
    (e: React.PointerEvent, nodeId: string) => {
      e.stopPropagation();
      const node = useCanvasStore.getState().nodes[nodeId];
      if (!node) return;

      // Shift+点击：多选
      if (e.shiftKey) {
        toggleSelectNode(nodeId);
        return;
      }

      // 普通点击：激活
      setActiveNode(nodeId);
      clearSelection();

      dragRef.current = {
        kind: 'node',
        nodeId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startNodeX: node.positionX,
        startNodeY: node.positionY,
      };
      // capture 到容器，确保拖拽跨越节点边界时 move/up 事件不丢失
      (containerRef.current as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [setActiveNode, clearSelection, toggleSelectNode],
  );

  // 双击空白创建节点（PRD §4.1）
  const handleBackgroundDoubleClick = async (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    // 把屏幕坐标转换为画布逻辑坐标
    const rect = containerRef.current!.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const logicalX = (screenX - vx) / zoom;
    const logicalY = (screenY - vy) / zoom;

    try {
      const newNode = await api.createNode({
        positionX: logicalX,
        positionY: logicalY,
        type: 'dialogue',
      });
      upsertNode(newNode);
      setActiveNode(newNode.id);
    } catch (err) {
      console.error('create node failed', err);
    }
  };

  // Cmd+滚轮缩放，普通滚轮也支持平移（更直觉）
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // 缩放
      const delta = -e.deltaY * 0.001;
      const next = Math.max(0.25, Math.min(2, zoom + delta));
      setZoom(next);
      setViewport(vx, vy, next);
    } else {
      setVx(vx - e.deltaX);
      setVy(vy - e.deltaY);
    }
  };

  // 触发提炼弹窗（顶部工具栏点击）
  const handleRefineClick = () => {
    if (selectedNodeIds.length === 0) return;
    // 计算几何中心作为弹窗位置
    let sumX = 0, sumY = 0;
    selectedNodeIds.forEach((id) => {
      const n = nodes[id];
      if (n) {
        sumX += n.positionX + 190;
        sumY += n.positionY + 100;
      }
    });
    const cx = sumX / selectedNodeIds.length;
    const cy = sumY / selectedNodeIds.length;
    // 转回屏幕坐标
    const screenX = cx * zoom + vx;
    const screenY = cy * zoom + vy;
    // E2 决策：保证弹窗在视野内
    const rect = containerRef.current!.getBoundingClientRect();
    const clamped = {
      x: Math.max(20, Math.min(rect.width - 380, screenX - 180)),
      y: Math.max(20, Math.min(rect.height - 220, screenY)),
    };
    setRefinePos(clamped);
  };

  const allNodes = Object.values(nodes);
  const allEdges = Object.values(edges);

  if (!hydrated) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#94a3b8' }}>
        正在加载画布…
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', userSelect: 'none', background: '#F1EFE8' }}>
      {/* 顶部工具栏 */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          right: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          zIndex: 100,
          fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          fontSize: 12,
          color: '#475569',
          pointerEvents: 'none',
        }}
      >
        <div style={{ pointerEvents: 'auto', background: '#ffffff', padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
          🧠 思考画布 · MVP 原型
        </div>
        <div style={{ flex: 1 }} />
        {selectedNodeIds.length > 0 && (
          <button
            onClick={handleRefineClick}
            style={{
              pointerEvents: 'auto',
              background: '#185FA5',
              color: '#ffffff',
              border: 'none',
              padding: '6px 14px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
              boxShadow: '0 2px 6px rgba(24,95,165,0.22)',
            }}
          >
            ◆ 提炼 ({selectedNodeIds.length})
          </button>
        )}
        <div style={{ pointerEvents: 'auto', background: '#ffffff', padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 11, color: '#94a3b8' }}>
          {allNodes.length} 节点 · 缩放 {Math.round(zoom * 100)}%
        </div>
        <button
          onClick={() => setSettingsOpen(true)}
          title="模型设置"
          style={{
            pointerEvents: 'auto',
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            padding: '6px 10px',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            color: '#475569',
            boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
          }}
        >
          ⚙
        </button>
      </div>

      {/* 提示卡片：空画布引导 */}
      {allNodes.length === 0 && (
        <div
          style={{
            position: 'absolute',
            top: '40%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            color: '#94a3b8',
            fontSize: 14,
            zIndex: 50,
            pointerEvents: 'none',
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}
        >
          <div style={{ fontSize: 36, marginBottom: 8 }}>✦</div>
          <div>双击空白处创建第一个节点</div>
        </div>
      )}

      {/* 画布主区：纯白底 + 22px 圆点网格（透明度 4.5%）作为空间锚点 */}
      <div
        ref={containerRef}
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleBackgroundDoubleClick}
        onWheel={handleWheel}
        style={{
          position: 'absolute',
          inset: 0,
          background: '#FFFFFF',
          backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.045) 1px, transparent 1px)',
          backgroundSize: `${22 * zoom}px ${22 * zoom}px`,
          backgroundPosition: `${vx}px ${vy}px`,
          cursor: dragRef.current?.kind === 'pan' ? 'grabbing' : 'default',
        }}
      >
        {/* 内层 transform，所有节点和边在这里 */}
        <div
          style={{
            position: 'absolute',
            transform: `translate(${vx}px, ${vy}px) scale(${zoom})`,
            transformOrigin: '0 0',
            width: 1,
            height: 1,
          }}
        >
          {/* SVG 边层（在节点下方）。svg 容器必须 pointerEvents: 'none'，
              否则其 20000×20000 的尺寸会吞掉背景双击/拖拽事件；
              单条边通过自身 pointerEvents="stroke" 在 SVG 中独立打开命中
              （SVG 子元素可覆盖父级的 'none'）。*/}
          <svg
            style={{
              position: 'absolute',
              left: -10000,
              top: -10000,
              width: 20000,
              height: 20000,
              pointerEvents: 'none',
              overflow: 'visible',
            }}
          >
            <g transform="translate(10000, 10000)">
              {allEdges.map((e) => {
                const parent = nodes[e.parentNodeId];
                const child = nodes[e.childNodeId];
                if (!parent || !child) return null;
                return (
                  <EdgeLine
                    key={e.id}
                    edge={e}
                    parent={parent}
                    child={child}
                    isSelected={selectedEdgeId === e.id}
                    onSelect={setSelectedEdge}
                    onDelete={(id) => {
                      api.deleteEdge(id)
                        .then(() => removeEdge(id))
                        .catch((err) => alert(`删除连线失败：${err.message ?? err}`));
                    }}
                  />
                );
              })}
            </g>
          </svg>

          {/* 节点：当画布存在 active node 时，其他节点 dim 至 opacity 0.9（焦点对比） */}
          {allNodes.map((n) => (
            <CanvasNode
              key={n.id}
              node={n}
              isActive={activeNodeId === n.id}
              isSelected={selectedNodeIds.includes(n.id)}
              isStreaming={streamingByNode[n.id] === 'streaming'}
              dimmed={activeNodeId !== null && activeNodeId !== n.id}
              onPointerDownHeader={handleNodePointerDown}
            />
          ))}
        </div>
      </div>

      {/* 提炼弹窗 */}
      {refinePos && (
        <RefinePopover
          selectedNodeIds={selectedNodeIds}
          position={refinePos}
          onClose={() => setRefinePos(null)}
        />
      )}

      {/* 设置弹窗（齿轮按钮触发，或首次启动未配置时强制弹出）*/}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* 节点大屏对话 Modal（节点 header ⛶ 按钮触发；ESC / 点遮罩关闭）*/}
      <NodeFullscreenModal />

      {/* 全局预览小视窗（右下角）*/}
      <Minimap />
    </div>
  );
}
