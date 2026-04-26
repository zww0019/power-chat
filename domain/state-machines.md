# 状态机

## 节点折叠态
expanded ─(用户点折叠按钮)→ collapsed ─(用户点 collapsed 卡片任意位置)→ expanded

触发条件：
- expanded → collapsed：用户点击节点 header 右侧的 `−` 按钮
- collapsed → expanded：用户在 collapsed 卡片上单击（位移阈值 < 4px 视为单击，超过视为拖拽）

## 节点流式状态
idle ─(用户发送消息)→ streaming ─(stream done)→ idle
                              ─(stream error)→ error
                              ─(用户主动中断 / §7.1 自动中断 / 全局并发 force)→ idle（M5 起，仍走 done 收尾路径）
                              ─(进程重启/页面刷新)→ idle（自动恢复，无需持久化）

触发条件：
- idle → streaming：在节点内调 sendMessage 或对该节点提炼时
- streaming → idle（done）：SSE 流正常收到 `done` 事件
- streaming → idle（中断收敛，M5）：用户点 AgentTrace 中断按钮 / E012 同节点连发自动 abort / E013 跨节点 force=true → agent loop 收到 signal → yield agent_final(aborted_*) + done → 走相同 done 路径回到 idle
- streaming → error：SSE 流收到 `error` 事件或网络中断（中断不走 error 路径，避免与真实错误混淆）
- 任意 → idle（隐式）：进程重启时所有内存中的 streaming 标记清空 + abort registry 自然清空

## UI 选择状态
none ─(点节点 header)→ active(node)
none ─(Shift+点节点)→ selected(nodes[])
none ─(点边命中区)→ selected(edge)

active(node) ─(Shift+点另一节点)→ selected(nodes[])
active(node) ─(点边)→ selected(edge)
selected(nodes[]) ─(点节点 header)→ active(node)
selected(nodes[]) ─(点边)→ selected(edge)
selected(edge) ─(点节点 header)→ active(node)
selected(edge) ─(Shift+点节点)→ selected(nodes[])

任意 ─(点画布空白)→ none

触发条件：
- 三种选择状态互斥（R004）：进入任一态时必须清空另外两态
- 删除快捷键根据当前态决定删除目标（优先级：edge > active node）

## 配置状态（设置弹窗触发）
unconfigured ─(用户保存有效配置)→ configured
configured ─(用户清空任一字段)→ unconfigured

触发条件：
- 应用启动 hydrate 完成后立即检查；unconfigured 时强制弹出设置弹窗（首次引导）
- configured 后用户可通过齿轮按钮主动打开设置弹窗（不强制）
