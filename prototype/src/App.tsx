import { useViewStore } from './store/viewStore';
import { HomePage } from './pages/HomePage';
import { CanvasPage } from './pages/CanvasPage';

// 顶层路由壳：根据 viewStore 切换 HomePage / CanvasPage。
// 启动默认 view='home'（用户决策：每次启动从首页开始）；用户在首页选中项目后
// 调 useViewStore.openProject(id) 切到 'canvas'，CanvasPage 收到 projectId 并完整重新加载。
export default function App() {
  const view = useViewStore((s) => s.view);
  const currentProjectId = useViewStore((s) => s.currentProjectId);

  if (view === 'canvas' && currentProjectId) {
    // key={projectId} 让切换项目时整棵 CanvasPage 子树被卸载重建——
    // 比内部 useEffect 依赖更稳，杜绝 effect 执行顺序竞态导致的旧项目状态泄漏
    return <CanvasPage key={currentProjectId} projectId={currentProjectId} />;
  }
  return <HomePage />;
}
