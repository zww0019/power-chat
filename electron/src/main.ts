import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { registerIpcHandlers } from './ipc.js';

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const VITE_DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: '思考画布',
    backgroundColor: '#fafaf7',
    webPreferences: {
      preload: join(__dirname, '../preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 禁用 Chromium 默认的 pinch-to-page-zoom，让 macOS 双指捏合手势
  // 以带 ctrlKey 的 wheel 事件形式派发给渲染进程，由 App.tsx 已有的画布缩放逻辑接管。
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // 生产构建：prototype/dist 经 extraResources 挂到 Resources/renderer/。
    // electron-builder 的 files 字段不支持父级路径 (../prototype/dist 会被静默丢弃)，
    // 因此走 extraResources，运行时通过 process.resourcesPath 定位。
    mainWindow.loadFile(join(process.resourcesPath, 'renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 打包后 __dirname 落在只读的 app.asar 内，persistence 默认路径
// (__dirname/../../.data/db.json) 写入会失败。改写到 userData 目录。
if (!process.env.POWER_CHAT_DB) {
  process.env.POWER_CHAT_DB = join(app.getPath('userData'), 'db.json');
}

app.whenReady().then(() => {
  registerIpcHandlers(ipcMain, () => mainWindow?.webContents ?? null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
