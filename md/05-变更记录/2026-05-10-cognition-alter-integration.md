# Cognition (Alter) 用户认知建模接入

变更日期：2026-05-10

## 背景

主模型的 system prompt 长期是一段静态文本（`CONVERSATION_SYSTEM_PROMPT`），无法根据每个用户的思维风格做行为修饰。`/Users/wwz/workspace/Alter`（cognition）插件提供了"读对话历史 → 输出 persona_prompt"的反思引擎，把它接入后主模型在对话/撰写/提炼三个场景下能针对当前用户的认知偏好调整回答方式。

Alter 已被作者从 Python 库改造为 HTTP 服务（FastAPI + SQLite），用户用 docker compose 独立启动，power-chat 只做 HTTP 调用，不打包嵌入 Python 解释器。

## 决策与边界

### 决策点（用户拍板"按推荐异步"）

1. **服务进程关系**：Alter 由用户独立 `docker compose up`，power-chat 不打包嵌入。
2. **服务地址**：settings 加 `cognitionBaseUrl`，默认 `http://localhost:8000`，支持远程部署。
3. **persona_prompt 注入策略**：拼在静态 system prompt **之后**（基础人格优先，行为修饰后置），用 `[user-cognition directives]` 分隔标记。
4. **注入范围**：**对话 / 撰写 Phase1 / 撰写 Phase2 / 提炼**——4 个场景注入。**标题生成不注入**（无意义且会拖累快模型）。
5. **`user_id`**：用用户邮箱（默认 `cognitionUserId` 空字符串，UI 引导填入）。
6. **触发节奏**：每条 user 消息发出时构造 turns，**异步 fire-and-forget** 触发 cycle，**主对话不等待**——下一轮 sendMessage 才会用上新 persona_prompt（一轮滞后但用户永远零延迟感知）。
7. **容错降级**：cognition 服务不可达时静默回退缓存 personaPrompt，不阻断主对话；UI 用红角标提示连接状态。
8. **控制台访问**：设置页"打开 cognition 控制台"按钮调 `shell.openExternal(baseUrl)`，不内嵌 iframe。

### "不可缩减"约束

用户要求严格按插件使用方法接入，不做功能缩减。Alter 的 13 个 HTTP 接口在 power-chat 端**三处对称暴露**（ipc.ts / mock-server / client.ts），无一遗漏：

| Alter 接口 | 用途 |
|---|---|
| POST /v1/cycle | 反思循环（主对话后台触发） |
| POST /v1/replay | 历史回放调试 |
| GET / DELETE /v1/state/{user_id} | 完整画像查看 / 删除 |
| GET /v1/state/{user_id}/summary | 一行摘要 |
| GET /v1/explain/{user_id}?context= | 指令→模式→观测→证据追溯 |
| POST /v1/forget | 删除某 item |
| POST /v1/freeze / unfreeze | 冻结某 pattern 不再自动更新 |
| GET /v1/users / metrics | 列用户 / 调用统计 |
| GET / PUT /v1/settings | 读 / 改 cognition 内部配置 |
| GET /v1/health | 健康检查 |

cycle 的 `custom_routes`、replay 的 `force/persist/from_empty`、explain 的 `context` 等高级开关全部透传，无收窄。

## 变更内容

### 1. Schema 升级

`src/types.ts`：
- `Settings` 加 7 个 cognition 字段：`cognitionEnabled` / `cognitionBaseUrl` / `cognitionUserId` / `cognitionLastPersonaPrompt` / `cognitionLastPersonaVersion` / `cognitionLastContext` / `cognitionLastCycleAt`
- `Message` 加 `personaVersion?: string | null` —— cognition 反污染要求 assistant 消息携带生成时的 persona_prompt 版本号
- `LLMMessage` 加 `personaVersion?: string | null` —— 仅 cognition-client.buildCycleTurns 透传，不写入 OpenAI 请求体

`src/modules/settings.ts`：DEFAULT_SETTINGS 补全默认值。旧 `db.json` 通过 `getSettings` 的 `{...DEFAULT_SETTINGS, ...stored}` spread merge 自动补字段。

### 2. 核心模块新增 `src/modules/cognition-client.ts`

