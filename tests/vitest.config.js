import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        // unit 测试 mock fetch / settings 模块，独立于 mock-server；与 integration 共存
        include: ['integration/**/*.test.ts', 'unit/**/*.test.ts'],
        // 测试假设有 mock-server 在 3001 端口运行
        // CI 中可在 globalSetup 里启动；本地开发：先 pnpm dev:mock 再 pnpm test
        testTimeout: 15_000,
        // 测试文件共享 mock-server 状态；必须串行避免相互冲洗
        fileParallelism: false,
    },
});
