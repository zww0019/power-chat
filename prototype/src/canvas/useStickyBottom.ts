import { useCallback, useEffect, useRef } from 'react';

// 流式响应期间「粘底滚动」：内容增长时自动把容器滚到底部，
// 但用户向上滚开则停止跟随；用户再次滚到底部（容差 threshold 内）恢复跟随。
//
// signal: 任意"内容增量信号"——通常是「消息数 + 末条消息可变长度」拼接的字符串，
//         每次 SSE 帧到达都会变化，触发本 hook 内部的 effect。
// resetKey: 视图上下文标识。变化时 stickyRef 强制重置为 true，用于"切换视图时恢复跟随"
//           的语义（inline ↔ fullscreen 是独立 fiber，仅靠组件挂载/卸载无法覆盖另一侧）。
// threshold: 判定"接近底部"的像素阈值（默认 24px），覆盖亚像素误差与 1～2 行字。
//
// 行为：
//   - stickyRef 初值 true（新挂载默认跟随）
//   - resetKey 变化时把 stickyRef 翻回 true 并立即调度一次置底
//   - onScroll 中根据 distance < threshold 更新 stickyRef
//   - signal 变化时若 stickyRef 为 true，rAF 调度一次 scrollTop = scrollHeight
//     （rAF 节流：同帧多次 signal 变化只滚一次）
export function useStickyBottom<T extends HTMLElement>(
  signal: unknown,
  options?: { threshold?: number; resetKey?: unknown },
) {
  const containerRef = useRef<T | null>(null);
  // ref 而非 state：stickyRef 变化不需要触发重渲染，用 state 会在每次滚动事件后引发组件抖动。
  const stickyRef = useRef(true);
  const rafHandleRef = useRef<number | null>(null);
  const threshold = options?.threshold ?? 24;
  const resetKey = options?.resetKey;

  const scheduleScrollToBottom = useCallback(() => {
    if (rafHandleRef.current != null) return;
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyRef.current = distance < threshold;
  }, [threshold]);

  useEffect(() => {
    if (stickyRef.current) {
      scheduleScrollToBottom();
    }
  }, [signal, scheduleScrollToBottom]);

  // 切换视图（如 inline ↔ fullscreen）时强制恢复跟随：另一侧组件可能未卸载，
  // 仅靠"新挂载默认 true"无法重置已翻为 false 的 stickyRef。
  useEffect(() => {
    stickyRef.current = true;
    scheduleScrollToBottom();
  }, [resetKey, scheduleScrollToBottom]);

  // 卸载时取消待执行的 rAF，防止组件已销毁后回调仍尝试写 DOM。
  useEffect(() => {
    return () => {
      if (rafHandleRef.current != null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
    };
  }, []);

  return { containerRef, onScroll };
}
