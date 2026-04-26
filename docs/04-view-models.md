# View Models

> 前端组件的数据视图。每个 VM 描述一个**渲染单元**所需的完整数据形状。
>
> 设计原则：
> - VM 是前端视角；API 是资源视角；中间靠组合/选择。
> - 显式标注哪些是后端字段、哪些是前端派生。
> - 不要让派生字段污染后端响应。

---

## 1. CanvasInitialVM（首屏全量快照）

**消费组件：** `App.tsx` 的 `useEffect(hydrate)` 触发一次。
**触发时机：** 应用启动 / 切换 canvas（MVP 单画布）。
**对应 API：** `GET /api/canvas`

```typescript
interface CanvasInitialVM {
  canvas: {
    id: string;
    viewportX: number;
    viewportY: number;
    viewportZoom: number;          // [0.25, 2.0]
    createdAt: ISO8601;
    updatedAt: ISO8601;
  };
  nodes: NodeData[];               // 见 §2
  edges: EdgeData[];               // 见 §3
  messages: MessageData[];         // 见 §4，扁平列表，前端按 nodeId+sequence 索引
}
```

**关键决策：** 首屏一次性返回所有 nodes/edges/messages。MVP 单用户单画布场景下数据量小（< 10MB），不做分页。Stage 6 转 Electron 时此请求变 IPC `canvas:hydrate`，schema 不变。

---

## 2. NodeVM（节点渲染态）

**消费组件：** `canvas/Node.tsx`
**消费来源：** zustand store 派生（不直接来自 API）

```typescript
interface NodeVM {
  // === 来自 NodeData (后端字段) ===
  id: string;
  type: 'dialogue' | 'refined';
  positionX: number;
  positionY: number;
  width: number;                   // 默认 380
  collapsed: boolean;
  title: string | null;            // null 时显示占位文案

  // === 派生字段（前端计算）===
  isActive: boolean;               // store.activeNodeId === id
  isSelected: boolean;             // store.selectedNodeIds.includes(id)
  isStreaming: boolean;            // store.streamingByNode[id] === 'streaming'
  messages: MessageVM[];           // 按 sequence 升序的消息列表
  displayTitle: string;            // 派生：title ?? (isRefined ? '提炼节点' : '新节点')
  iconChar: '◆' | '💬';            // 派生：type 决定
}
```

**派生函数清单（在 store/canvasStore.ts 实现）：**
- `selectMessagesOfNode(state, nodeId)` → MessageVM[]
- `selectEdgesOfNode(state, nodeId)` → { inbound, outbound }

**视觉配置（不进入 VM，在组件内静态决定）：**
- 对话节点：白底 / 细灰边框 / 💬 图标
- 提炼节点：浅米底（#fdf6e3）/ 稍粗边框 / ◆ 图标
- 活跃节点：淡蓝边框（#6366f1）+ 1.03x 缩放

---

## 3. EdgeVM（边渲染态）

**消费组件：** `canvas/Edge.tsx`

```typescript
interface EdgeVM {
  id: string;
  parentNodeId: string;
  childNodeId: string;
  edgeKind: 'branch' | 'refine_input';
  // 派生：从 nodes 字典查到的两端坐标
  x1: number; y1: number;
  x2: number; y2: number;
}
```

**关键决策：** EdgeVM 不带视觉样式字段——所有边视觉一致（PRD §3.2 克制要求）。`edgeKind` 仅用于 Stage 5 的不变量校验，不影响渲染。

---

## 4. MessageVM（消息渲染态）

**消费组件：** `canvas/Node.tsx` 内的 `MessageBubble`

```typescript
interface MessageVM {
  id: string;
  role: 'user' | 'assistant';
  content: string;                 // 流式时为部分内容
  reasoningContent: string | null; // 思考模式产出，可空
  status: 'complete' | 'streaming' | 'partial' | 'error';
  sequence: number;
  // 派生
  hasReasoning: boolean;           // !!reasoningContent && reasoningContent.length > 0
  isStreaming: boolean;            // status === 'streaming'
  showCursor: boolean;             // isStreaming && role === 'assistant'
}
```

**关键决策：** `reasoningContent` 在 VM 中保留原文，UI 控制是否折叠展开（流式期展开，完成后自动折叠）。这确保 INV-11（思考内容不入下游）：reasoning 始终独立字段，不被拼接到 content。

---

## 5. RefinePopoverVM

**消费组件：** `canvas/RefinePopover.tsx`

```typescript
interface RefinePopoverVM {
  selectedNodeIds: string[];       // store.selectedNodeIds
  popoverPosition: { x: number; y: number };  // 屏幕坐标，已 clamp 到视野内（E2 决策）
  intentDraft: string;             // 用户输入意图（可空 = 综合性提炼）
  submitting: boolean;             // 提交中禁用按钮
}
```

**派生：弹窗位置计算逻辑（App.tsx::handleRefineClick）**
1. 计算被选中节点的几何中心（画布逻辑坐标）
2. 转屏幕坐标：`screenX = cx * zoom + vx`
3. 边界 clamp：保证 popover 完整出现在视野内（E2 决策）

