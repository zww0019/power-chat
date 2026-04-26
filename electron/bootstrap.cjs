// Electron 入口 bootstrap：通过 tsx CJS register hook 加载 TS 主进程。
// 这避免了为 Electron 单独配置打包/编译流程。
// 生产打包时（Stage 7+）应改用 esbuild bundle 一次性产出 main.cjs，
// 详见 docs/07-deployment.md。

require('tsx/cjs');
require('./src/main.ts');
