# 项目管理首页与多项目改造

变更日期：2026-05-10

## 背景

历史上 power-chat 是单画布产品：启动应用直接进入唯一的 `canvas_main` 画布，节点/边/消息全部存在同一份 db.json 中无任何项目维度的隔离。当用户在不同主题之间切换思考时，节点会全部堆在同一张画布上，缺乏"工作单元"概念，难以同时维护多条研究线。

本轮新增"项目"作为画布的顶层组织单位：启动应用先进入项目管理首页，用户在首页选中目标项目后才进入对应画布。

## 决策与边界

### 用户决策点（5 项）

1. **存储方案**：单 db.json + 表内 canvasId 隔离。**不**按项目分文件——避免 persistence.ts 重写文件路由，老 list 接口加 filter 即可
2. **路由方案**：Zustand 全局态切换视图（`viewStore.view: 'home' | 'canvas'`）。**不**引入 react-router——Electron 内 URL 无意义，避免无谓的依赖
3. **迁移策略**：自动迁移老 `canvas_main` 数据为"默认项目"，老用户无感升级
4. **认知画像隔离**：`cognitionUserId` 保持全局共享，所有项目共用同一份认知画像。语义对齐"画像是关于用户本人的，而不是关于某个项目的"
5. **HomePage UX 三件套**：卡片网格 + 最近打开优先排序 + 不要搜索框；新建项目后**首页内联**重命名（不自动跳画布）；删除二次确认（不做软删除/回收站）

### 不破坏的边界

- 撰写/提炼/分支/撤销/视口持久化/cognition 集成等既有功能 100% 保留
- 节点 id 全局唯一不变，跨项目无冲突；`streamingNodes` Set 仍按 nodeId 共享，无串扰风险
- mock-server 与 electron IPC 路由严格对称（项目宪法约束）

## 变更内容

### 1. 数据模型

**`src/types.ts`**：新增 `Project` 接口

```ts
interface Project {
  id: string;            // proj_ 前缀
  name: string;
  canvasId: string;      // 反向引用 1:1 关联的 canvas
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;  // 排序锚点
}
```

**`src/modules/persistence.ts`**：`Database` 接口新增 `projects` 表，`DEFAULT_DB.projects = {}`。`list<T>(table, filter?)` 既有 filter 函数式接口未改，新调用方传 `(item) => item.canvasId === xxx` 即可按 canvasId 过滤。

### 2. 后端模块

**`src/modules/canvas.ts`**：
- 删除 `SINGLE_CANVAS_ID = 'canvas_main'` 硬编码常量
- `getOrCreateCanvas()` → `createCanvas(canvasId)`，调用方明确指定 canvas id
- `getCanvasSnapshot()` → `getCanvasSnapshot(canvasId)`，nodes/edges/messages 严格按 canvasId 过滤；canvas 不存在返回 `null`
- `createNode()` 入参强制 `canvasId` 字段，从调用方传入而非常量赋值

**`src/modules/project.ts`**（新建）：
- `listProjects()`：按 `lastOpenedAt` 倒序优先 + `createdAt` 倒序兜底
- `createProject({ name })`：同时创建对应 canvas（1:1 绑定）
- `updateProject(id, patch)`：支持 `name` / `lastOpenedAt`，name 长度 ≤ 40
- `touchProject(id)`：更新 `lastOpenedAt` 给排序用
- `deleteProject(id)`：事务级联删除 canvas + 该 canvas 的全部 nodes / edges / messages
- `ensureDefaultProject()`：启动迁移幂等钩子。检测 `projects` 表为空 + `canvas_main` 存在 → 自动创建"默认项目"包住老数据

**`src/modules/conversation.ts` / `refine.ts` / `writer.ts`**：
- `branchNode` 创建子节点时复用 `parent.canvasId`
- `createRefine` / `createWrite` 从 `sourceNodeIds[0]` 推导 canvasId，并守卫所有源节点必须同 canvas（跨 canvas 提炼/撰写会让结果节点在调用方快照里消失）

### 3. IPC / mock-server 路由

