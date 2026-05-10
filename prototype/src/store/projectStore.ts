import { create } from 'zustand';
import type { Project } from '../types';
import { api } from '../api/client';

// 项目列表状态。HomePage 挂载时调 loadProjects() 拉数据；CRUD 操作均同步落后端再更新本地。
// 不持久化——backend db.json 才是真源，本 store 仅是渲染用的内存快照。

interface ProjectState {
  projects: Project[];
  loading: boolean;
  error: string | null;
}

interface ProjectActions {
  loadProjects: () => Promise<void>;
  createProject: (name: string) => Promise<Project>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  // 标记项目"被打开"（更新 lastOpenedAt）。HomePage 跳转 CanvasPage 前调用，
  // 让首页排序按访问近期反映真实使用顺序
  touchProject: (id: string) => Promise<void>;
}

type Store = ProjectState & ProjectActions;

// 排序：lastOpenedAt 倒序优先；从未打开过的项目按 createdAt 倒序排在后面（与后端 listProjects 一致）。
// 前端排序在乐观更新场景下也兜底一遍，避免短暂顺序错位被用户察觉
function sortProjects(arr: Project[]): Project[] {
  return [...arr].sort((a, b) => {
    const aTime = a.lastOpenedAt ?? '';
    const bTime = b.lastOpenedAt ?? '';
    if (aTime !== bTime) return bTime.localeCompare(aTime);
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export const useProjectStore = create<Store>()((set, get) => ({
  projects: [],
  loading: false,
  error: null,

  loadProjects: async () => {
    set({ loading: true, error: null });
    try {
      const list = await api.listProjects();
      set({ projects: sortProjects(list), loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? String(e) });
    }
  },

  createProject: async (name) => {
    const created = await api.createProject(name);
    set((s) => ({ projects: sortProjects([...s.projects, created]) }));
    return created;
  },

  renameProject: async (id, name) => {
    const updated = await api.updateProject(id, { name });
    set((s) => ({
      projects: sortProjects(s.projects.map((p) => (p.id === id ? updated : p))),
    }));
  },

  deleteProject: async (id) => {
    await api.deleteProject(id);
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
  },

  touchProject: async (id) => {
    await api.touchProject(id);
    // 乐观更新 lastOpenedAt 让首页立刻反映新顺序，无需等下一次 loadProjects
    const now = new Date().toISOString();
    set((s) => ({
      projects: sortProjects(
        s.projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: now } : p)),
      ),
    }));
  },
}));

// 便利选择器：语义明确的具名函数，供需要透传 selector 引用的场景使用（如 memo deps / HOC 比对）
export const selectProjects = (s: Store): Project[] => s.projects;
