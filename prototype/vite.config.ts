import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// 关键约束（来自 Stage 0/2）：
// - 所有"看似从服务端来"的数据必须经过 mock server，不写死
// - mock-server 跑在 3001，prototype dev 跑在 5173
// - 生产构建时（Stage 6）会换为 Electron IPC，但契约 (URL 形态) 保持一致
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