`electron/src/ipc.ts` + `mock-server/src/server.ts` 1:1 对称新增 5 条 projects 路由：

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/projects` | 列出全部项目（已 sorted） |
| POST | `/api/projects` | 新建项目（同时创建 canvas） |
| PATCH | `/api/projects/:id` | 改名 |
| POST | `/api/projects/:id/touch` | 更新 lastOpenedAt |
| DELETE | `/api/projects/:id` | 级联删除 |

修改既有路由：
- `GET /api/canvas` → `GET /api/canvas?projectId=xxx`（projectId 必填，不带返回 400）
- `POST /api/nodes` body 必传 `canvasId` 字段（不带返回 400）

### 4. 前端架构

**新增 Store**（不持久化，每次启动从空开始）：
- `viewStore.ts`：`view: 'home' | 'canvas'` + `currentProjectId`，提供 `openProject(id)` / `goHome()`
- `projectStore.ts`：项目列表 + CRUD 动作（乐观更新 + 后端落库）

**新增模块**：
- `viewportStorage.ts`：替代旧版 zustand persist 中间件。按 `power-chat-viewport:${projectId}` 分键存储视口快照（不同项目独立持久化）

**新增页面**：
- `pages/HomePage.tsx`：卡片网格 + 最近打开优先 + 内联重命名 + ModalShell 二次确认删除
- `pages/CanvasPage.tsx`：从原 `App.tsx` 拆出。接收 `projectId` 入参，挂载时执行 `reset → loadViewport → hydrate` 三步流程；卸载时再次 reset 防数据残留

**App.tsx 改造**：
- 瘦身为路由壳：根据 `viewStore.view` 渲染 HomePage 或 CanvasPage
- `key={projectId}` 让切换项目时整棵 CanvasPage 子树卸载重建，杜绝 effect 顺序竞态

**canvasStore 改造**：
- 移除 zustand `persist` 中间件——nodes/edges/messages 全由后端真源提供，前端不再冗余 persist
- 新增 `reset()` action：切项目 / 卸载时清空所有内存态（含 undo 栈）防跨项目串扰
- 新增 `setUserHasMovedViewport(moved)` action：CanvasPage 从 viewportStorage 加载视口后同步写入

### 5. 测试基础设施

`tests/integration/helpers.ts`：
- 新增 `ensureTestProject()`：lazy 取首项或创建测试项目
- `createNode()` 自动调 `ensureTestProject` 拿 `canvasId`，所有既有调用透明适配
- 新增 `getCanvas()`：包装 `GET /api/canvas?projectId=xxx`，替代原直 `api('/api/canvas')`

`tests/integration/project/project.test.ts`（新建）：覆盖 19 条断言
- CRUD 完整链路 + 命名校验
- 删除级联（canvas + 节点同步消失）
- 多项目数据隔离（项目 A 的快照不返回项目 B 的节点）
- 边界：`GET /api/canvas` 不带 projectId 返回 400 / 不存在的 projectId 返回 404 / `POST /api/nodes` 不带 canvasId 返回 400

`package.json`：`pnpm test` 的 wait-on URL 从 `/api/canvas`（现需 projectId 会 400）改为 `/api/projects`（不带参数返回 200 + 数组）。

清理：删除 `tests/integration/**/*.test.js` 和 `tests/integration/helpers.js` 等过期 tsc 编译产物（Apr 26 残留），避免 ESM 解析时优先选 .js 覆盖 .ts。

### 6. 删除的代码

- `SINGLE_CANVAS_ID` 常量（canvas.ts）
- `getOrCreateCanvas()` 旧无参 API
- 老 zustand persist 中间件（canvasStore.ts）+ 配套 partialize/migrate/version 配置
- `tests/integration/**/*.test.js` 等过期编译产物

## 验证

- `pnpm type-check`：electron + mock-server + prototype 三端全部通过
- `pnpm test`：194 个集成/单元测试全部通过（含新增的 19 条 project 测试）
- 无引入新依赖（仍是 zustand + lucide-react + 现有栈）

## 后续可能的优化（本轮未做）

1. `listProjects` 内部两次全表扫描（先 `ensureDefaultProject` 再自查表）——量级很小可忽略
2. CanvasPage 的 `handleCollapseAll/ExpandAll` 闭包 deps 可改为 `useCanvasStore.getState()` 读取，但需要并发安全分析
3. Cognition 画像跨项目隔离（如未来用户反馈不同领域的项目相互污染）

## 关联文件清单

**新建**：`src/modules/project.ts` · `prototype/src/store/{viewStore,projectStore,viewportStorage}.ts` · `prototype/src/pages/{HomePage,CanvasPage}.tsx` · `tests/integration/project/project.test.ts`

**修改**：`src/types.ts` · `src/modules/{persistence,canvas,conversation,refine,writer}.ts` · `electron/src/ipc.ts` · `mock-server/src/server.ts` · `prototype/src/api/client.ts` · `prototype/src/store/canvasStore.ts` · `prototype/src/App.tsx` · `prototype/src/types.ts` · `tests/integration/helpers.ts` · `tests/integration/{contract,canvas,conversation/*,refine,writer,agent/loop}/*.test.ts` · 根 `package.json`

**删除**：`tests/integration/**/*.test.js` 等过期编译产物
