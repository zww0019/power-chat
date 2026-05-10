import { useEffect, useRef, useState, useCallback, type CSSProperties } from 'react';
import { Sparkles, HelpCircle, Settings as SettingsIcon, MousePointerClick, Minimize2, Maximize2, PenLine, ArrowLeft } from 'lucide-react';
import { useCanvasStore } from '../store/canvasStore';
import { useViewStore } from '../store/viewStore';
import { useProjectStore } from '../store/projectStore';
import { api } from '../api/client';
import { CanvasNode } from '../canvas/Node';
import { EdgeLine } from '../canvas/Edge';
import { RefinePopover } from '../canvas/RefinePopover';
import { WritePopover } from '../canvas/WritePopover';
import { SettingsDialog } from '../canvas/SettingsDialog';
import { HelpDialog } from '../canvas/HelpDialog';
import { NodeFullscreenModal } from '../canvas/NodeFullscreenModal';
import { Minimap } from '../canvas/Minimap';
import { ToastContainer } from '../canvas/ToastContainer';
import { computeFitToNodesViewport } from '../canvas/viewport-fit';
import { captureNodeDeleteSnapshot, performUndo } from '../canvas/nodeActions';
import { loadViewport, saveViewport } from '../store/viewportStorage';
import { color, text, space, radius, shadow, font, motion } from '../styles/theme';

const toolbarIconBtn: CSSProperties = {
  pointerEvents: 'auto',
  background: 'transparent',
  border: 'none',
  width: 34,
  height: 34,
  borderRadius: radius.md,
  cursor: 'pointer',
  color: color.ink600,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: `background ${motion.durFast}ms ${motion.easeInOut}, color ${motion.durFast}ms ${motion.easeInOut}`,
};

function ToolbarIconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...toolbarIconBtn,
        background: hover ? color.ink100 : 'transparent',
        color: hover ? color.accent600 : color.ink600,
      }}
    >
      {children}
    </button>
  );
}

// 画布缩放范围常量：wheel 缩放与 macOS 双指捏合（以 ctrlKey wheel 形式派发）共用
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;