---

## 6. ToolbarVM

**消费组件：** `App.tsx` 顶部工具栏

```typescript
interface ToolbarVM {
  appName: '🧠 思考画布 · MVP 原型';
  selectedCount: number;           // store.selectedNodeIds.length
  showRefineButton: boolean;       // selectedCount > 0
  totalNodes: number;              // Object.keys(store.nodes).length
  zoomPercent: number;             // Math.round(store.canvas.viewportZoom * 100)
}
```

---

## 7. SettingsVM（Stage 6 落地，Stage 4 先固化契约）

**消费组件：** 未实现，预留为 Settings.tsx
**对应 API：** `GET /api/settings`, `PUT /api/settings`, `POST /api/settings/test`

```typescript
interface SettingsVM {
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;               // UI 显示时脱敏 sk-•••••3a9f
  thinkingModeEnabled: boolean;
  privacyAcknowledged: boolean;
  // 派生
  isConfigured: boolean;           // baseUrl && model && apiKey 都非空
  apiKeyMasked: string;            // 派生：apiKey.slice(0,3) + '•••••' + apiKey.slice(-4)
  testStatus: 'idle' | 'testing' | 'ok' | 'failed';  // 仅 UI 状态，不持久化
}
```

---

## 8. StreamEventVM（SSE 事件）

**消费组件：** `api/client.ts::consumeSSE`

```typescript
type StreamEventVM =
  | { type: 'reasoning'; delta: string }    // 思考内容增量
  | { type: 'content'; delta: string }       // 正文内容增量
  | { type: 'done'; messageId: string }      // 流式完成
  | { type: 'error'; error: string };        // 流式错误
```

**关键决策：** 使用 OpenAI 兼容协议风格的 delta 推送，前端 store 累加。reasoning 和 content 在网络层完全独立的事件类型——这是 INV-11 在协议层的体现。

---

## 9. View Model → API 契约的折叠

| View Model | 底层 API 端点 | 折叠方式 |
|---|---|---|
| CanvasInitialVM | `GET /api/canvas` | 直接返回，包含 nodes/edges/messages 嵌套 |
| NodeVM (data 部分) | `POST /api/nodes`, `PATCH /api/nodes/{id}` | 只返回 NodeData，前端组合 |
| EdgeVM (data 部分) | `POST /api/nodes/branch`, `POST /api/refine` | 边由分支/提炼操作隐式产生 |
| MessageVM (data 部分) | `POST /api/nodes/{id}/messages` (SSE) | 流式推送，前端拼装 |
| RefinePopoverVM | `POST /api/refine` + `GET /api/refine/stream/{token}` | 写命令 + 读流，分两步 |
| SettingsVM | `GET/PUT /api/settings`, `POST /api/settings/test` | 读模型 / 写命令 / 测试命令分离 |

**避免的反模式：**
- ❌ `GET /api/canvas-page` 返回前端用的派生字段（如 `displayTitle`）
- ❌ `POST /api/refine-and-stream` 把命令和流读合并（设计上读写应分离）
- ❌ `GET /api/node/{id}/full` 包含父链所有内容（破坏分页可能性）

**采用的模式：**
- ✅ 命令端点（`POST /nodes/branch`）只返回受影响的资源（新节点 + 新边）
- ✅ 读端点（`GET /canvas`）返回完整快照，前端做派生
- ✅ 流式数据（SSE）独立通道，与同步 API 不混用

---

## 10. 前端派生字段的来源追溯

为了避免派生字段污染契约，明确标记哪些字段必须在前端计算：

| 派生字段 | 来源 | 不能进 API 的原因 |
|---|---|---|
| `node.displayTitle` | `node.title ?? defaultLabel` | UI 文案，会改变 |
| `node.iconChar` | `node.type` 映射 | UI 决定，可能换图标 |
| `node.isActive` | 客户端 store 状态 | 不持久化，运行时 |
| `node.isStreaming` | 客户端 store 状态 | 网络层局部状态 |
| `message.hasReasoning` | `!!reasoningContent` | 简单布尔，前端算 |
| `settings.apiKeyMasked` | UI 脱敏 | 后端不应做 UI 决策 |
| `toolbar.zoomPercent` | `viewportZoom * 100` | UI 表达 |

---

## 11. 待解决（Stage 5/6 处理）

- [ ] CanvasInitialVM 中 messages 是扁平列表 vs 嵌套在 nodes 下？倾向扁平（前端按 nodeId 索引），契约简单且支持后续分页
- [ ] 流式 reasoning 的累积长度无上限——前端是否需要分块持久化？倾向：每个 chunk 调一次 store.append，由 zustand persist 防抖处理
- [ ] SettingsVM 中 apiKey 在 GET 响应里返回脱敏值还是空字符串？倾向脱敏值（让 UI 能显示 sk-•••3a9f）；写入只接受非脱敏值
- [ ] 多个 view model 共享 NodeData 时是否需要 `?fields=` 选择？倾向：MVP 不做，全量返回，二阶段如果有性能问题再做
