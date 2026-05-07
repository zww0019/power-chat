# 思考画布 · Power Chat

> 把 AI 对话从"聊天框"解放到"画布"——为研究、推演、深度写作而设计的桌面应用。

聊天框把思考压缩成一维时间线：早期讨论污染后期判断、洞察一旦说出就消失在 scroll 历史里。**思考画布把思考的拓扑结构显式化**：分支代表子议题展开，提炼代表洞察沉淀，撰写把碎片对话变成第一人称叙事的文章。你能看见，并操控自己思考的图谱。

完整产品哲学见 [`docs/00-prd.md`](./docs/00-prd.md)。

<!--
截图占位：备好图后把下面 HTML 注释拆开即可启用。
推荐：一张能体现"画布 + 多个分支节点 + 一个琥珀色提炼节点"的主视图，建议 1600×1000，放到 docs/screenshots/canvas-hero.png

<p align="center">
  <img src="docs/screenshots/canvas-hero.png" alt="思考画布主视图" width="800">
  <br><sub>主视图：中心节点 → 分支子议题 → 琥珀色提炼节点</sub>
</p>
-->


---

## ✨ 它有什么不一样

### 🌳 画布 × 分支：思考的拓扑结构显式化
双击空白处建节点，悬停在 AI 回复上点 "↳ 从这里分支" 即可平行展开子议题。子节点继承父节点对话到分支点的快照（不可变）；之后修改父节点若触及子节点引用过的消息，会被拒绝并报 409——保护已经长出来的思考分支不被悄悄破坏。

### 💎 提炼：让发散的对话沉淀成结构化洞察
Shift+点击多选 N 个节点，输入意图问题，AI 综合所有源对话生成一份强制四栏结构的纲要：**【核心结论】【关键论据】【未解决 / 待验证】【可能的下一步】**。"未解决 / 待验证" 不可省略——这是产品对用户的诚实承诺，不假装清晰。提炼节点继续对话时上下文不会展开原始 inbound 对话，避免历史爆炸（"减熵"原则）。

### 🤖 Agent 模式：动作动词触发自主搜+读
当你用"搜/查/找/读"等动词请求外部信息时，AI 自动进入 ReAct 循环（思考→调工具→看结果→再思考→给最终回复），过程实时透明地推给你看，可中断。当前支持 `web_search` (Tavily) 和 `fetch_page`，单次最多 8 步 / 3 分钟。**启动权属用户**——LLM 通过 prompt 引导判断是否进入 Agent 模式，不在前端做关键词预检。

### ✍️ 撰写：第一人称叙事 + Humanizer 三角迭代去 AI 味
多选节点触发"撰写"，AI 不是"总结对话"，而是**以对话参与者的视角重新叙述思考过程**——用"我"的口吻，保留思考过程中的犹豫、试探、自我修正。然后进入 **Humanizer-rewrite 三角迭代**：执行者改写（6 种拟人化手法）→ 批评者检测（12 种 AI 高危特征清单：套话开头、过度连接词、线性逻辑、泛用比喻……）→ 裁判决策，最多 3 轮，主动消除 AI 痕迹。

### 🧠 多 Provider 思考链全链路
显式支持四个 Provider：`openai / deepseek / openrouter / custom`。思考链统一处理三种格式：DeepSeek-Reasoner 的 `reasoning_content`、Anthropic Extended Thinking 的 `thinking`、OpenRouter 的 `reasoning_details` 结构化数组。OpenRouter 的 `reasoning_details` 还会在多轮对话时回灌历史保持思考连续性。工具调用协议自适应（Function Calling / 文本 ReAct 降级），对你完全透明。

### 🔒 AI 不感知画布：保护用户思考主权
LLM 收到的永远是普通 OpenAI 协议的 messages 数组——"节点/分支/提炼"概念对 AI 不可见。这意味着：①LLM 可以随时替换；②上下文逻辑（继承、减熵）在产品层可单元测试；③AI 不会建议"分支"或"提炼"，结构化操作 100% 由你手动触发，防止 AI 替代你思考的退化形态。

---

## 📦 下载即用（推荐普通用户）