// CanvasPage：单项目画布页。
// projectId 在挂载/切换时驱动一次完整的 hydrate 流程：
//   1. canvasStore.reset() 清空上一项目残留
//   2. 从 viewportStorage 读取本项目的视口快照写回 store（替代旧版 zustand persist）
//   3. api.getCanvas(projectId) 拉后端真源数据 hydrate 进 store
//   4. 若用户从未操作过视口 → fit-to-nodes 自动居中
// 卸载时再次 reset，避免回到首页后 store 持有旧项目的悬空数据。
export function CanvasPage({ projectId }: { projectId: string }) {
  const goHome = useViewStore((s) => s.goHome);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);

  const canvas = useCanvasStore((s) => s.canvas);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const activeNodeId = useCanvasStore((s) => s.activeNodeId);
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const selectedEdgeId = useCanvasStore((s) => s.selectedEdgeId);
  const streamingByNode = useCanvasStore((s) => s.streamingByNode);
  const hydrated = useCanvasStore((s) => s.hydrated);

  const reset = useCanvasStore((s) => s.reset);
  const hydrate = useCanvasStore((s) => s.hydrate);
  const setUserHasMovedViewport = useCanvasStore((s) => s.setUserHasMovedViewport);
  const upsertNode = useCanvasStore((s) => s.upsertNode);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const setActiveNode = useCanvasStore((s) => s.setActiveNode);
  const toggleSelectNode = useCanvasStore((s) => s.toggleSelectNode);
  const clearSelection = useCanvasStore((s) => s.clearSelection);
  const setSelectedEdge = useCanvasStore((s) => s.setSelectedEdge);
  const removeEdge = useCanvasStore((s) => s.removeEdge);
  const removeNodeAndEdges = useCanvasStore((s) => s.removeNodeAndEdges);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const setSystemViewport = useCanvasStore((s) => s.setSystemViewport);
  const userHasMovedViewport = useCanvasStore((s) => s.userHasMovedViewport);
  const pushUndoEntry = useCanvasStore((s) => s.pushUndoEntry);

  const [refinePos, setRefinePos] = useState<{ x: number; y: number } | null>(null);
  const [writePos, setWritePos] = useState<{ x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [cognitionStatus, setCognitionStatus] = useState<'unknown' | 'disabled' | 'ok' | 'error'>('unknown');

  // 切换/挂载项目时执行：reset → 加载视口 → hydrate
  useEffect(() => {
    let cancelled = false;
    (async () => {
      reset();
      // 先把本项目的视口快照预写入 store——hydrate 内部会据此决定是否保留前端视口
      const snap = loadViewport(projectId);
      if (snap) {
        setSystemViewport(snap.viewportX, snap.viewportY, snap.viewportZoom);
        setUserHasMovedViewport(snap.userHasMovedViewport);
      }
      try {
        const data = await api.getCanvas(projectId);
        if (cancelled) return;
        hydrate(data);
      } catch (e) {
        if (!cancelled) console.error('hydrate failed', e);
      }
    })();
    return () => {
      cancelled = true;
      reset();
    };
  }, [projectId, reset, hydrate, setSystemViewport, setUserHasMovedViewport]);

  // hydrate 完成后若用户从未操作过视口（首次启动 / 清缓存），自动 fit-to-nodes 居中。
  useEffect(() => {
    if (!hydrated || userHasMovedViewport) return;
    const allNodes = Object.values(useCanvasStore.getState().nodes);
    if (allNodes.length === 0) return;
    const fit = computeFitToNodesViewport(allNodes, window.innerWidth, window.innerHeight);
    setSystemViewport(fit.viewportX, fit.viewportY, fit.viewportZoom);
  }, [hydrated, userHasMovedViewport, setSystemViewport]);

  // 启动后检测是否已配置 LLM；未配置则强制弹出 SettingsDialog
  useEffect(() => {
    if (!hydrated) return;
    api.getSettings().then((s) => {
      if (!s.llmBaseUrl || !s.llmModel || !s.llmApiKey) {
        setSettingsOpen(true);
      }
    }).catch((e) => console.error('getSettings failed', e));
  }, [hydrated]);

  // 启动后 + SettingsDialog 关闭时探测 cognition 服务连通状态
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await api.getSettings();
        if (cancelled) return;
        if (!s.cognitionEnabled) {
          setCognitionStatus('disabled');
          return;
        }
        const r = await api.cognitionHealth();
        if (cancelled) return;
        setCognitionStatus(r.ok ? 'ok' : 'error');
      } catch {
        if (!cancelled) setCognitionStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, settingsOpen]);

  // 全局键盘监听：Cmd/Ctrl+Z 撤销；Delete / Backspace 删除 selectedEdgeId 或 activeNodeId。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable = target
        ? target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
        : false;

      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        if (inEditable) return;
        e.preventDefault();
        void performUndo();
        return;
      }

      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (inEditable) return;
      const state = useCanvasStore.getState();
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
        const snapshot = captureNodeDeleteSnapshot(nodeId);
        api.deleteNode(nodeId)
          .then(() => {
            removeNodeAndEdges(nodeId);
            if (snapshot) pushUndoEntry({ kind: 'node.delete', snapshot });
          })
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
  }, [removeEdge, removeNodeAndEdges, pushUndoEntry]);

  // 平移和缩放状态
  const containerRef = useRef<HTMLDivElement>(null);
  const [vx, setVx] = useState(0);
  const [vy, setVy] = useState(0);
  const [zoom, setZoom] = useState(1);

  const vxRef = useRef(vx);
  const vyRef = useRef(vy);
  const zoomRef = useRef(zoom);

  useEffect(() => {
    if (canvas) {
      vxRef.current = canvas.viewportX;
      vyRef.current = canvas.viewportY;
      zoomRef.current = canvas.viewportZoom;
      setVx(canvas.viewportX);
      setVy(canvas.viewportY);
      setZoom(canvas.viewportZoom);
    }
  }, [canvas]);

  const dragRef = useRef<
    | { kind: 'pan'; startClientX: number; startClientY: number; startVx: number; startVy: number }
    | { kind: 'node'; nodeId: string; startClientX: number; startClientY: number; startNodeX: number; startNodeY: number }
    | null
  >(null);

  const handleBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    setActiveNode(null);
    clearSelection();
    setRefinePos(null);
    setWritePos(null);
    dragRef.current = {
      kind: 'pan',
      startClientX: e.clientX,
      startClientY: e.clientY,
      startVx: vx,
      startVy: vy,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') {
      const nvx = d.startVx + (e.clientX - d.startClientX);
      const nvy = d.startVy + (e.clientY - d.startClientY);
      vxRef.current = nvx;
      vyRef.current = nvy;
      setVx(nvx);
      setVy(nvy);
    } else if (d.kind === 'node') {
      const dx = (e.clientX - d.startClientX) / zoom;
      const dy = (e.clientY - d.startClientY) / zoom;
      updateNode(d.nodeId, { positionX: d.startNodeX + dx, positionY: d.startNodeY + dy });
    }
  };

  const CLICK_THRESHOLD = 4;

  const handlePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (d?.kind === 'node') {
      const moved = Math.hypot(e.clientX - d.startClientX, e.clientY - d.startClientY) >= CLICK_THRESHOLD;
      const node = useCanvasStore.getState().nodes[d.nodeId];
      if (node) {
        if (moved) {
          api.updateNode(d.nodeId, { positionX: node.positionX, positionY: node.positionY }).catch(() => {});
          if (d.startNodeX !== node.positionX || d.startNodeY !== node.positionY) {
            pushUndoEntry({ kind: 'node.move', nodeId: d.nodeId, prevX: d.startNodeX, prevY: d.startNodeY });
          }
        } else if (node.collapsed) {
          updateNode(d.nodeId, { collapsed: false });
          api.updateNode(d.nodeId, { collapsed: false }).catch(() => {});
        }
      }
    }
    if (d?.kind === 'pan') {
      setViewport(vx, vy, zoom);
      saveViewport(projectId, { viewportX: vx, viewportY: vy, viewportZoom: zoom, userHasMovedViewport: true });
    }
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const handleNodePointerDown = useCallback(
    (e: React.PointerEvent, nodeId: string) => {
      e.stopPropagation();
      const node = useCanvasStore.getState().nodes[nodeId];
      if (!node) return;

      if (e.shiftKey) {
        toggleSelectNode(nodeId);
        return;
      }

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
      (containerRef.current as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [setActiveNode, clearSelection, toggleSelectNode],
  );

  // 在指定逻辑坐标处创建对话节点：所有"新建节点"路径共用。
  // 多项目改造后必须显式提供 canvasId（取自当前已加载的 canvas snapshot），
  // 后端不再有"默认画布"。
  const createNodeAt = useCallback(
    async (logicalX: number, logicalY: number) => {
      const currentCanvas = useCanvasStore.getState().canvas;
      if (!currentCanvas) {
        console.warn('canvas not yet loaded, skip create node');
        return;
      }
      try {
        const newNode = await api.createNode({
          canvasId: currentCanvas.id,
          positionX: logicalX,
          positionY: logicalY,
          type: 'dialogue',
        });
        upsertNode(newNode);
        setActiveNode(newNode.id);
      } catch (err) {
        console.error('create node failed', err);
      }
    },
    [upsertNode, setActiveNode],
  );

  const handleBackgroundDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    void createNodeAt((screenX - vx) / zoom, (screenY - vy) / zoom);
  };

  const createNodeAtViewportCenter = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const screenX = rect.width / 2;
    const screenY = rect.height / 2;
    void createNodeAt((screenX - vx) / zoom, (screenY - vy) / zoom - 80);
  };

  // 画布 wheel 处理（缩放 + 平移）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ZOOM_K_MOUSE = 0.0015;
    const ZOOM_K_TOUCHPAD = 0.008;
    const DELTA_CLAMP_MOUSE = 50;
    const PERSIST_DEBOUNCE = 150;

    const accum: {
      zoomDeltaY: number; panDx: number; panDy: number;
      pivotX: number; pivotY: number; zoomDevice: 'touchpad' | 'mouse';
    } = { zoomDeltaY: 0, panDx: 0, panDy: 0, pivotX: 0, pivotY: 0, zoomDevice: 'mouse' };
    let rafId: number | null = null;
    let persistTimer: number | null = null;

    const flushPersist = () => {
      setViewport(vxRef.current, vyRef.current, zoomRef.current);
      saveViewport(projectId, {
        viewportX: vxRef.current,
        viewportY: vyRef.current,
        viewportZoom: zoomRef.current,
        userHasMovedViewport: true,
      });
      persistTimer = null;
    };
    const schedulePersist = () => {
      if (persistTimer != null) clearTimeout(persistTimer);
      persistTimer = window.setTimeout(flushPersist, PERSIST_DEBOUNCE);
    };

    const flush = () => {
      rafId = null;
      let nextVx = vxRef.current;
      let nextVy = vyRef.current;
      let nextZoom = zoomRef.current;

      if (accum.zoomDeltaY !== 0) {
        const isTouchpad = accum.zoomDevice === 'touchpad';
        const k = isTouchpad ? ZOOM_K_TOUCHPAD : ZOOM_K_MOUSE;
        const dy = isTouchpad
          ? accum.zoomDeltaY
          : Math.max(-DELTA_CLAMP_MOUSE, Math.min(DELTA_CLAMP_MOUSE, accum.zoomDeltaY));
        nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomRef.current * Math.exp(-dy * k)));
        const zoomRatio = nextZoom / zoomRef.current;
        nextVx = accum.pivotX - (accum.pivotX - vxRef.current) * zoomRatio;
        nextVy = accum.pivotY - (accum.pivotY - vyRef.current) * zoomRatio;
        accum.zoomDeltaY = 0;
      }
      if (accum.panDx !== 0 || accum.panDy !== 0) {
        nextVx -= accum.panDx;
        nextVy -= accum.panDy;
        accum.panDx = 0;
        accum.panDy = 0;
      }

      if (nextZoom !== zoomRef.current) { zoomRef.current = nextZoom; setZoom(nextZoom); }
      if (nextVx !== vxRef.current) { vxRef.current = nextVx; setVx(nextVx); }
      if (nextVy !== vyRef.current) { vyRef.current = nextVy; setVy(nextVy); }
      schedulePersist();
    };

    const onWheel = (e: WheelEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.('[data-canvas-node-scroll]') && !(e.ctrlKey || e.metaKey)) return;

      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        accum.zoomDevice = (e.deltaMode === 0 && Math.abs(e.deltaY) < 50) ? 'touchpad' : 'mouse';
        accum.zoomDeltaY += e.deltaY;
        accum.pivotX = e.clientX - rect.left;
        accum.pivotY = e.clientY - rect.top;
      } else {
        accum.panDx += e.deltaX;
        accum.panDy += e.deltaY;
      }
      if (rafId == null) rafId = requestAnimationFrame(flush);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (rafId != null) cancelAnimationFrame(rafId);
      if (persistTimer != null) {
        clearTimeout(persistTimer);
        flushPersist();
      }
    };
  }, [setViewport, projectId]);

  const handleRefineClick = () => {
    if (selectedNodeIds.length === 0) return;
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
    const screenX = cx * zoom + vx;
    const screenY = cy * zoom + vy;
    const rect = containerRef.current!.getBoundingClientRect();
    const clamped = {
      x: Math.max(20, Math.min(rect.width - 380, screenX - 180)),
      y: Math.max(20, Math.min(rect.height - 220, screenY)),
    };
    setRefinePos(clamped);
  };

  const handleWriteClick = () => {
    if (selectedNodeIds.length === 0) return;
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
    const screenX = cx * zoom + vx;
    const screenY = cy * zoom + vy;
    const rect = containerRef.current!.getBoundingClientRect();
    const clamped = {
      x: Math.max(20, Math.min(rect.width - 380, screenX - 180)),
      y: Math.max(20, Math.min(rect.height - 220, screenY)),
    };
    setWritePos(clamped);
  };

  const allNodes = Object.values(nodes);
  const allEdges = Object.values(edges);

  const handleCollapseAll = useCallback(() => {
    for (const node of allNodes) {
      if (node.collapsed === true) continue;
      updateNode(node.id, { collapsed: true });
      api.updateNode(node.id, { collapsed: true }).catch(() => {});
    }
  }, [allNodes, updateNode]);

  const handleExpandAll = useCallback(() => {
    for (const node of allNodes) {
      if (node.collapsed !== true) continue;
      updateNode(node.id, { collapsed: false });
      api.updateNode(node.id, { collapsed: false }).catch(() => {});
    }
  }, [allNodes, updateNode]);

  if (!hydrated) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: space.s4,
          background: color.canvas,
          color: color.ink500,
          fontFamily: font.sans,
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 56,
            height: 56,
            borderRadius: radius.lg,
            background: color.paper,
            border: `0.5px solid ${color.ink200}`,
            boxShadow: shadow.md,
            color: color.accent500,
            animation: `spin 1.6s ${motion.easeInOut} infinite`,
          }}
        >
          <Sparkles size={26} strokeWidth={1.6} />
        </div>
        <div style={{ fontSize: text.sm, color: color.ink500 }}>正在加载画布…</div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        userSelect: 'none',
        background: color.canvas,
        fontFamily: font.sans,
        color: color.ink900,
      }}
    >
      {/* 顶部浮动工具栏 */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          right: 16,
          display: 'flex',
          alignItems: 'center',
          gap: space.s3,
          zIndex: 100,
          pointerEvents: 'none',
        }}
      >
        {/* 左：返回首页 + 项目名胶囊 */}
        <div
          style={{
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'rgba(251, 249, 242, 0.72)',
            backdropFilter: 'blur(20px) saturate(140%)',
            WebkitBackdropFilter: 'blur(20px) saturate(140%)',
            border: `0.5px solid ${color.ink200}`,
            padding: `4px 12px 4px 4px`,
            borderRadius: radius.pill,
            boxShadow: shadow.sm,
          }}
        >
          <button
            onClick={goHome}
            title="返回项目列表"
            style={{
              ...toolbarIconBtn,
              width: 28,
              height: 28,
              borderRadius: radius.pill,
              color: color.ink600,
            }}
          >
            <ArrowLeft size={16} strokeWidth={1.7} />
          </button>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              borderRadius: radius.sm,
              background: `linear-gradient(135deg, ${color.accent400}, ${color.accent600})`,
              color: '#FFFFFF',
            }}
          >
            <Sparkles size={13} strokeWidth={2} />
          </span>
          <span
            style={{
              fontSize: text.sm,
              fontWeight: 600,
              color: color.ink800,
              letterSpacing: '-0.01em',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {project?.name ?? '画布'}
          </span>
        </div>

        {/* 中：提炼 / 撰写按钮（多选时） */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: space.s3 }}>
          {selectedNodeIds.length > 0 && (
            <>
              <button
                onClick={handleRefineClick}
              style={{
                pointerEvents: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: `linear-gradient(135deg, ${color.accent500}, ${color.accent600})`,
                color: '#FFFFFF',
                border: 'none',
                padding: '9px 18px',
                borderRadius: radius.pill,
                cursor: 'pointer',
                fontSize: text.sm,
                fontWeight: 600,
                letterSpacing: '0.01em',
                boxShadow: shadow.accent,
              }}
            >
              <Sparkles size={14} strokeWidth={2} />
              提炼 {selectedNodeIds.length} 个节点
            </button>
            <button
              onClick={handleWriteClick}
              style={{
                pointerEvents: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: `linear-gradient(135deg, ${color.ink700}, ${color.ink900})`,
                color: '#FFFFFF',
                border: 'none',
                padding: '9px 18px',
                borderRadius: radius.pill,
                cursor: 'pointer',
                fontSize: text.sm,
                fontWeight: 600,
                letterSpacing: '0.01em',
                boxShadow: shadow.md,
              }}
            >
              <PenLine size={14} strokeWidth={2} />
              撰写 {selectedNodeIds.length} 个节点
            </button>
            </>
          )}
        </div>

        {/* 右：状态信息 + 帮助 / 设置 */}
        <div
          style={{
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            background: 'rgba(251, 249, 242, 0.72)',
            backdropFilter: 'blur(20px) saturate(140%)',
            WebkitBackdropFilter: 'blur(20px) saturate(140%)',
            border: `0.5px solid ${color.ink200}`,
            padding: '4px 6px 4px 14px',
            borderRadius: radius.pill,
            boxShadow: shadow.sm,
          }}
        >
          <span style={{ fontSize: text.xs, color: color.ink500, fontVariantNumeric: 'tabular-nums', marginRight: 4 }}>
            {allNodes.length} 节点
          </span>
          <span style={{ width: 1, height: 14, background: color.ink200, marginRight: 4 }} />
          <span style={{ fontSize: text.xs, color: color.ink500, fontVariantNumeric: 'tabular-nums', marginRight: 6 }}>
            {Math.round(zoom * 100)}%
          </span>
          <ToolbarIconButton onClick={handleCollapseAll} title="全部折叠">
            <Minimize2 size={17} strokeWidth={1.6} />
          </ToolbarIconButton>
          <ToolbarIconButton onClick={handleExpandAll} title="全部展开">
            <Maximize2 size={17} strokeWidth={1.6} />
          </ToolbarIconButton>
          <ToolbarIconButton onClick={() => setHelpOpen(true)} title="帮助">
            <HelpCircle size={17} strokeWidth={1.6} />
          </ToolbarIconButton>
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            <ToolbarIconButton
              onClick={() => setSettingsOpen(true)}
              title={
                cognitionStatus === 'ok' ? '模型设置 · 认知建模已连接'
                : cognitionStatus === 'error' ? '模型设置 · 认知建模服务不可达（点开查看）'
                : cognitionStatus === 'disabled' ? '模型设置 · 认知建模已关闭'
                : '模型设置'
              }
            >
              <SettingsIcon size={17} strokeWidth={1.6} />
            </ToolbarIconButton>
            {(cognitionStatus === 'error' || cognitionStatus === 'disabled') && (
              <span
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: cognitionStatus === 'error' ? color.danger : color.ink400,
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* 空状态 */}
      {allNodes.length === 0 && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            color: color.ink600,
            zIndex: 50,
            pointerEvents: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: space.s4,
          }}
        >
          <div
            style={{
              width: 88,
              height: 88,
              borderRadius: radius.xl,
              background: `linear-gradient(135deg, ${color.accent100}, ${color.warm})`,
              border: `0.5px solid ${color.accent200}`,
              boxShadow: shadow.lg,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: color.accent600,
            }}
          >
            <Sparkles size={36} strokeWidth={1.4} />
          </div>
          <div>
            <div
              style={{
                fontSize: text.xl,
                fontWeight: 700,
                color: color.ink900,
                letterSpacing: '-0.02em',
                marginBottom: 6,
              }}
            >
              开始你的思考
            </div>
            <div style={{ fontSize: text.sm, color: color.ink500, lineHeight: 1.6 }}>
              把零散对话编织成可探索的思维网络
            </div>
          </div>
          <button
            onClick={createNodeAtViewportCenter}
            style={{
              pointerEvents: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background: color.ink900,
              color: '#FFFFFF',
              border: 'none',
              padding: '10px 20px',
              borderRadius: radius.pill,
              cursor: 'pointer',
              fontSize: text.sm,
              fontWeight: 600,
              boxShadow: shadow.lg,
            }}
          >
            <MousePointerClick size={15} strokeWidth={1.8} />
            新建节点
          </button>
          <div style={{ fontSize: text.xs, color: color.ink400, marginTop: 4 }}>
            或双击画布任意位置
          </div>
        </div>
      )}

      {/* 画布主区 */}
      <div
        ref={containerRef}
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleBackgroundDoubleClick}
        style={{
          position: 'absolute',
          inset: 0,
          background: color.paper,
          backgroundImage: `radial-gradient(circle, rgba(60, 48, 28, 0.06) 1px, transparent 1px)`,
          backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          backgroundPosition: `${vx}px ${vy}px`,
          cursor: dragRef.current?.kind === 'pan' ? 'grabbing' : 'default',
        }}
      >
        <div
          style={{
            position: 'absolute',
            transform: `translate(${vx}px, ${vy}px) scale(${zoom})`,
            transformOrigin: '0 0',
            width: 1,
            height: 1,
          }}
        >
          <svg
            style={{
              position: 'absolute',
              left: -10000,
              top: -10000,
              width: 20000,
              height: 20000,
              pointerEvents: 'none',
              overflow: 'visible',
              zIndex: 0,
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

      {refinePos && (
        <RefinePopover
          selectedNodeIds={selectedNodeIds}
          position={refinePos}
          onClose={() => setRefinePos(null)}
        />
      )}

      {writePos && (
        <WritePopover
          selectedNodeIds={selectedNodeIds}
          position={writePos}
          onClose={() => setWritePos(null)}
        />
      )}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}

      <NodeFullscreenModal />

      <Minimap />

      <ToastContainer />
    </div>
  );
}
