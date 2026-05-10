# 技术决策：Cognition (Alter) 接入策略

知识层级：**L1 核心规则**（必须严格遵守）+ **L2 约束条件**

记录日期：2026-05-10

---

## L1 · 核心规则（必须严格遵守）

### 规则 1：异步缓存——主对话路径绝不等 cycle 返回

**Why**：cognition 反思循环触发时要发 2-5 次 LLM 调用，耗时 5-15s。同步等待会让每条对话消息卡 5-15s（即使 cognition 命中冷却几乎瞬间，触发反思的那次仍然慢）。
**How to apply**：
- `sendMessage` 中必须用 `void cognitionClient.fireAsyncCycle(...)` —— **不能 await**。
- 主对话直接读 `getCachedInjection()`（settings 缓存读 ≈ 文件 IO 毫秒级）。
- cycle 失败 / 超时不能阻断主对话——任何 fetch / parse 异常都在 cognition-client 内层 catch，返回 null。
**反例**：`await cognitionClient.runCycle(...)` 在 sendMessage 主路径上直接调用——会让用户每条消息卡 5-15s（已通过 fireAsyncCycle 替代修正）。

### 规则 2：persona_version 反污染——assistant 消息必带 version

**Why**：cognition 用 `persona_version` 区分"当前周期产出的 assistant 输出"和"上一周期的"，避免把自己输出的 directive 又当新观测来归纳形成回路。这是插件的强约束，不可绕过。
**How to apply**：
- `Message.personaVersion` / `LLMMessage.personaVersion` / `TurnIn.persona_version` 三层都必须有此字段。
- 5 个 LLM 调用场景中——对话/撰写P1/提炼创建 asstMsg 时必须写 `personaVersion: inj.personaVersion`。
- `toLLMMessage` 必须透传 `personaVersion`，否则 buildCycleTurns 拿不到历史 assistant 的 version。
- 缺失时 fallback `'v0'`（baseline）—— 不能不传。
**反例**：把 `personaVersion` 字段从 Message schema 删除——会让 cognition 把所有 assistant 输出都当成"新观测"导致回路。

### 规则 3：13 个 Alter HTTP 接口三处对称暴露

**Why**：项目宪法要求 IPC（Electron 主进程）/ HTTP（mock-server）/ client.ts 三端路由对称——同一个接口必须三处都有，不能只有一处。否则 Electron 包和 dev 浏览器行为会出现不一致，前端 IPC 与 fetch 走不同分支时静默拿到不同结果。
**How to apply**：
- 任何新增 cognition 接口都必须改三处：`electron/src/ipc.ts` + `mock-server/src/server.ts` + `prototype/src/api/client.ts`。
- 三处的路径、参数名、错误码必须一致（`502 cognition_unreachable` 用于服务不可达）。
- 阶段 4 需求对齐审查会逐条核对覆盖矩阵——漏一个就是阻断级偏差。

---

## L2 · 约束条件（不可绕过）

### 约束 1：注入范围 = 4 个场景，标题生成不注入

| 场景 | 是否注入 personaPrompt | 是否写 personaVersion |
|---|---|---|
| 对话 (conversation.sendMessage) | ✓ | ✓ |
| 撰写 Phase1 (writer.streamWrite) | ✓ | ✓ |
| 撰写 Phase2 (writer.humanizerExecRewrite) | ✓ | ✗（复用 Phase1 asstMsg） |
| 提炼 (refine.streamRefine) | ✓ | ✓ |
| 标题生成 (regenerateNodeTitle) | ✗ | ✗ |

**Why**：标题生成用快模型 + 最长 30 字输出，注入 600-token persona_prompt 性价比为负。

### 约束 2：persona_prompt 拼在 base **之后**，用 `[user-cognition directives]` 分隔

**Why**：基础人格（`CONVERSATION_SYSTEM_PROMPT` 等）定义"是什么角色"，是优先级高的恒定指令；persona_prompt 是"针对当前用户的行为修饰"，是次级修饰。后置让 LLM 在角色定义之上叠加用户偏好。

**How to apply**：统一调 `cognitionClient.composeSystemPrompt(base, personaPrompt)`，禁止手拼。

### 约束 3：cognition 服务由用户独立 docker 启动，power-chat 不打包嵌入 Python

**Why**：嵌入 Python 解释器到 Electron 包会让 .app/.exe/.deb 体积翻数倍，且要解决跨平台 Python 依赖。Alter 已自带 docker-compose.yml，用户启动一行命令——分离部署比一体打包更可控。
**How to apply**：
- `cognitionBaseUrl` 默认 `http://localhost:8000`，但要支持用户改地址（远程部署场景）。
- 服务不可达时主对话必须降级正常运行——见规则 1。

### 约束 4：`user_id` 用邮箱（cognitionUserId 默认空字符串，UI 引导填入）

**Why**：邮箱跨设备稳定；设备指纹会让用户换电脑就丢画像。空字符串默认值确保用户必须主动填——避免不同用户共用同一画像。
**How to apply**：
- `resolveTarget()` 守卫——`cognitionUserId` 为空时不发请求。
- `/v1/state/{user_id}` 路径要 URL encode（邮箱含 `@`）—— `encodeURIComponent` 已在 cognition-client 内做。

---

## L3 · 实现参考（可调整）

### 参考 1：`personaVersion` 用 `Date.now().toString(36)` 生成

简短足够区分（约 8 字符），不要求加密强度，仅作"同周期 vs 跨周期"标识。

### 参考 2：`turn_id` 用 `idx + role + content hash`

cognition 用 turn_id 关联同一条 turn 的多次调用记录。简单 hash 够用，不要求安全性。

### 参考 3：缓存策略——skipped 不覆盖 lastPersonaPrompt

cognition 命中冷却（每 12 轮或 30min 一次）时返回 `persona_prompt: null + skipped: true`。此时 fireAsyncCycle 只更新 `lastCycleAt` 和 `lastContext`——**保留上次有效 personaPrompt**，避免用户活跃期被重置成空。

---

## 引用

- `src/modules/cognition-client.ts` —— 实现入口
- `tests/unit/cognition-client/cognition-client.test.ts` —— 上述规则的单测约束
- `md/05-变更记录/2026-05-10-cognition-alter-integration.md` —— 变更记录
- /Users/wwz/workspace/Alter/README.md —— Alter 插件文档
- http://localhost:8000/openapi.json —— Alter HTTP API 完整规范
