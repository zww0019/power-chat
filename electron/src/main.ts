import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerIpcHandlers } from './ipc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

  // 拦截 macOS 双指捏合手势 (gesturePinch)，阻止 Electron 默认页面缩放，
  // 并通过 IPC 将手势数据（scale + 光标坐标）转发给渲染进程，由画布缩放逻辑接管。
  mainWindow.webContents.on('before-input-event' as any, (event: any, input: any) => {
    if (
      input.type === 'gesturePinchBegin' ||
      input.type === 'gesturePinchUpdate' ||
      input.type === 'gesturePinchEnd'
    ) {
      event.preventDefault();
      const wc = mainWindow?.webContents;
      if (!wc || wc.isDestroyed()) return;
      wc.send('pinch-gesture', {
        type:
          input.type === 'gesturePinchBegin' ? 'pinchBegin' :
          input.type === 'gesturePinchUpdate' ? 'pinchUpdate' :
          'pinchEnd',
        scale: (input as any).scale ?? 1,
        x: (input as any).x ?? 0,
        y: (input as any).y ?? 0,
      });
    }
  });

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // 生产构建：加载 prototype/dist 下的 index.html
    mainWindow.loadFile(join(__dirname, '../../prototype/dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
