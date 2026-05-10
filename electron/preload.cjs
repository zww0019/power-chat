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

  // 让渲染进程在系统默认浏览器打开外链——cognition 控制台等场景使用。
  // 主进程会校验只允许 http(s) URL（见 ipc.ts shell-open-external handler）
  openExternal(url) {
    return ipcRenderer.invoke('shell-open-external', url);
  },
});