封装 13 个 HTTP 接口 + 异步缓存策略 + 两个工具函数：
- `composeSystemPrompt(base, personaPrompt)` —— 拼接策略守卫
- `buildCycleTurns(history, currentUser, version)` —— 跳过 system/tool 角色、assistant 必带 persona_version
- `getCachedInjection()` —— 主对话路径零延迟读缓存
- `fireAsyncCycle(turns)` —— fire-and-forget 后台触发，永不抛
- `runCycle(turns, opts)` —— 同步等待版本（设置页"立即刷新画像"用）
- 干预接口：`getState / deleteState / getSummary / explain / forget / freeze / unfreeze` 等
- 容错策略：所有 HTTP 调用走统一 `httpJson` 内层 catch，失败返回 null，永不抛给主流程

### 3. 5 个 LLM 场景注入

| 场景 | 文件:行号 | personaVersion 写入 | personaPrompt 注入 |
|---|---|---|---|
| 对话 | conversation.ts:172 sendMessage 创建 asstMsg 时 | ✓ | ✓ 拼到 CONVERSATION_SYSTEM_PROMPT 后 |
| 撰写 Phase1 | writer.ts:187 streamWrite 创建 asstMsg 时 | ✓ | ✓ assembleWriteInput 接收 personaPrompt |
| 撰写 Phase2 | writer.ts:282 humanizerExecRewrite | ✗ 复用 Phase1 asstMsg | ✓ HUMANIZER_EXECUTOR_PROMPT 拼接 |
| 提炼 | refine.ts:162 streamRefine 创建 asstMsg 时 | ✓ | ✓ assembleRefineInput 接收 personaPrompt |
| 标题生成 | conversation.ts:282 regenerateNodeTitle | ✗ 不写 | ✗ 不注入（决策 3） |

`conversation.ts:118 toLLMMessage` 透传 `personaVersion` 到下游，让 `buildCycleTurns` 能识别历史 assistant 来自哪个画像周期。

后台触发：`conversation.ts:194` `void cognitionClient.fireAsyncCycle(...)` —— 不 await。

### 4. 路由层三处对称（项目宪法）

`electron/src/ipc.ts`：13 条 `/api/cognition/*` 路由 + `shell-open-external` IPC handle（URL 白名单仅允许 http(s)）。

`mock-server/src/server.ts`：13 条同形路由（dev / 测试用）。

`prototype/src/api/client.ts`：13 个 `cognition*` 方法 + `openExternal`（Electron 走 IPC，浏览器降级到 `window.open`）。

`electron/preload.cjs`：暴露 `openExternal` IPC。

### 5. UI

`prototype/src/canvas/SettingsDialog.tsx`：模型设置弹窗加「认知建模 (Alter)」分组——开关 / 服务地址 / 用户 ID / 测试连接 / 打开控制台。

`prototype/src/App.tsx`：模型设置按钮上叠 cognition 状态角标——`error` 红色 / `disabled` 灰色 / `ok` 不显示。`hydrated + settingsOpen` 变化时自动探测健康。

### 6. 测试

新增 `tests/unit/cognition-client/cognition-client.test.ts`（22 个单测）：
- composeSystemPrompt / buildCycleTurns 核心工具函数
- 守卫（cognitionEnabled=false / userId 空 / 网络失败 → 不发请求 / 返回 null 不抛）
- 异步策略（fireAsyncCycle 成功更新缓存 / skipped 保留旧 personaPrompt / 失败完全不更新）
- health 检查 + overrideBaseUrl 支持
- 干预接口的 user_id 注入与 URL encode

整套单测 94 个全绿，三个 type-check（electron / mock-server / prototype）均通过。

## 用户使用流程

1. 启动 Alter 服务：`cd /Users/wwz/workspace/Alter && ./scripts/start.sh`（默认 :8000）
2. 在 power-chat 设置页「认知建模」分组填入用户 ID（推荐邮箱），点击「测试连接」确认
3. 正常对话——首次 N 轮无 personaPrompt，cognition 后台积累观测；触发反思后下一轮起 system prompt 含 `[user-cognition directives]`
4. 在设置页点「打开控制台」即可在浏览器看到 Alter 自带的 web UI（画像查看、settings 配置、metrics）

## 引用

- `src/modules/cognition-client.ts` —— 客户端核心
- `domain/decisions.md` 决策清单（如需补条目）
- `md/04-技术决策/cognition-alter-integration.md` —— 配套技术决策记录
