# 业务实体：Project（项目）

## 定义

**项目**是 power-chat 中组织画布的顶层单位。一个项目 1:1 关联一张画布，承载一个主题的全部节点 / 对话 / 提炼 / 撰写产物。

**L1 核心规则**：
- 项目与画布严格一对一（`Project.canvasId` 为外键）
- 删除项目级联清理对应 canvas + 全部 nodes / edges / messages
- 节点 id 全局唯一不依赖 canvasId 隔离（保留跨项目恢复/调试的可能性）

## 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `proj_` 前缀，建表时生成 |
| `name` | string | 长度 1-40，trim 后非空 |
| `canvasId` | string | 反向引用 1:1 关联的 canvas id，`canvas_` 前缀 |
| `createdAt` | ISO string | 创建时间，不可改 |
| `updatedAt` | ISO string | 任何字段改动同步刷新 |
| `lastOpenedAt` | ISO string \| null | 最近一次"从首页打开"时间，从未打开为 null |

## 状态流转

项目无显式状态机（不像 Node 有 `streaming/idle`）。生命周期是简单的"存在 / 已删除"二态：

```
创建（POST /api/projects）→ 存在
存在 + 用户从首页打开 → touchProject → lastOpenedAt 更新
存在 → 删除（DELETE /api/projects/:id）→ 实体 + 关联画布数据全部从 db.json 移除
```

## 业务规则（L2 约束）

1. **创建**：`name.trim()` 必须非空；同时创建对应 canvas（不允许"空项目"）
2. **改名**：长度 ≤ 40，超出 400
3. **触达**：`touchProject` 仅更新 `lastOpenedAt`，不改 `updatedAt`（避免每次打开都被排到列表顶部时同时显示"刚刚更新"，造成元信息混淆）
4. **删除**：事务级联——先删该项目下所有 nodes / messages / edges，再删 canvas，最后删 project 自身。任一步失败整个事务回滚（持久化层串行写保证原子性）
5. **打开顺序**：listProjects 排序为 `lastOpenedAt` 倒序优先 + `createdAt` 倒序兜底（永远未打开的项目排在打开过的之后）

## 自动迁移（L1 核心规则）

旧版本只有硬编码 `canvas_main` 单画布。`ensureDefaultProject()` 在 `listProjects` 入口幂等触发：

- 检测 `projects` 表为空 + `canvases.canvas_main` 存在 → 自动创建名为"默认项目"的 Project，`canvasId = 'canvas_main'`，绕开 createCanvas 直接绑定老画布
- `projects` 非空：已迁移过，no-op
- `canvas_main` 不存在：全新用户，no-op

## 与其他实体的关系

```
Project (1) ─── (1) Canvas
                  │
                  └── (1:N) Node ─── (1:N) Message
                              │
                              └── (1:N) Edge（branch / refine_input / write_input）
```

**强约束**：跨 canvas 的提炼 / 撰写不允许（refine.ts / writer.ts 守卫所有源节点必须同 canvas）。原因：快照按 canvasId 过滤，结果节点会落在其中一个 canvas，另一个 canvas 的快照中看不见这条边的对端。

## 持久化

所有 Project 落在 `db.json` 的 `projects` 表中（与 canvases / nodes / edges / messages 平级）。

## 视口持久化（项目维度）

每个项目的画布视口（pan + zoom）按 projectId 分键持久化在前端 `localStorage`：

- key 形如 `power-chat-viewport:proj_xxx`
- 只存视口字段 + `userHasMovedViewport` 标志位
- 节点/边/消息**不**前端 persist——后端 db.json 是真源

打开项目时 CanvasPage 先读视口快照写入 store，再调 `getCanvas(projectId)` 拉数据 hydrate。
