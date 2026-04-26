# 术语表

## 节点（Node）
画布上承载对话或提炼内容的基本单元。
- 类型分两种：**对话节点（dialogue）**（用户与 AI 的多轮对话）、**提炼节点（refined）**（从已有节点抽取生成）
- 状态分两种：**展开态**（显示完整消息列表 + 输入框）、**折叠态**（仅显示标题与最后一条消息预览）

## 边/连线（Edge）
描述两个节点的派生关系，方向为父→子。
- 类型分两种：**branch**（"从这里分支"动作产生）、**refine_input**（提炼任务的源节点连接）
- 边只能由系统在分支/提炼时隐式创建，不允许用户直接拉线

## 活跃节点（Active Node）
当前正在交互的单个节点。同一时刻最多 1 个，自动获得输入框焦点。

## 选中节点集合（Selected Nodes）
通过 Shift+点击建立的多选集合，仅用于"提炼"动作。

## 选中边（Selected Edge）
被点击命中的单条边。仅用于删除动作。

## 选择互斥
活跃节点 / 选中节点集合 / 选中边 三者在状态层互斥，同一时刻只有其中一种处于激活态。
- 区别于：浏览器的多模态选择（文本+元素）

## 流式状态（Streaming）
节点正在接收 LLM 流式输出的瞬时状态。
- 流式中的节点**不可删除**（INV-7 守卫）
- 流式状态不持久化，进程重启后所有流自动结束

## 配置完整 / 未配置（Configured / Unconfigured）
LLM 三要素 `baseURL`、`model`、`apiKey` **三者皆非空**称为"配置完整"，否则称为"未配置"。
- 未配置状态下首次启动会强制弹出设置弹窗
- 区别于：思考模式开关、隐私确认 等可选字段

## 提炼输出四栏
提炼任务的固定输出结构：核心结论 / 关键论据 / 未解决·待验证 / 可能的下一步。
- 四栏 marker 必须用全角中括号 `【】` 包裹，便于前端解析
- "未解决·待验证" 不可省略——产品对用户的诚实承诺

## 标题节流（Title Throttle）
节点标题自动生成的触发频率：每节点对话累计满 3 轮（即 6 条 message，user+assistant 各算一条）触发一次。
- 失败静默
- 由后端在 sendMessage 完成后异步触发，结果通过 SSE `title` 事件推送给前端

## 快模型 / 主模型
- **主模型（llmModel）**：用于对话、提炼等高价值场景（默认温度 0.7 / 0.3）
- **快模型（llmFastModel）**：用于标题生成等高频低价值场景（温度 0.2 / max_tokens 30）；留空时回退主模型

## 脱敏 apiKey（Masked apiKey）
服务端通过 `GET /api/settings` 返回的 apiKey 形如 `sk-•••xxxx`，前 3 位 + 中间星号 + 后 4 位。
- 真实 apiKey 仅以明文存于本地 `.data/db.json`，不上传任何外部服务
- 前端表单读到脱敏值时**不能**直接当作 value 写回（会覆盖真值），只能作为 placeholder 提示

## Agent 模式
节点对话的内部能力增强——当用户用动作动词（"搜/查/找/读"）请求外部信息时，AI 在常规对话基础上启动 ReAct 循环（思考→调工具→看结果→再思考……→给最终回复）。
- 不是第五个核心动作；用户视角仍是"打字、按 Enter、看 AI 回复"
- 启动权由 LLM 通过 tool_calls 主动选择，不在前端做关键词预检
- 产出物仍是一段普通的 AI 对话回复，不自动建节点 / 分支 / 提炼

## Agent 轨迹（Agent Trace）
一次 agent 调用产生的完整 step 序列：thought / action / observation / final 四类条目。
- 持久化在 `Message.agentTrace` 字段中，与 reasoningContent 同样**不回灌下游 LLM**（INV-11 扩展）
- 用户能在 UI 折叠区块内随时展开复盘
- 提炼任务对此字段视为不存在——只打包主线对话

## 工具（Tool）
agent 可调用的封闭外部能力。MVP 仅两个：
- **web_search**：基于关键词调用网络搜索引擎（POST `https://api.tavily.com/search`）
- **fetch_page**：基于 URL 抓取网页正文（POST `https://api.tavily.com/extract`）
两者均经 Tavily API 提供。共享 30s 超时、AbortSignal 合并、401/429/超时/网络/key 未配置错误分类。

## tavilyApiKey
Settings 中的 Tavily API key 字段，agent 模式下的 web_search / fetch_page 工具调用凭据。
- 治理沿用 R009 / D004（与 llmApiKey 同源）：服务端 GET 脱敏返回；表单 placeholder + dirty 标记；未修改不写回；明文仅本地 db.json
- 未配置时工具内部返回 `success=false` + `tavily_key_not_configured`，由 agent loop 把 observation 回灌给 LLM 决定（决策 15）；不在 detectToolSupport 层拦截

## USE_MOCK_TOOLS
环境变量开关。`=1` 时工具实现走 mock 占位（端到端测试 / 开发时不打真实 Tavily API）；其他情况走真实 Tavily 端点。
- pnpm test 脚本固化 `USE_MOCK_TOOLS=1`（与 USE_MOCK_LLM=1 双开关并列治理）
- prototype dev / electron 生产默认走真实 Tavily（用户体验完整）

## 工具调用模式（Tool Call Mode）
Agent 与 LLM 之间传递工具调用信号的两种协议：
- **native_tools**：OpenAI Function Calling 协议（chat/completions 的 `tools` 字段 + `delta.tool_calls`）
- **react_text**：把工具描述塞进 system prompt，从 LLM 文本输出解析 ACTION 块（兼容不支持 function calling 的模型）

运行时由 `detectToolSupport()` 探测当前 settings.llmModel 自动选择，对调用方透明。

## ReAct 循环（ReAct Loop）
Reasoning + Acting 范式的循环：thought（说出意图）→ action（调工具）→ observation（看结果）→ 重复直至信息足够 → final（最终回复）。是 agent 模式的执行骨架。
