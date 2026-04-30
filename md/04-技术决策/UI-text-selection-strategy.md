# 画布 UI 文本选中策略

**层级**：L2 约束条件
**适用范围**：`prototype/` 前端

## 约束

应用根 div（`prototype/src/App.tsx` 内 `position: fixed` 的最外层容器）必须保持 `user-select: none`。

任何需要让用户选中复制文本的容器（如展开态消息体、输入框内文字、未来可能的引用预览等），必须在自身局部覆盖回 `user-select: text` + `WebkitUserSelect: text` + `cursor: text`。

## 为什么不直接在根 div 放开

画布交互大量依赖鼠标按下/拖动手势：

- 节点 header 拖动（`Node.tsx`）
- 折叠卡整张卡片拖动（`Node.tsx`）
- 画布空白处 pan（`App.tsx`）
- 边/选区操作（`App.tsx` selection 逻辑）

如果根 div 不禁选，用户在节点 header 或折叠卡上按下并轻微移动鼠标，会触发文本框选高亮，与节点拖拽手势冲突，体验极差。

## 当前已开放选中的容器

- `prototype/src/canvas/NodeChatPanel.tsx` 的 `bodyContainerStyle`：覆盖 `DialogueNodeBody` 与 `RefinedNodeBody` 两个展开态消息体（inline + fullscreen 两种 mode 共用此函数）。
- `<textarea>` / `<input>` / 工具栏 `<button>`：UA 默认样式自带可交互行为，无需额外处理。

## 新增可选区域的标准做法

```ts
const selectable: React.CSSProperties = {
  userSelect: 'text',
  WebkitUserSelect: 'text',
  cursor: 'text',
};
```

WebKit 前缀必须保留：Electron / Tauri 内嵌的 WebView 走 WebKit 内核。

## 为什么不需要 `stopPropagation`

`App.tsx` 中 `handleBackgroundPointerDown` 用 `if (e.target !== e.currentTarget) return;` 守护——pan 仅在 pointerdown 直接命中画布根容器时启动，子级冒泡上来的事件不会启动 pan。节点拖拽只挂在 header 的 `onPointerDown`，消息文字区不在其路径上。所以仅 CSS 层覆盖 `user-select` 即可，不需要再用 `stopPropagation` 拦截。
