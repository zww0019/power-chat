// 按 projectId 分键管理画布视口的 localStorage 持久化。
// 替代旧版 zustand persist 中间件——多项目场景下 zustand persist 的 name 是固定字符串，
// 无法按当前项目动态切换 storage key。改为手动管理后，每个项目有独立的视口快照，
// 切换项目时不会互相覆盖。
//
// 仅持久化视口（viewportX/Y/zoom）+ userHasMovedViewport 标志位。
// nodes/edges/messages 完全由后端 db.json 真源提供，不再前端冗余存储。

const KEY_PREFIX = 'power-chat-viewport:';

export interface ViewportSnapshot {
  viewportX: number;
  viewportY: number;
  viewportZoom: number;
  // 用户是否在本端手动操作过视口。启动时若 false，CanvasPage 会执行 fit-to-nodes 自动居中。
  // 与 canvasStore.userHasMovedViewport 同义，按项目分别保存
  userHasMovedViewport: boolean;
}

export function loadViewport(projectId: string): ViewportSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + projectId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.viewportX !== 'number'
      || typeof parsed?.viewportY !== 'number'
      || typeof parsed?.viewportZoom !== 'number'
    ) return null;
    return {
      viewportX: parsed.viewportX,
      viewportY: parsed.viewportY,
      viewportZoom: parsed.viewportZoom,
      userHasMovedViewport: !!parsed.userHasMovedViewport,
    };
  } catch {
    return null;
  }
}

export function saveViewport(projectId: string, snapshot: ViewportSnapshot): void {
  try {
    localStorage.setItem(KEY_PREFIX + projectId, JSON.stringify(snapshot));
  } catch {
    // 配额溢出等问题忽略——视口丢失不影响数据正确性
  }
}

export function clearViewport(projectId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + projectId);
  } catch {
    /* ignore */
  }
}
