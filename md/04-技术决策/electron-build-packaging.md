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

## 5. macOS 双指捏合缩放必须保留 setVisualZoomLevelLimits

> L2 约束 · 2026-05-07 修复双指缩放回归

**约束**：`electron/src/main.ts` 的 `createWindow()` 中**必须**保留：
```ts
mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
```

**Why**：Chromium 默认对 macOS 触控板双指捏合做 pinch-to-page-zoom（直接放大整个 web 内容，不路由到 web 层事件）。`setVisualZoomLevelLimits(1, 1)` 把可视化缩放下限/上限都锁为 1（即禁用），Chromium 转而把 pinch 派发为 `wheel + ctrlKey=true` 事件给渲染进程，由 `App.tsx` 的 wheel handler 中 `if (e.ctrlKey || e.metaKey) { 缩放 }` 路径接管。删了这一行画布双指缩放立即失效。

**反面教训**：曾尝试用 `webContents.on('before-input-event', ...)` 拦截 `input.type === 'gesturePinchBegin/Update/End'` 替代本约束，**实际无效**——这些 input.type 字符串不在 Electron 公开 API 范围内（公开类型仅 keyboard/mouse），拦截器从未命中。该方案的 commit 同时把 setVisualZoomLevelLimits 误删，造成回归。任何替代方案在合并前必须经 macOS 真机双指捏合验证。

## 6. 多平台构建（CI/CD）

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

## 7. Electron dev 必须前置 build:electron

> L2 约束 · 2026-05-08 修复撤销删除 404 回归

**约束**：`electron/package.json` 的 `dev` 脚本**必须**前置 `pnpm build:electron`：
```json
"dev": "pnpm build:electron && VITE_DEV_SERVER_URL=http://localhost:5173 electron ."
```

**Why**：Electron 主进程入口 `package.json#main` 指向 `dist/main.cjs`（esbuild 一次性 bundle 产物），而非源码 `src/main.ts`。若 dev 启动只跑 `electron .`，则使用上一次的旧产物——源码侧对 `ipc.ts` / `main.ts` 的任何改动（新增 IPC 路由、调整窗口配置、改持久化 hook）都不会生效。

历史回归：2026-05-07 加 `POST /api/nodes/restore` 路由后，dist/main.cjs 未重编，撤销删除报 `[404] not_found: No route for POST /api/nodes/restore`。错误信息形如 `No route for {METHOD} {PATH}` 即来自 `ipc.ts` 的 `dispatchRpc` 兜底分支，是「源码已写但产物未跟进」的典型征兆。

**反面教训**：把锅推给 watch 模式之前，先确认 dist 是否落后于 src（`stat -f "%m" dist/main.cjs src/ipc.ts` 比对时间戳，或 `grep` 关键字符串验证产物内容）。watch 是工具升级，但前置 build:electron 才是兜底——前者失效时后者仍能保证启动一致性。

**不影响打包流程**：根 `package.json` 的 `build:mac/win/linux` 已显式串行 `pnpm -C prototype build && pnpm -C electron build:electron && pnpm -C electron dist:*`，发布路径独立。本约束仅修 dev 工作流。

## 8. electron/package.json 包元数据：CI 环境字段强约束

> L2 约束 · 2026-05-08 修复 GitHub Actions 三平台构建中断

**约束**：`electron/package.json` **必须**声明 `repository` / `description` / `author` 三个顶层字段，且 `build` 配置内**必须**显式 `"publish": null`。

```json
{
  "description": "...",
  "author": "...",
  "repository": { "type": "git", "url": "https://github.com/<owner>/<repo>.git" },
  "build": {
    "publish": null,
    ...
  }
}
```

**Why**：electron-builder 25.x 在 CI 环境（检测到 `CI=true`）会自动进入 publish 探测流程——优先读子目录 `package.json` 的 `repository` 字段，缺失时回退解析 `.git/config`。在 `actions/checkout@v4` 拉到的仓库中，从 `electron/` 子目录上下文解析 `.git/config` 不可靠，最终报 `⨯ Cannot detect repository by .git/config` 中断三平台构建。

修复必须**双管齐下**：
1. 补 `repository` 字段：让探测在配置层得到答案，不回退 `.git/config`
2. 设 `build.publish: null`：从根本上让 electron-builder 跳过 publish 流程（本项目发布由 `.github/workflows/release.yml` 中的 `softprops/action-gh-release@v2` 接管，electron-builder 内置 publish **完全不应启用**）

`description` / `author` 同步补齐：electron-builder 在打包阶段也会校验包元数据完整性，缺失会输出 warning（虽不阻断但污染日志）。

