import { useEffect, useRef, useState, useCallback, type CSSProperties } from 'react';
import { Sparkles, HelpCircle, Settings as SettingsIcon, MousePointerClick, Minimize2, Maximize2 } from 'lucide-react';
import { useCanvasStore } from './store/canvasStore';
import { api } from './api/client';
import { CanvasNode } from './canvas/Node';
import { EdgeLine } from './canvas/Edge';
import { RefinePopover } from './canvas/RefinePopover';
import { SettingsDialog } from './canvas/SettingsDialog';
import { HelpDialog } from './canvas/HelpDialog';
import { NodeFullscreenModal } from './canvas/NodeFullscreenModal';
import { Minimap } from './canvas/Minimap';
import { ToastContainer } from './canvas/ToastContainer';
import { computeFitToNodesViewport } from './canvas/viewport-fit';
import { color, text, space, radius, shadow, font, motion } from './styles/theme';

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

// 画布缩放范围常量：wheel 缩放和 pinch 手势缩放共用，保持体验一致
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;

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
  const setSystemViewport = useCanvasStore((s) => s.setSystemViewport);
  const userHasMovedViewport = useCanvasStore((s) => s.userHasMovedViewport);

  const [refinePos, setRefinePos] = useState<{ x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // 首次进入：从 mock server 拉初始 canvas（单画布）
  useEffect(() => {
    if (hydrated) return;
    api.getCanvas().then(hydrate).catch((e) => console.error('hydrate failed', e));
  }, [hydrated, hydrate]);

  // hydrate 完成后若用户从未操作过视口（首次启动 / 清缓存），自动 fit-to-nodes 居中。
  // 修复"后端 viewport 永远是 0/0/1，节点漂移到 Y=1500+ 后启动看不见"的根因。
  // 仅触发一次：依赖 hydrated；fit 完成后若用户拖动会通过 setViewport 把 userHasMovedViewport 置 true，
  // 重启再走此分支时直接 short-circuit，尊重 localStorage 视口。
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

  // 全局键盘监听：Delete / Backspace 删除 selectedEdgeId 或 activeNodeId。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
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

  // 同步 ref：native wheel handler 闭包外读最新值；RAF 内一帧多写时 setState 异步，
  // 必须手动同步 ref 才能避免下一帧基于旧值。
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

  // 在指定逻辑坐标处创建对话节点：所有"新建节点"路径（双击 / 空状态主按钮 / 未来快捷键）共用。
  // 失败 swallow 为 console.error，避免阻断画布交互；失败时画布状态不变。
  const createNodeAt = useCallback(
    async (logicalX: number, logicalY: number) => {
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
    },
    [upsertNode, setActiveNode],
  );

  // 双击空白创建节点（PRD §4.1）：把鼠标落点的屏幕坐标换算为画布逻辑坐标。
  const handleBackgroundDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    void createNodeAt((screenX - vx) / zoom, (screenY - vy) / zoom);
  };

  // 空状态主按钮：在视口中心略偏上 80px 创建节点（避开页面顶部工具栏的视觉遮挡）。
  const createNodeAtViewportCenter = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const screenX = rect.width / 2;
    const screenY = rect.height / 2;
    void createNodeAt((screenX - vx) / zoom, (screenY - vy) / zoom - 80);
  };

  // 画布 wheel 处理（缩放 + 平移）：原生 addEventListener + {passive:false} 注册以便
  // preventDefault 阻止浏览器默认滚动；RAF 节流合并同帧多次事件；zustand 写延后到滚轮停止
  // 150ms 后一次性 flush，避免 wheel 期间高频广播导致全画布订阅者重渲染。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ZOOM_K = 0.0015;       // 指数映射系数：每像素滚动对应恒定百分比缩放
    const DELTA_CLAMP = 50;      // 设备归一化：触控板≈±3、鼠标≈±100~150，clamp 到统一量级
    // 150ms 比典型触控板惯性滚动（约 300–500ms）短得多，但比单次 RAF（16ms）长两个数量级，
    // 足以合并一次连续滑动的全部事件，同时不让用户感知到"状态落盘延迟"。
    const PERSIST_DEBOUNCE = 150;

    const accum = { zoomDeltaY: 0, panDx: 0, panDy: 0, pivotX: 0, pivotY: 0 };
    let rafId: number | null = null;
    let persistTimer: number | null = null;

    const flushPersist = () => {
      setViewport(vxRef.current, vyRef.current, zoomRef.current);
      persistTimer = null;
    };
    const schedulePersist = () => {
      if (persistTimer != null) clearTimeout(persistTimer);
      persistTimer = window.setTimeout(flushPersist, PERSIST_DEBOUNCE);
    };

    // RAF 帧回调：把本帧内累积的所有 wheel 事件合并为一次状态更新。
    // 命名为 flush 以区别于 flushPersist——前者刷新 React state（驱动渲染），
    // 后者刷新 zustand store（驱动持久化），两者时机不同不可混淆。
    const flush = () => {
      rafId = null;
      let nextVx = vxRef.current;
      let nextVy = vyRef.current;
      let nextZoom = zoomRef.current;

      if (accum.zoomDeltaY !== 0) {
        const dy = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, accum.zoomDeltaY));
        // 指数映射：避免线性加法在高缩放下"加速失控"
        nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomRef.current * Math.exp(-dy * ZOOM_K)));
        // 围绕鼠标基点缩放：保持 pivot 处的逻辑坐标不变，鼠标"贴住"画布内容
        // 推导：logicCoord = (pivot - v) / zoom；newV = pivot - logicCoord * nextZoom
        //        化简得 newV = pivot - (pivot - v) * (nextZoom / zoom)
        // pivot 取批次内最后一次 wheel 事件坐标（而非第一次）：惯性结束位置更接近用户手指/光标实际位置，
        // 视觉上比用第一次坐标"贴合"感更强。
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
      // 节点内滚动容器豁免（非缩放手势）：让节点自己消费 wheel，画布不响应；
      // 缩放手势 (ctrl/⌘) 在节点上仍穿透到画布，保留"节点上按修饰键缩放画布"的快捷手势。
      const target = e.target as Element | null;
      if (target?.closest?.('[data-canvas-node-scroll]') && !(e.ctrlKey || e.metaKey)) return;

      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
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
        // 组件卸载后 debounce timer 的回调不会再执行（window.setTimeout 被 clear 了），
        // 必须在此同步写入一次，否则最后一批 wheel 操作的视口变化会永久丢失。
        flushPersist();
      }
    };
  }, [setViewport]);

  // macOS Electron 双指捏合手势缩放：主进程通过 before-input-event 拦截 gesturePinch*
  // 并通过 IPC 发送 pinch-gesture 事件。渲染进程在此订阅并将 scale 转换为视口缩放，
  // 围绕双指中心点 (pivot) 保持内容贴合。手势结束 (pinchEnd) 时调用 setViewport 持久化。
  useEffect(() => {
    const pw = (window as any).powerChat;
    if (!pw?.isElectron || !pw?.onPinchGesture) return;

    let pinchStartZoom = 1;
    let pinchStartVx = 0;
    let pinchStartVy = 0;

    const unsub = pw.onPinchGesture((data: any) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pivotX = data.x - rect.left;
      const pivotY = data.y - rect.top;

      if (data.type === 'pinchBegin') {
        pinchStartZoom = zoomRef.current;
        pinchStartVx = vxRef.current;
        pinchStartVy = vyRef.current;
      } else if (data.type === 'pinchUpdate') {
        const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchStartZoom * data.scale));
        const ratio = newZoom / pinchStartZoom;
        const newVx = pivotX - (pivotX - pinchStartVx) * ratio;
        const newVy = pivotY - (pivotY - pinchStartVy) * ratio;
        zoomRef.current = newZoom;
        vxRef.current = newVx;
        vyRef.current = newVy;
        setZoom(newZoom);
        setVx(newVx);
        setVy(newVy);
      } else if (data.type === 'pinchEnd') {
        setViewport(vxRef.current, vyRef.current, zoomRef.current);
      }
    });

    return unsub;
  }, [setViewport]);

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
      {/* 顶部浮动工具栏：blur 胶囊 + 三段式（Logo / 中信息 / 右动作）*/}
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
        {/* 左：Logo 胶囊 */}
        <div
          style={{
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            background: 'rgba(251, 249, 242, 0.72)',
            backdropFilter: 'blur(20px) saturate(140%)',
            WebkitBackdropFilter: 'blur(20px) saturate(140%)',
            border: `0.5px solid ${color.ink200}`,
            padding: `8px 14px`,
            borderRadius: radius.pill,
            boxShadow: shadow.sm,
            fontSize: text.sm,
            fontWeight: 600,
            color: color.ink800,
            letterSpacing: '-0.01em',
          }}
        >
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
          思考画布
        </div>

        {/* 中：提炼按钮（多选时） */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: space.s3 }}>
          {selectedNodeIds.length > 0 && (
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
          <ToolbarIconButton onClick={() => setSettingsOpen(true)} title="模型设置">
            <SettingsIcon size={17} strokeWidth={1.6} />
          </ToolbarIconButton>
        </div>
      </div>

      {/* 空状态：插画 + 主标题 + 副标题 + 主按钮 */}
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

      {/* 画布主区：奶油底 + 暖灰圆点网格 */}
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
          {/* SVG 边层：zIndex 0 与节点 div 的 zIndex 1 配合，让连线稳定落在节点之下。
              不依赖 DOM 顺序的隐式层叠（之前发生过：折叠节点 overflow:hidden 建立新 stacking context
              后，浏览器在某些缩放/层叠场景下会把连线浮到节点上面，遮住卡片文字）。 */}
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

          {/* 节点 */}
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

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}

      <NodeFullscreenModal />

      <Minimap />

      <ToastContainer />
    </div>
  );
}
