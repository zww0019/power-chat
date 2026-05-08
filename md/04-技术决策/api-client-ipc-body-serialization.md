# API 客户端 IPC body 序列化约束

**层级**：L2（约束条件，不可绕过）
**适用范围**：`prototype/src/api/client.ts` 的 `request()` 函数及其调用方

## 约束

凡是请求体可能包含**可选字段**（TypeScript `field?: T` / `field?: T | null`，运行时可能为 `undefined`）的 API，调用 `request()` 时必须**直传对象**，不能传 `JSON.stringify(...)` 序列化字符串。

```ts
// ✅ 正确：含 Message / Node 等带可选字段的对象
return request<void>('/nodes/restore', { method: 'POST', body: snapshot });

// ❌ 错误：JSON.stringify 会静默丢弃 undefined 的可选字段
return request<void>('/nodes/restore', { method: 'POST', body: JSON.stringify(snapshot) });
```

## 原因

应用同时支持两条路径：

- Electron IPC：`window.powerChat.request(method, path, body)`，走 V8 结构化克隆，**保留 undefined**
- 浏览器 fetch：`fetch(url, { body })`，body 必须是字符串，需 `JSON.stringify`

如果调用方先 `JSON.stringify` 再交给 `request()`：

1. IPC 路径内部 `JSON.parse` 还原对象，但**`JSON.stringify` 阶段已经把 undefined 字段抹除**——IPC 传到主进程的对象字段缺失
2. 后端 `restoreNode` 写入持久化时字段为 `undefined`，读取后业务代码遇到非预期 undefined 引发错误

`Message` 上受影响的可选字段：`reasoningContent` / `wasResumed` / `agentTrace` / `reasoningDetails`。

## 实现细节

`request()` 已支持 `body: unknown`：

- 字符串 → IPC 路径 `JSON.parse`，fetch 路径直传
- 对象 → IPC 路径直传，fetch 路径 `JSON.stringify`

旧调用点（`createNode` / `branchNode` / `updateNode` 等）传 `JSON.stringify(req)` 仍能工作——这些请求体的类型不含可选字段，不受影响，无需改造。

新增 API 时若请求体类型含 `?` 字段，必须直传对象。

## 关联

- 触发场景：撤销删除节点（POST `/api/nodes/restore`）
- 修复位置：`prototype/src/api/client.ts:38-79, 98-103`
- 同源约束：`Edge.inheritedUntilSequence: number | null`（必填，可为 null 但不可 undefined），不在本约束适用范围
