// preload 脚本（CJS 形式以避免 ESM 兼容性陷阱）
// 暴露最小化 API 给 renderer，contextIsolation=true 模式安全。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('powerChat', {
  isElectron: true,

  request(method, path, body) {
    return ipcRenderer.invoke('rpc', method, path, body);
  },

  startStream(path, body) {
    return ipcRenderer.invoke('stream-start', path, body);
  },

  onStreamEvent(streamId, callback) {
    const channel = `stream-${streamId}`;
    const listener = (_e, event) => callback(event);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // 订阅 macOS 双指捏合手势事件（主进程 before-input-event → IPC 转发）
  onPinchGesture(callback) {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on('pinch-gesture', listener);
    return () => ipcRenderer.removeListener('pinch-gesture', listener);
  },
});
