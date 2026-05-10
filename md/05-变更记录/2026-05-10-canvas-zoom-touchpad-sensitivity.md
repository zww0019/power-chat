# 画布缩放：触控板单独提系数

变更日期：2026-05-10

## 背景

用户报告"双指缩放又不能用了"。代码与产物排查表明主进程 `setVisualZoomLevelLimits(1,1)` 与渲染进程 `wheel + ctrlKey` handler 均完好（dist/main.cjs 当日重编、grep 命中）。真实根因落在敏捷度：单一 `ZOOM_K=0.0015` 同时控制鼠标滚轮（每事件 deltaY≈±100~150，单步 ~15%，体感正常）与 macOS 触控板（每事件 deltaY≈±3，单步 ~0.5%，30 次手势才累积 15%，体感"几乎不动"——主观判定为"失效"）。

## 决策

按设备分路。位置：`prototype/src/App.tsx` useEffect 注册 wheel 监听处。

| 路径 | ZOOM_K | DELTA_CLAMP |
|---|---|---|
| 鼠标 | 0.0015（保留原值，不影响既有体感） | 50 |
| 触控板 | 0.008（≈5.3× 鼠标系数） | 不 clamp（原始 deltaY 远小于 50） |

设备识别：在 `if (e.ctrlKey || e.metaKey)` 缩放分支内，用 `e.deltaMode === 0 && Math.abs(e.deltaY) < 50` 判触控板。50 是经验阈值——macOS Chromium 触控板捏合合成的 wheel deltaY 是浮点 ±2~±8，鼠标滚轮通常整数 ±100~150，阈值远离两者。

`accum` 新增 `zoomDevice: 'touchpad' | 'mouse'` 字段，按本批次最后一次 wheel 事件来源决定本帧用哪套系数。混用罕见，按最后一次决定即可。

## 不动的部分

- 主进程 `setVisualZoomLevelLimits(1,1)` 不动（已生效，强制把 macOS 触控板捏合路由到 wheel + ctrlKey 通路）。
- RAF 节流、150ms persist debounce、节点 `[data-canvas-node-scroll]` 豁免、围绕 pivot 的缩放数学不动。
- 不引入 macOS 原生 `gesturestart/gesturechange` 事件——避免跨平台分支与 md/04 §5 已记录的"非标准事件回归"教训。

## 验证

- type-check 全通过（root + prototype）。
- canvas 单元测试 28/28 通过（与缩放交互无相交，作为回归兜底）。
- 触控板捏合属 UI 交互，需真机验证；预期单次事件步长由 ~0.55% 提升到 ~2.4%。

## 后续可调点

- 0.008 是基于"5× 旧系数"的经验值。若用户真机反馈"过快"可降到 0.005~0.006；"仍偏慢"可升到 0.012。仅改 `ZOOM_K_TOUCHPAD` 一个常量。
- 设备识别阈值 50 仅在用户使用极低分辨率鼠标（每事件 deltaY < 50）时可能误判为触控板；目前未见此类反馈。
