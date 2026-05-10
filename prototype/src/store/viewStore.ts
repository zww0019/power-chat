import { create } from 'zustand';

// 顶层视图状态：决定渲染 HomePage 还是 CanvasPage。
// 不持久化——每次启动应用一律从首页开始（用户决策）。
// currentProjectId 仅在 view='canvas' 时有意义；HomePage 切回时由 goHome 清空，
// 避免残留旧 projectId 引发后续 IPC 调用串扰。

export type ViewMode = 'home' | 'canvas';

interface ViewState {
  view: ViewMode;
  currentProjectId: string | null;
}

interface ViewActions {
  openProject: (projectId: string) => void;
  goHome: () => void;
}

type Store = ViewState & ViewActions;

export const useViewStore = create<Store>()((set) => ({
  view: 'home',
  currentProjectId: null,

  openProject: (projectId) => set({ view: 'canvas', currentProjectId: projectId }),
  goHome: () => set({ view: 'home', currentProjectId: null }),
}));
