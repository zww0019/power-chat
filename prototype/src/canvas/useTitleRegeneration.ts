import { useState, useCallback, useRef } from 'react';
import { performRegenerateTitle } from './nodeActions';

// 标题重新生成的共用 hook：节点 header / 折叠卡 / 大屏 Modal 三处入口共享同一份
// loading 守卫与 stopPropagation 处理；失败 toast 由 performRegenerateTitle 内部触发。
//
// loading 状态通过 ref 保存快照供 trigger 内部守卫读取，避免将 loading 纳入
// useCallback 依赖——若纳入依赖，每次 loading 翻转都会重建 trigger 引用，
// 导致消费方（RegenerateTitleButton / FullscreenHeader）触发不必要的重渲。
export function useTitleRegeneration(nodeId: string) {
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  const trigger = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        await performRegenerateTitle(nodeId);
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [nodeId],
  );
  return { loading, trigger };
}
