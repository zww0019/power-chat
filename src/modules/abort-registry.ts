// abort-registry-module
// 跨 HTTP/IPC 边界传递"用户中断"信号的内存级注册表。
//
// 数据流：
// 1. sendMessage 启动时创建 AbortController，调 registerAbortController(nodeId, ctrl) 入册
// 2. agent.runAgentLoop / streamChat 接收 controller.signal，沿调用链传到 fetch
// 3. 用户点击中断 → POST /api/nodes/:id/messages/abort → 路由层调 abortStream(nodeId)
// 4. registry 找到对应 controller 调 .abort()，agent loop 在下次循环检查 signal.aborted 时
//    yield agent_final(reason='aborted_by_user') 优雅退出
// 5. sendMessage 的 finally 调 unregisterAbortController 清理
//
// 全局并发 1（决策 26 / R018）：mock-server 在 sendMessage 端点用 isAnyStreaming() 守卫，
// 已有节点流式中时拒绝新请求（409 streaming_busy），除非客户端显式 force=true 先中断旧的。

const registry = new Map<string, AbortController>();

/**
 * 在 sendMessage 启动时注册节点的 AbortController。
 * 必须在 canvas.markStreaming 之后、任何 await 之前调用，
 * 保证 isAnyStreaming() 守卫与 streamingByNode 状态同步——两者之间隔了 1 个 microtask，
 * 先注册再 await 可把时序差压到最小（详见 M5 concurrency.test 的 known-skip 注释）。
 */
export function registerAbortController(nodeId: string, ctrl: AbortController): void {
  registry.set(nodeId, ctrl);
}

/**
 * 在 sendMessage finally 块中清理——finally 保证 generator 异常退出时也会执行，
 * 因此即使 streamChat 内部抛出未捕获异常，registry 也不会残留 stale controller。
 */
export function unregisterAbortController(nodeId: string): void {
  registry.delete(nodeId);
}

/**
 * 由 HTTP 中断端点调用：找到节点对应的 controller 调 abort()。
 * @returns 是否真的存在并被中断（404 vs 204 由调用方判断）
 */
export function abortStream(nodeId: string, reason: string = 'user_aborted'): boolean {
  const ctrl = registry.get(nodeId);
  if (!ctrl) return false;
  ctrl.abort(reason);
  registry.delete(nodeId);
  return true;
}

/** 全局并发守卫：当前是否有任何节点流式中 */
export function isAnyStreaming(): boolean {
  return registry.size > 0;
}

/** 取所有正在流式的节点 id（force 模式下批量中断用） */
export function getStreamingNodeIds(): string[] {
  return Array.from(registry.keys());
}

/** 仅测试用：清空 registry。生产代码不应调用。 */
export function __resetRegistryForTest(): void {
  for (const ctrl of registry.values()) {
    try {
      ctrl.abort('test_reset');
    } catch {
      // ignore
    }
  }
  registry.clear();
}
