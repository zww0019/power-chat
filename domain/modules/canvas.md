# 画布模块（canvas）

## 职责
管理画布元数据、节点、边的生命周期。对 LLM 完全无知（仅持久化数据，不调模型）。

## 核心实体
- 画布（Canvas）：MVP 单画布单实例，持久化视野（viewport x/y/zoom）
- 节点（Node）：见 glossary，类型 dialogue / refined，三种状态 expanded/collapsed/fullscreen（fullscreen 由前端全局 store 字段 `fullscreenNodeId` 维护，不持久化、不进 schema；详见 D022）
- 边（Edge）：见 glossary，类型 branch / refine_input

## 创建语义
- 节点由用户主动创建（双击空白）或被动创建（分支动作 / 提炼任务产生 child）
- 边只能由 conversation/refine 模块在内部创建，不开放外部端点

## 修改语义
- 节点位置 / 折叠态 / 标题可改（PATCH）
- 标题最长 30 字
- 边创建后不可改（inheritedUntilSequence 是分支快照点，永久不变）

## 删除语义
- 节点删除 → 级联删 messages + 触及该节点的所有边；子孙节点保留并断链
- 边删除 → 无副作用（不影响节点或消息）
- 流式中节点不可删（INV-7）

## 与持久化层的关系
- 通过 persistence-module 单例访问；写操作走串行队列保证顺序
- 删除节点用 transaction 包裹（messages + edges 必须同步删除）

## 与流式标记的关系
- 流式状态用内存 Set 维护（streamingNodes），非持久化
- conversation / refine 模块在开始/结束流式时调 markStreaming / unmarkStreaming
- deleteNode 用 isStreaming 守卫
