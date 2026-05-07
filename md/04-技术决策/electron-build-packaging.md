# Electron 打包配置约束

> L2 约束 · 2026-05-05 修复 mac 打包白屏 fallout

## 1. Vite base 必须为相对路径

**约束**：`prototype/vite.config.ts` 的 `base` 必须为 `'./'`（相对路径），不可省略 / 不可用 `'/'`。

**Why**：Electron 生产构建走 `file://` 协议加载 `dist/index.html`。Vite 默认 `base: '/'` 会让 HTML 引用 `/assets/index-xxx.js`，在 `file://` 下解析为文件系统根目录 → 资源 404 → 整页白屏。`base: './'` 让产出 `./assets/...`，相对于 HTML 自身解析，正确。

## 2. prototype 产物走 extraResources，不走 files

**约束**：`electron/package.json` 的 `build.files` 字段**不得**写父级路径（如 `../prototype/dist/**/*`）。跨目录资源一律通过 `extraResources` 拷贝到 `Resources/<name>/`。

**Why**：electron-builder 25.x 的 `files` filter 静默丢弃父级路径条目，构建不会报错但 asar 内不会包含这些文件，运行时 `loadFile` 找不到 HTML → 白屏。`extraResources` 的 `from: '../xxx'` 能正常工作，已在 `../src` 上验证。

**对应实现**：
```json
"files": ["dist/**/*", "preload.cjs"],
"extraResources": [
  { "from": "../src", "to": "src" },
  { "from": "../prototype/dist", "to": "renderer" }
]
```

主进程加载用 `process.resourcesPath`：
```ts
mainWindow.loadFile(join(process.resourcesPath, 'renderer/index.html'));
```

## 3. 持久化 DB 路径不可落在 asar 内

**约束**：生产模式下 `POWER_CHAT_DB` 必须指向可写目录（推荐 `app.getPath('userData')`），不可使用 `__dirname` 推导出的相对路径。

**Why**：打包后 `__dirname` 落在只读的 `app.asar` 内，`src/modules/persistence.js` 默认路径 `__dirname/../../.data/db.json` 写入会 EROFS 失败。所有读写 API 都会 500，UI 能起但功能全废。

**对应实现** — `electron/src/main.ts`：
```ts
if (!process.env.POWER_CHAT_DB) {
  process.env.POWER_CHAT_DB = join(app.getPath('userData'), 'db.json');
}
```

须在 `registerIpcHandlers` 之前完成（在 `getPersistence()` 第一次被调用前生效即可，因为 adapter 缓存到首次调用时才创建）。

## 4. 应用图标资源

**约束**：图标源文件 `electron/build/icon.svg`，构建输入 `electron/build/icon.png`（1024×1024），由 SVG 通过 `rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png` 生成。

**Why**：
- electron-builder 默认 `directories.buildResources = "build"`，会自动识别 `build/icon.png`（≥512×512）并生成多分辨率 `.icns`，**无需手动 iconutil、无需在 package.json `mac.icon` 显式配置**。
- SVG 作为可维护源（文本可 diff），PNG 作为构建产物——后者可由前者重新生成，但 PNG 入仓避免每次构建都依赖 rsvg-convert（CI 环境可能没有）。
- `rsvg-convert` 来自 `librsvg`，渲染质量优于 ImageMagick / qlmanage，是 SVG → PNG 的首选。

**视觉规范**（思考画布 v0.1）：
- 1024×1024 squircle 衬底，圆角 224px，填充 `#fafaf7`，描边 `#e8e4d8` 2px
- 中央节点（墨色 `#2d2a26` 渐变）+ 5 条曲线分支 + 末端节点
- 一个琥珀色高亮节点 `#c89958`（"被点亮的思考"）作为视觉锚点

修改图标流程：改 `icon.svg` → 跑 `rsvg-convert ...` 重新生成 PNG → `pnpm -C electron dist:mac` 验证。

## 5. 多平台构建（CI/CD）

> L3 实现参考 · 2026-05-07 GitHub Actions release workflow

**触发**：`push` 到 `main` 分支自动构建三平台产物，发布为 GitHub prerelease；同时支持 `workflow_dispatch` 手动触发。

**平台/架构矩阵**：
- macOS: `universal`（arm64 + x64 合一）→ dmg + zip
- Windows: x64 → nsis 安装包 + zip
- Linux: x64 → AppImage + deb

每个平台用对应 runner（macos-latest / windows-latest / ubuntu-latest）原生构建，**不做交叉编译**——electron-builder 的跨平台构建对 native 工具链依赖多，原生 runner 最稳。

**Job 串联**：`test (ubuntu)` → `build (matrix)` → `release (ubuntu)`。test 失败则不浪费 build 资源；matrix 设 `fail-fast: false`，单平台失败不影响其他平台继续。

**Tag 命名**：`v{package.version}-build.{github.run_number}`，避免与未来正式 release tag 冲突，且 `run_number` 单调递增不会撞。

**不签名**：CI 环境无证书，靠 `CSC_IDENTITY_AUTO_DISCOVERY: "false"` 阻止 electron-builder 在 macOS runner 上自动搜索 keychain（不设此变量构建会失败，因找不到任何身份）。Windows nsis 同理无签名。用户首次启动会看到系统警告但能用。

**关键依赖声明**：`electron-builder` 必须在 `electron/package.json` 的 devDependencies 显式声明（已加），不可只放在根 `package.json`。否则 `pnpm -C electron dist:*` 在 hoist 行为变更时会失败。

**对应文件**：
- `.github/workflows/release.yml`
- `electron/package.json` 的 `build.{mac,win,linux}` 配置
- 根 `package.json` 的 `build:mac` / `build:win` / `build:linux` 脚本