**反面教训**：单独补 `repository` 字段也能让本次报错消失，但 electron-builder 后续版本可能扩大 publish 探测的检查项（如校验 url 可达性、检查 GH_TOKEN 权限等）。`publish: null` 是断根方案；只补字段是治标。

**与 release.yml 的契约**：本项目发布**严格分两段**——electron-builder 只产 artifact（`pnpm dist:*` → `electron/release/*.{dmg,zip,exe,AppImage,deb}`），artifact 的上传与 Release 创建由 `softprops/action-gh-release` 单独 job 完成。任何在 `electron/package.json` 的 `build.publish` 写非 null 值的改动都会破坏这个契约——electron-builder 会重复发布或与 action-gh-release 冲突。

## 9. Linux deb/AppImage 要求 author 为对象（含 email）

> L2 约束 · 2026-05-09 修复 GitHub Actions Linux deb 构建中断

**约束**：`electron/package.json` 顶层 `author` 字段**必须**为对象格式，包含 `name` 与 `email` 两个键。**不得**写为纯字符串。

```json
"author": {
  "name": "zww",
  "email": "ddfeww86@gmail.com"
}
```

**Why**：electron-builder 25.x 的 `FpmTarget.js`（负责 deb / AppImage 打包）拼装 maintainer 字段时优先级如下：

1. `build.linux.maintainer` 显式值
2. `author` 对象的 `${name} <${email}>`，**两个键都必须存在**
3. 都缺则抛 `Please specify author 'email' in the application package.json` 中断

纯字符串 author（如 `"author": "zww"`）会被解析为对象后 `email` 为 `null`，命中分支 3 中断。mac dmg / win nsis 不走 `FpmTarget.js`，无此约束——这是为什么 c872b7c（第 8 节）只补字符串 author 时 mac/win 通过、Linux 仍中断。

**修复二选一，本项目选 author 对象路径**：
- 选 author 对象：npm 元数据 + 三平台包内 metadata 都受益，统一来源
- 选 `build.linux.maintainer`：email 仅出现在 deb 包，暴露面小，但维护两处来源易漂移

**反面教训**：不要试图通过"修字符串 author 的解析逻辑"绕过——`FpmTarget.js` 的 `email == null` 判断在 electron-builder 内部，无法 patch。唯一干净的修法是让 author 在源头就是对象。

**自检命令**：本机无法跑 Linux 构建时，用 node 验证字段拼装：
```bash
node -e "const p = require('./electron/package.json'); console.log(p.author.name + ' <' + p.author.email + '>');"
# 期望输出: zww <ddfeww86@gmail.com>
```
输出符合 `name <email>` 格式即说明 deb maintainer 字段会被正确生成。

## 10. 严禁同名 .js 与 .ts 共存（蔽源）

**约束**：`src/modules/`、`prototype/src/`、`electron/src/`、`mock-server/src/` 等所有 TypeScript 源目录中，**不得**出现与某 `.ts` 文件同名的 `.js` 文件。一旦发现立即删除并重建产物。

**Why**：esbuild / Vite / vitest 解析 ESM 风格的 `import './x.js'` 时遵循同一规则——

1. 先按字面路径找 `x.js`，若磁盘上存在真实文件 → 直接使用，不再尝试 TS 后缀替换
2. 找不到才回退 `.js → .ts` 替换（TS 项目的标准 ESM 习惯）

仓库里残留的陈旧 `tsc` 编译产物（`x.js`）会**蔽掉**同名的新 `x.ts`，让 bundle 实际打包的是过时代码。具体踩过的坑：

- `src/modules/persistence.js` 是多项目改造前的旧版（DEFAULT_DB 缺 `projects` 字段），蔽掉了多项目 commit 后的新 `persistence.ts`，导致 `Object.values(db.projects)` 在 `undefined` 上抛错 → 首页加载失败 `[500] internal: Cannot convert undefined or null to object`
- `src/modules/settings.js` 缺 cognition 系列默认字段，蔽掉新 `settings.ts` 后 cognition 配置首次启动会拿不到默认值

**自检命令**（每次大重构 / 改 DEFAULT_* 常量后跑一遍）：

```bash
for d in src/modules src/modules/tools prototype/src electron/src mock-server/src; do
  find "$d" -maxdepth 5 -name "*.js" -type f 2>/dev/null | while read f; do
    [ -f "${f%.js}.ts" ] || [ -f "${f%.js}.tsx" ] && echo "SHADOW: $f"
  done
done
# 期望无输出
```

**根因防御**：`tsconfig.json` 设 `"noEmit": true`（避免 tsc 误产出 `.js`）；CI 流水线加上自检命令兜底。手写的 `.js`（如 preload）允许保留，但**不得**与 `.ts` 同名。
