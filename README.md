# 思考画布（Power Chat）

> 一种为深度思考而设计的对话画布。让 AI 时代的研究、思考、推演，不再被聊天框这个旧 UI 隐喻所束缚。

完整产品哲学见 [`docs/00-prd.md`](./docs/00-prd.md)。

---

## 工程状态：Stage 7 / 7（交付收尾完成）

按 [prd-to-app](https://github.com/wwz/.claude/skills/prd-to-app) 工作流推进，所有阶段均已落地。

| 阶段 | 工件 |
|---|---|
| Stage 0 PRD 摄入与缝隙探查 | [`docs/00-gaps.md`](./docs/00-gaps.md) — 35 题已落定 + 2 条 PRD 修正项 |
| Stage 1 用户旅程脚本 | [`docs/01-journeys/`](./docs/01-journeys/) — 3 份真实业务旅程（茶饮出海研究） |
| Stage 2 领域模型初稿 | [`docs/02-domain-model.md`](./docs/02-domain-model.md) — 8 实体 + 12 条不变量 |
| Stage 3 可交互原型 + Mock | [`prototype/`](./prototype/) + [`mock-server/`](./mock-server/) |
| Stage 4 View Model + API 契约 | [`docs/04-view-models.md`](./docs/04-view-models.md) + [`docs/04-api-contract.yaml`](./docs/04-api-contract.yaml) (OpenAPI 3.0.3, 11 端点) |
| Stage 5 模块契约 + 测试骨架 | [`docs/05-modules.md`](./docs/05-modules.md) + [`tests/integration/`](./tests/integration/) (44 测试) |
| Stage 6 模块并行实现 | [`src/modules/`](./src/modules/) — 6 模块, 33 通过 / 11 skip / 0 fail |
| Stage 7 切换 + 交付收尾 | [`electron/`](./electron/) + [`docs/07-deployment.md`](./docs/07-deployment.md) + [`docs/08-known-issues.md`](./docs/08-known-issues.md) |

---

## 快速开始

```bash
pnpm install
```

然后选择一种运行模式：

### 选项 A：浏览器 dev（最快迭代）

```bash
pnpm dev
# 访问 http://localhost:5173
```

启动 mock-server (3001) + Vite (5173)。LLM 默认 mock 模式（fixtures 内置真实茶饮研究对话），无需配 API Key。

### 选项 B：Electron 原生（接近生产）

```bash
pnpm dev:electron
```

启动 Vite + Electron 窗口。模块层完全相同，只是 transport 从 HTTP 换成 IPC。

详见 [`docs/07-deployment.md`](./docs/07-deployment.md)。

### 选项 C：跑测试

```bash
pnpm dev:mock           # Terminal 1: 启动 mock-server
pnpm test               # Terminal 2: 跑全套集成测试
```

预期结果：`33 passed | 11 skipped | 0 failed`。

---

## 试用脚本（journey-1 happy path）

打开 http://localhost:5173 后按下面顺序操作：

1. **双击空白处** → 新建对话节点
2. 输入：
   ```
   我在写一份"中国新茶饮 2026 出海机会"的深度报告。先梳理：
   当前中国新茶饮品牌出海的主要阻力有哪些？请按重要性排序。
   ```
   按 Enter，AI 流式回复（带"💭 思考过程"灰色折叠区）
3. **悬停 AI 回复** → 右下角浮出 "↳ 从这里分支"，点击 → 子节点出现
4. 子节点输入：`聚焦讲讲第 1 点供应链问题。重点讲蜜雪和霸王茶姬的解法。`
5. 回到父节点（点击它），再问：`三市场（欧盟/东南亚/北美）监管差异是什么？`，再次分支
6. **Shift+点击** 多选子节点（边框变紫）
7. 顶部 **"◆ 提炼 (N)"** → popover 输入意图 → 米色提炼节点生成
8. 点击提炼节点 → 在它上面继续对话（注意 ⓘ 提示：上下文只用提炼内容，不展开原节点）

---

## 项目结构

```
power-chat/
├── docs/                       # 设计文档
│   ├── 00-prd.md              ← 原始 PRD
│   ├── 00-gaps.md             ← 35 道决策清单
│   ├── 01-journeys/           ← 用户旅程脚本
│   ├── 02-domain-model.md     ← 实体 + 状态机 + 12 条不变量
│   ├── 04-view-models.md      ← 前端数据视图
│   ├── 04-api-contract.yaml   ← OpenAPI 契约
│   ├── 05-modules.md          ← 模块划分 + 依赖拓扑
│   ├── 07-deployment.md       ← 部署 + 打包指南
│   └── 08-known-issues.md     ← 已知遗留与下一轮迭代
├── src/                        # 真实业务模块（被 mock-server / Electron 共享）
│   ├── types.ts
│   └── modules/
│       ├── persistence.ts     ← 文件 JSON + 串行写队列
│       ├── settings.ts        ← LLM 配置 + apiKey 脱敏
│       ├── canvas.ts          ← 节点 CRUD + 删除级联（INV-5）
│       ├── llm-client.ts      ← OpenAI 兼容 real/mock 双模式
│       ├── conversation.ts    ← 上下文组装（INV-1/2/3/11 锚点）
│       ├── refine.ts          ← 提炼任务 + 多源拼装（INV-4）
│       └── fixtures.ts        ← 茶饮研究真实对话 fixture
├── prototype/                  # React + Vite 渲染器
│   └── src/
│       ├── App.tsx            ← 画布主壳
│       ├── canvas/            ← Node / Edge / RefinePopover
│       ├── store/             ← zustand + localStorage
│       ├── api/client.ts      ← 双适配（IPC + fetch）
│       └── types.ts
├── electron/                   # Electron 壳（Stage 7）
│   ├── bootstrap.cjs          ← tsx CJS hook
│   ├── preload.cjs            ← IPC 桥
│   └── src/
│       ├── main.ts            ← BrowserWindow + IPC 注册
│       └── ipc.ts             ← HTTP 路由对应的 IPC handler
├── mock-server/                # Express + SSE（dev fallback）
│   └── src/server.ts          ← 委托到 src/modules
├── tests/                      # 集成测试
│   └── integration/           ← 44 个测试（按模块分组）
└── README.md
```

---

## 关键架构决策

### AI 不感知画布（PRD §1.5 原则 A、B）
LLM 收到的永远是普通 OpenAI 协议 messages 数组。所有"画布概念"（节点、分支、提炼）只在产品层。这给了三个工程红利：
1. LLM 可换（OpenAI / DeepSeek / 本地 Ollama）
2. 上下文逻辑（继承、减熵）在产品层可单元测试
3. AI 不会建议"分支"或"提炼"——保护用户思考主权

### 单一信息源：OpenAPI 契约
`docs/04-api-contract.yaml` 是唯一真理。mock-server (Stage 3-6) 和 Electron IPC handlers (Stage 7) 都按它实现。前端切换两种 transport 仅靠 `window.powerChat` 检测，无需改业务代码。

### INV 守卫的三个锚点
工程上守不住的不变量等于没写。最关键的三条都有明确代码锚点：

| INV | 锚点 |
|---|---|
| INV-2 (提炼减熵) | `src/modules/conversation.ts::assembleContext` 中 `if (node.type === 'refined') return own.map(toLLMMessage)` —— 不递归 inbound |
| INV-3 (分支快照) | `src/modules/conversation.ts::branchNode` 写入 `inheritedUntilSequence` immutable，加 `assembleContextWithLimit` 截断 |
| INV-11 (reasoning 隔离) | `src/modules/conversation.ts::toLLMMessage` 只返回 `{ role, content }`，刻意不带 reasoningContent |

---

## 测试

```bash
pnpm dev:mock     # 一个终端
pnpm test         # 另一个终端
```

| 模块 | 测试 | 状态 |
|---|---|---|
| canvas | 11 | 8 pass / 3 skip |
| conversation/messages | 6 | 3 pass / 3 skip |
| conversation/branch | 6 | 4 pass / 2 skip |
| refine | 8 | 7 pass / 1 skip |
| settings | 6 | 5 pass / 1 skip |
| contract | 7 | 6 pass / 1 skip |

**11 个 skip 都有明确原因**——主要是 INV 协议层守卫需要依赖注入框架才能验证 LLM outbound 请求内容（见 [`docs/08-known-issues.md`](./docs/08-known-issues.md) #4）。

---

## 已知遗留

- 生产打包链未跑通（[`docs/08-known-issues.md`](./docs/08-known-issues.md) #1）
- API Key 明文存储，待 keytar（#2）
- Settings UI 未实现，目前需 DevTools 控制台手配（#3）
- Undo/Redo 未接入（#7）
- 缩放 < 50% 超折叠态色块视图未实现（#9）

完整清单见 [`docs/08-known-issues.md`](./docs/08-known-issues.md)。

---

## 与 PRD 的偏离

参见 [`docs/00-gaps.md`](./docs/00-gaps.md) 的 "PRD 修正项"：

- **PRD-FIX-1**：取消"30 秒自动折叠"（折叠完全用户主动）
- **PRD-FIX-2**：取消"4 层分支深度限制"（可无限分支）

---

## 下一步（MVP → Alpha）

1. 完成生产打包（`docs/07-deployment.md` §3）
2. 给 5 个真实分析师试用（PRD §10 冷启动方法）
3. 验证 PRD §2.1 的三个核心假设：分支率 / 提炼率 / 回流引用率
4. 基于真实数据决定 PRD §11 的 Q1-Q6 开放问题
