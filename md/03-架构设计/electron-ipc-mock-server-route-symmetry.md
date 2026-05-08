# Electron IPC 与 mock-server 路由对称性约束

**层级**：L2 约束条件
**形成于**：2026-05-09

## 约束

`prototype/src/api/client.ts` 是 **双适配** client：根据 `window.powerChat` 是否存在，**同一**业务路径（如 `/api/write`）会走两条完全不同的传输：

| 环境 | 实现 | 注册位置 |
|---|---|---|
| Electron 桌面应用 | `ipcMain.handle('rpc' / 'stream-start')` | `electron/src/ipc.ts` 的 `routes` 数组 + `openStream` 函数 |
| 浏览器 dev / 测试 | Express HTTP | `mock-server/src/server.ts` |

**任何新增的 HTTP path 必须在两端同时注册**，否则其中一个环境下会返回 404。

## 对称性细则

新增一个 `POST /api/foo`（带 SSE 流式）时，需要补 5 处：

1. `mock-server/src/server.ts`：`app.post('/api/foo', ...)` + `app.get('/api/foo/stream/:token', ...)`
2. `electron/src/ipc.ts`：
   - 顶部 `import * as foo from '../../src/modules/foo.js';`
   - `routes` 数组追加 `POST /api/foo` 条目（参数守卫 / 错误码 / 状态码与 mock-server 完全对齐）
   - `openStream` 函数追加 `/^\/api\/foo\/stream\/([^/]+)$/` 正则匹配分支

错误映射顺序、状态码、`error` code 字面量（如 `bad_request` / `not_streaming` / `streaming` / `branch_referenced`）必须**逐字对齐** —— 客户端层有 `error.message.includes(code)` 检测来区分错误类型，code 漂移会导致 Electron 环境下漏判。

## 历史踩坑

- 2026-05-09：`/api/write` 与 `/api/nodes/:id/messages/abort` 在 mock-server 早已注册，但 ipc.ts 漏注册——导致 Electron 内多选节点撰写、点中断按钮均直接 404。
  - 单元测试只跑 mock-server 路径，type-check 不会暴露此类漏洞。
  - 唯一可靠的发现手段：在 Electron 内手测一遍主流程，或为 ipc.ts 的 `routes` 数组补一份"穷举对齐"测试（对照 server.ts 路由表逐条断言）。

## 已知例外

`POST /api/__test__/reset` 与 `GET /api/__test__/streaming-info` 这两条测试辅助接口仅 mock-server 注册（`__test__` 前缀），ipc.ts 的 `__test__/reset` 是为单元测试可达保留的同名条目，无需在 Electron 实际暴露。