从 [GitHub Releases](https://github.com/zww0019/power-chat/releases) 下载对应平台安装包：

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS | `.dmg` / `.zip` | universal（arm64 + x64 合一） |
| Windows | `.exe` (NSIS) / `.zip` | x64 |
| Linux | `.AppImage` / `.deb` | x64 |

> 当前为 `prerelease`：每次 `main` 分支合并自动构建发布。首次启动会有系统 Gatekeeper / SmartScreen 警告（未做代码签名），允许后即可使用。

## 🚀 从源码运行（开发者）

**前置**：Node 22+ / pnpm 9

```bash
pnpm install
```

然后选择运行模式：

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 浏览器 dev：mock-server (3001) + Vite (5173)。默认 mock LLM，无需 API Key |
| `pnpm dev:electron` | Electron 原生窗口：Vite + Electron，业务代码与浏览器模式完全相同，仅 transport 从 HTTP 换成 IPC |
| `pnpm test` | 跑全套集成测试（mock-server + 21 测试文件 / 152 用例 / 10 skip） |

## 🤖 配置真实 LLM

默认 `mock` 模式可以跑 [试用脚本](#-试用脚本5-分钟体验)，但要接真实 LLM 需要：

```bash
USE_MOCK_LLM=0 pnpm dev
```

然后在应用内打开"设置"填写：

| 字段 | 必填 | 示例 |
|---|---|---|
| `provider` | 是 | `openai` / `deepseek` / `openrouter` / `custom` |
| `baseURL` | 是 | `https://api.deepseek.com/v1` |
| `model` | 是 | `deepseek-chat` / `claude-3.7-sonnet` / `gpt-4o-mini` |
| `apiKey` | 是 | 你的 API Key（仅写本地 `.data/db.json`，前端读到永远是脱敏值） |
| `llmFastModel` | 否 | 标题等高频低价值场景用的快模型（留空回退主模型） |
| `thinking` | 否 | 是否启用思考链（视 Provider 而定） |

> Provider 选择会影响 reasoning 字段在请求体里的格式（OpenRouter/OpenAI 用 `effort`，DeepSeek 不传，custom 用 `enabled:true`）以及历史 `reasoning_details` 是否回灌——这些差异由 `src/modules/llm-client.ts` 自动处理。

## 🛠 本地打包桌面应用

```bash
pnpm build:mac      # macOS universal: dmg + zip
pnpm build:win      # Windows x64: nsis + zip
pnpm build:linux    # Linux x64: AppImage + deb
```

每个命令依次跑：`prototype build` → `electron build:electron`（esbuild bundle）→ `electron-builder` 打包当前平台。产物输出到 `electron/release/`。

> 项目内置 GitHub Actions release workflow（`.github/workflows/release.yml`），main 分支合并后自动并行构建三平台并发布到 GitHub Releases，无需本地手工跑。

---

## 🎬 试用脚本（5 分钟体验）

启动 `pnpm dev` 后访问 http://localhost:5173，按以下顺序操作（基于内置 fixture：中国新茶饮出海研究）：

1. **双击空白处** → 新建对话节点
2. 输入并按 Enter：
   ```
   我在写一份"中国新茶饮 2026 出海机会"的深度报告。先梳理：
   当前中国新茶饮品牌出海的主要阻力有哪些？请按重要性排序。
   ```
   AI 流式回复（带"💭 思考过程"灰色折叠区）
3. **悬停 AI 回复** → 右下角浮出 "↳ 从这里分支"，点击 → 子节点出现
4. 子节点输入：`聚焦讲讲第 1 点供应链问题。重点讲蜜雪和霸王茶姬的解法。`
5. 回到父节点（点击它），再问：`三市场（欧盟/东南亚/北美）监管差异是什么？`，再次分支
6. **Shift+点击** 多选子节点（边框变紫）
7. 顶部 **"◆ 提炼 (N)"** → popover 输入意图 → 米色提炼节点生成
8. 点击提炼节点 → 在它上面继续对话（注意 ⓘ 提示：上下文只用提炼内容，不展开原节点）

---

## 🏗 架构亮点（贡献者视角）

```
            ┌─────────────────┐
            │  Renderer (UI)  │  prototype/  React + Vite + zustand
            │ React + Canvas  │
            └────────┬────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
  HTTP (浏览器)              IPC (Electron)
        │                         │
        ▼                         ▼
  mock-server/                electron/src/ipc.ts
        │                         │
        └─────────┬───────────────┘
                  ▼
        ┌─────────────────────┐
        │   src/modules/      │  唯一业务层（双 transport 共享）
        │  canvas / conv /    │
        │  refine / writer /  │
        │  agent / settings   │
        └─────────────────────┘
                  │
                  ▼  对外只发普通 OpenAI 协议
            ┌──────────┐
            │   LLM    │
            └──────────┘
```

- **单业务代码双 transport**：`src/modules/` 是唯一业务层，被 `mock-server`（Express + HTTP）和 `electron/src/ipc.ts`（IPC）共享。前端通过 `window.powerChat` 自动切换 transport，业务代码零分叉
- **OpenAPI 契约作为单一事实源**：[`docs/04-api-contract.yaml`](./docs/04-api-contract.yaml)（11 端点）是 mock-server 与 Electron IPC handler 的共同规范，保证两种 transport 行为一致
- **关键业务不变量有代码锚点**：`conversation.ts::assembleContext` 守"提炼减熵"、`branchNode` 守"分支快照不可变"、`toLLMMessage` 守"reasoning 不回灌 LLM"——工程上守不住的不变量等于没写
- **apiKey 端到端脱敏**：服务端对外永远返回 `sk-•••xxxx`，真实 key 仅写本地 JSON。前端表单用 dirty flag 防止把脱敏值写回覆盖真值

详细模块拓扑见 [`docs/05-modules.md`](./docs/05-modules.md)。

---

## 📂 项目结构

```
power-chat/
├── docs/                  # 设计文档（PRD、领域模型、API 契约、部署）
├── domain/                # 业务知识库（术语、规则、决策、模块说明）
├── src/                   # 共享业务模块（mock-server / Electron 共用）
│   └── modules/           # canvas / conversation / refine / writer
│                          # agent / settings / llm-client / persistence
├── prototype/             # React + Vite 渲染器
├── electron/              # Electron 壳（main + preload + IPC）
├── mock-server/           # Express + SSE（dev fallback）
├── tests/integration/     # 集成测试（21 文件 / 152 用例）
├── md/                    # 项目知识库（业务实体、规则、架构、技术决策）
└── .github/workflows/     # CI/CD（release.yml 多平台构建发布）
```

## 🧪 测试

```bash
pnpm test
```

预期：`152 passed | 10 skipped | 0 failed`。

测试覆盖：canvas（节点 CRUD、删除级联）、conversation（上下文组装、分支守卫、reasoning 隔离）、refine（提炼任务、四栏校验、INV-2 减熵）、agent（ReAct 限制、并发守卫、abort）、llm-client（buildBody、parseSSE、reasoning 三 Provider）、settings、tools、contract（OpenAPI 契约对齐）。

## 📘 完整文档

- [`docs/00-prd.md`](./docs/00-prd.md) — 原始 PRD（产品哲学、设计原则）
- [`docs/02-domain-model.md`](./docs/02-domain-model.md) — 领域模型（实体、状态机、12 条不变量）
- [`docs/04-api-contract.yaml`](./docs/04-api-contract.yaml) — OpenAPI 3.0.3 契约
- [`docs/05-modules.md`](./docs/05-modules.md) — 模块划分与依赖拓扑
- [`docs/07-deployment.md`](./docs/07-deployment.md) — 部署与打包指南
- [`docs/08-known-issues.md`](./docs/08-known-issues.md) — 已知遗留与下一轮迭代
- [`domain/`](./domain/) — 业务术语 / 规则 / 状态机（贡献代码前建议浏览）

---

## 🚧 已知遗留

- 应用未做代码签名，首次启动会有系统警告（[`docs/08-known-issues.md`](./docs/08-known-issues.md) #1）
- API Key 当前明文存于本地 JSON，待迁移系统 Keychain（#2）
- Undo / Redo 未接入（#7）
- 缩放 < 50% 的超折叠态色块视图未实现（#9）

完整清单见 [`docs/08-known-issues.md`](./docs/08-known-issues.md)。

---

<details>
<summary>📜 开发流程历史（spec-driven workflow）</summary>

本项目按 [prd-to-app](https://github.com/wwz/.claude/skills/prd-to-app) 工作流推进，所有阶段产物均已落地。

| 阶段 | 工件 |
|---|---|
| Stage 0 PRD 摄入与缝隙探查 | [`docs/00-gaps.md`](./docs/00-gaps.md) — 35 题已落定 + 2 条 PRD 修正项 |
| Stage 1 用户旅程脚本 | [`docs/01-journeys/`](./docs/01-journeys/) — 3 份真实业务旅程（茶饮出海研究） |
| Stage 2 领域模型初稿 | [`docs/02-domain-model.md`](./docs/02-domain-model.md) — 8 实体 + 12 条不变量 |
| Stage 3 可交互原型 + Mock | [`prototype/`](./prototype/) + [`mock-server/`](./mock-server/) |
| Stage 4 View Model + API 契约 | [`docs/04-view-models.md`](./docs/04-view-models.md) + [`docs/04-api-contract.yaml`](./docs/04-api-contract.yaml) |
| Stage 5 模块契约 + 测试骨架 | [`docs/05-modules.md`](./docs/05-modules.md) + [`tests/integration/`](./tests/integration/) |
| Stage 6 模块并行实现 | [`src/modules/`](./src/modules/) |
| Stage 7 切换 + 交付收尾 | [`electron/`](./electron/) + [`docs/07-deployment.md`](./docs/07-deployment.md) |

**与 PRD 的偏离**（详见 [`docs/00-gaps.md`](./docs/00-gaps.md)）：
- PRD-FIX-1：取消"30 秒自动折叠"——折叠完全用户主动
- PRD-FIX-2：取消"4 层分支深度限制"——可无限分支

</details>

---

## 📄 License

MIT — 见 [`LICENSE`](./LICENSE)
