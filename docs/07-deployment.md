# 部署与打包指南

> Stage 7 收尾文档。MVP 期支持两种运行方式：浏览器 dev 模式（mock-server 后端）+ Electron 原生模式（IPC 后端 + 真实 LLM）。

---

## 运行方式选择

| 场景 | 命令 | 后端 |
|---|---|---|
| 浏览器 dev（最快迭代）| `pnpm dev` | mock-server (Express + 内存/文件 JSON) |
| Electron dev（接近生产）| `pnpm dev:electron` | Electron 主进程 (IPC + 文件 JSON) |
| 测试 | `pnpm test`（需先 `pnpm dev:mock`） | mock-server |
| 生产构建 | 见 §3 packaging | Electron + 真实 LLM |

两种模式共享 `src/modules/` 业务代码，所以业务行为一致；区别仅在 transport 层。

---

## 1. 浏览器 dev 模式（默认开发环境）

```bash
pnpm dev
# 访问 http://localhost:5173
```

启动两个进程：
- mock-server 在 3001（提供 HTTP API）
- vite 在 5173（提供前端 + 代理 /api 到 3001）

**LLM 行为**：默认 mock 模式（`USE_MOCK_LLM=1` 缺省值）。响应来自 `src/modules/fixtures.ts` 的关键词预设回复。

**何时用真实 LLM**：在 mock-server 启动前 export 环境变量：
```bash
USE_MOCK_LLM=0 pnpm dev:mock
# 然后通过 PUT /api/settings 配置 baseURL/model/key
```

---

## 2. Electron dev 模式

```bash
pnpm dev:electron
# 自动打开 Electron 窗口
```

启动两个进程：
- vite 在 5173
- electron 加载 vite URL 作为 renderer，主进程通过 tsx 加载 TypeScript

**首次启动**：UI 没有 Settings 面板（暂未实现）。可手动通过 Electron 主进程的本地 JSON 文件预设：
```bash
echo '{"settings":{"llmBaseUrl":"https://api.deepseek.com/v1","llmModel":"deepseek-reasoner","llmApiKey":"sk-yourkey","thinkingModeEnabled":true,"privacyAcknowledged":true}}' > .data/db.json
```
然后启动 `pnpm dev:electron`。

或在 renderer DevTools 控制台调：
```js
await window.powerChat.request('PUT', '/api/settings', {
  llmBaseUrl: 'https://api.deepseek.com/v1',
  llmModel: 'deepseek-reasoner',
  llmApiKey: 'sk-yourkey',
  thinkingModeEnabled: true,
  privacyAcknowledged: true,
});
```

**数据存储位置**：默认 `<project>/.data/db.json`，可通过 `POWER_CHAT_DB=/path/to/db.json` 环境变量覆盖。

---

## 3. 生产打包（macOS + Windows）

> ⚠️ MVP 阶段未完成全自动打包流程，本节是路线图，需要按步骤补全。

### 3.1 准备：构建 renderer 静态产物

```bash
pnpm -C prototype build
# 产物：prototype/dist/
```

### 3.2 准备：bundle Electron 主进程

当前 dev 模式用 `tsx` 直接运行 TypeScript，生产应预编译为单一 CJS：

```bash
# 推荐用 esbuild 一次性 bundle 所有依赖（含 src/modules）
pnpm exec esbuild electron/src/main.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node22 \
  --external:electron \
  --outfile=electron/dist/main.cjs

# preload 已经是 CJS，无需 bundle
cp electron/preload.cjs electron/dist/preload.cjs
```

### 3.3 用 electron-builder 打包

需要新增 `electron-builder` 配置。在 `electron/package.json` 加：

```jsonc
{
  "build": {
    "appId": "com.powerchat.app",
    "productName": "思考画布",
    "directories": { "output": "release" },
    "files": [
      "dist/**/*",
      "preload.cjs",
      "../prototype/dist/**/*"
    ],
    "extraResources": [
      { "from": "../src", "to": "src" }
    ],
    "mac": {
      "category": "public.app-category.productivity",
      "target": ["dmg", "zip"]
    },
    "win": {
      "target": ["nsis", "portable"]
    }
  }
}
```

```bash
pnpm add -D -w electron-builder
pnpm exec electron-builder --mac --win
# 产物：electron/release/
```

**已知未解决的打包问题：**

1. **`tsx` 运行时依赖**：bootstrap.cjs 引用 `tsx/cjs`，生产打包前需移除并切换到预编译。
2. **`fixtures.ts` 资源路径**：mock fixtures 在 `src/modules/fixtures.ts`，bundle 后路径变化。esbuild 默认会 inline，应该没问题。
3. **OS keychain**：当前 `apiKey` 存明文（`db.json`），生产应迁移到 `keytar`（macOS Keychain / Windows Credential Manager），见 docs/08-known-issues.md §3。

### 3.4 代码签名

- macOS：需 Apple Developer ID 证书 + notarization（公证），否则用户首次启动会被 Gatekeeper 拦截
- Windows：需 EV Code Signing 证书，否则 SmartScreen 警告

---

## 4. 环境变量清单

| 变量 | 默认值 | 用途 |
|---|---|---|
| `POWER_CHAT_DB` | `<repo>/.data/db.json` | 数据存储路径 |
| `USE_MOCK_LLM` | `0`（mock-server 内默认 `1`）| `1` = 用 fixtures，`0` = 调真实 LLM 端点 |
| `VITE_DEV_SERVER_URL` | `http://localhost:5173` | Electron 主进程 dev 模式加载的前端 URL |
| `PORT` | `3001` | mock-server 端口 |

---

## 5. 自动更新（未实现）

PRD §9 提到内置软件更新，但 MVP 未实现。建议二阶段集成：

- macOS：`electron-updater` + GitHub Releases / 自有 update server
- Windows：`electron-updater` + NSIS

需注意：自动更新不能改变本地 `.data/db.json` 数据格式，否则要写迁移脚本。

---

## 6. CI / 发布流水线（建议骨架）

GitHub Actions 矩阵：

```yaml
matrix:
  os: [macos-latest, windows-latest]

steps:
  - run: pnpm install
  - run: pnpm type-check
  - run: pnpm dev:mock & sleep 3 && pnpm test
  - run: pnpm -C prototype build
  - run: pnpm -C electron build  # 见 §3.2 esbuild 步骤
  - run: pnpm exec electron-builder --${{ matrix.os == 'macos-latest' && 'mac' || 'win' }}
  - uses: actions/upload-artifact@v4
    with: { path: electron/release/ }
```

---

## 7. 数据备份与恢复

MVP 期数据在单一 JSON 文件，迁移简单：

```bash
# 备份
cp ~/Library/Application\ Support/思考画布/db.json ~/backup/

# 恢复
cp ~/backup/db.json ~/Library/Application\ Support/思考画布/db.json
```

二阶段切到 SQLite 时需相应更新此流程。
