import { create } from 'zustand';

// 轻量 toast：用户主动操作（如标题重新生成）失败时给一段可见的反馈，
// 与 alert 不同——不阻塞，自动消失，可叠多条；与现有 alert 路径并存（alert
// 主要用于"必须确认"的错误，如分支引用阻断；toast 用于"非阻塞失败"如 LLM 调用失败）。
export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  kind: ToastKind;
  text: string;
  // 自动消失定时器 id（dismiss 时主动清掉，避免组件卸载后还触发 set）
  timeoutId: number;
}

interface ToastStore {
  toasts: Toast[];
  show: (kind: ToastKind, text: string, durationMs?: number) => string;
  dismiss: (id: string) => void;
}

const DEFAULT_DURATION = 4000;
let toastCounter = 0;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  show: (kind, text, durationMs = DEFAULT_DURATION) => {
    const id = `toast_${Date.now().toString(36)}_${(toastCounter += 1)}`;
    const timeoutId = window.setTimeout(() => get().dismiss(id), durationMs);
    set((s) => ({ toasts: [...s.toasts, { id, kind, text, timeoutId }] }));
    return id;
  },
  dismiss: (id) => {
    set((s) => {
      const found = s.toasts.find((t) => t.id === id);
      if (found) window.clearTimeout(found.timeoutId);
      return { toasts: s.toasts.filter((t) => t.id !== id) };
    });
  },
}));

// 便捷调用——避免每个调用方都 useToastStore.getState().show(...)
export const toast = {
  success: (text: string) => useToastStore.getState().show('success', text),
  error: (text: string) => useToastStore.getState().show('error', text),
  info: (text: string) => useToastStore.getState().show('info', text),
};
