# 业务决策记录

## D001 · 节点删除范围仅限活跃节点
**决策日期**: 2026-04-26
**背景**: 实现"按 Delete 删除节点"快捷键时，存在两种语义可选——只删活跃节点 vs 同时支持多选批量删除
**决定**: 仅删除活跃节点；多选集合（selectedNodeIds）专属于"提炼"动作
**理由**:
- 多选目前唯一的用途是提炼，删除多个节点不是高频操作
- "选中即可删除"的体验在多节点场景下风险高（误删难恢复，且当前没有 Undo）
- 单一删除入口让快捷键语义清晰
**影响**:
- 用户若要删多个节点必须逐个点击 + 删除
- 后续若需要批量操作，应通过显式多选 UI（如选框拖动）+ 二次确认弹窗实现

## D002 · 边删除提供「键盘 + × 按钮」双入口
**决策日期**: 2026-04-26
**背景**: 边删除可以仅靠 Delete 键，也可以选中后在边上显示删除按钮
**决定**: 选中边后既可按 Delete 删除，也可点击边中点的 × 按钮删除
**理由**:
- 键盘方案对鼠标用户不直观（需要先理解"边可以被选中"）
- × 按钮提供视觉反馈，让"边可以被删除"这件事自我解释
- 两种入口的代价仅为一个 SVG 按钮，性价比高
**影响**:
- 边层 SVG 必须开放 pointer events（命中区 14px 透明粗 line）
- 选中态视觉必须明显（紫色加粗）以提示 × 按钮的来源

## D003 · 未配置 LLM 时强制弹出设置弹窗
**决策日期**: 2026-04-26
**背景**: 用户首次启动若不知道要先配置 LLM，所有发消息操作都会失败
**决定**: 应用 hydrate 后立即检查"配置完整"状态，未配置则强制弹出设置弹窗（用户必须填写或显式关闭）
**理由**:
- 此前没有任何 UI 入口，用户只能编辑 db.json 或 DevTools，体验不可接受
- 强制弹出比"发消息时报错"更早暴露问题，缩短用户的失败路径
- 设置完成是 LLM 功能可用的前置条件，把这个条件可视化
**影响**:
- 启动后多一次 GET /api/settings 请求
- 后续若新增其他必填配置（如多模型切换），同样的检测应扩展进 unconfigured 判定

## D004 · apiKey 脱敏防覆写约束
**决策日期**: 2026-04-26
**背景**: 服务端返回的 apiKey 是脱敏字符串（如 `sk-•••abc1`），若前端表单直接 `value={apiKey}` 绑定，用户不修改而保存就会把脱敏字符串写回 db，永久破坏真实 key
**决定**:
- 服务端返回的脱敏 apiKey 仅作 placeholder 显示（提示"当前已配置某 key"）
- 表单 input value 始终留空
- 提交前判断 apiKey 字段是否被用户修改过；未修改则 patch 中不带 apiKey 字段
**理由**:
- 服务端 PUT 是合并写入，不传字段即保持原值（已有 settings.test.ts:38 覆盖）
- 把"是否传字段"的决定权留在前端最清晰
- 用户能看到当前 apiKey 的尾部 4 位即可确认配置存在，无需展示完整明文
**影响**:
- 任何对 settings 表单的扩展都必须延续这个约束（其他敏感字段同理）
- 服务端 PUT 必须保持"部分字段不覆写其他字段"的合并语义，绝不能改成全量覆盖

## D010 · 跨模块工具函数必须抽到 _utils 或 shared 文件
**决策日期**: 2026-04-26
**背景**: 阶段 5 扫描发现 conversation/refine 各自重复了 newId/nowIso、流式 buffer 累加、message 持久化、SSE 解析等 6 处样板；prototype/types.ts 与 src/types.ts 也维护两份接口
**决定**:
- 任何 ≥2 处使用的工具函数必须抽到 `src/modules/_utils.ts`（业务 helper）或 `src/modules/sse.ts`（协议解析）等单一文件
- 前端 `prototype/src/types.ts` 必须 type-only re-export 后端 `src/types.ts`，不允许重新定义核心类型
- 新增模块前先在 _utils / sse 中检索，避免再产生孤立样板
**理由**:
- 双份维护历史教训：Message 接口的 reasoningContent 可选性曾在前后端不一致
- 抽出后改一处即可同步两端，事故面收敛
- jscpd 在 CI 中应作为门禁（`Found N clones` 必须 ≤ 已知白名单）
**影响**:
- 新功能开发的"先看是否能复用 helper"成为编码前置约定
- 测试 helper（`tests/integration/helpers.ts`）享有同等待遇——createNode/sendMessage/createBranchedPair 等 fixture 一律抽 helper

## D011 · 单组件 CCN 阈值 15，超阈值必须拆子组件或抽 helper
**决策日期**: 2026-04-26
**背景**: CanvasNode 历史上 CCN 高达 23，难维护；realStream / dispatchRpc 等也曾超 40
**决定**: 任何函数/组件 CCN 超 15 必须治理：
- React 组件优先拆子组件（按视觉/职责分离）
- async generator 优先抽 helper（如 _utils.runAssistantStream）
- handler 函数优先提到模块顶层（如 nodeActions.performXX），不内联在组件
**理由**:
- CCN 反映分支密度，与可读性、可测试性强相关
- 阈值 15 是 lizard 默认推荐值，与团队经验一致
- 拆分后单元测试更容易（hook 独立、helper 纯函数）
**影响**:
- CanvasNode 当前拆为 ExpandedNodeView / NodeHeader / NodeFooter / RefinedNodeBody / DialogueNodeBody / CollapsedDialogueCard / CollapsedRefinedCard 等多组件
- lizard 在 CI 中应作为门禁（`-C 15` 阈值不放宽）

## D006 · 节点标题生成节流粒度为每 3 轮对话
**决策日期**: 2026-04-26
**背景**: 标题生成是高频后台调用，每条对话都触发会浪费 token；不触发又会让节点折叠态长期显示"新节点"
**决定**: 每节点对话累计满 3 轮（user+assistant 各算一条，即每 6 条 message）触发一次标题更新
**理由**:
- 3 轮足以让对话主题稳定，不会过早被零碎话题误导
- 频率低于"每轮触发"，对成本影响小
- 失败静默（不影响主流程），用户可手动触发提炼任务做精确总结
**影响**:
- title 字段持久化到 db.json，hydrate 后可见
- 每 3 轮额外发起一次轻量 LLM 调用（max_tokens=30，使用快模型）

## D007 · 引入 llmFastModel 字段供高频轻量调用
**决策日期**: 2026-04-26
**背景**: 文档要求"对话/提炼用强模型，标题生成用快模型"以平衡成本与延迟
**决定**: Settings 增加可选字段 `llmFastModel`；标题生成等轻量调用优先用此字段，留空时回退到 `llmModel`
**理由**:
- 不破坏现有"单模型即可工作"的最小配置体验（留空回退）
- 给愿意优化成本的用户提供配置位
- 后续若新增其他高频轻量调用（如自动 tag）可复用
**影响**:
- SettingsDialog 新增一个输入字段，默认折叠或低优先显示
- llm-client.streamChat / completeChat 必须支持运行时覆盖 model 参数

## D008 · 提炼四栏走前端 marker 切分
**决策日期**: 2026-04-26
**背景**: 提炼输出的四栏结构如何渲染为四个独立 section？后端解析（重）vs 前端按 marker 切（轻）vs 不切分（差）
**决定**: 后端不解析；前端按 `【核心结论】` `【关键论据】` `【未解决 / 待验证】` `【可能的下一步】` 四个 marker 切分；任一栏缺失则提示"格式漂移，可重试"；解析整体失败则兜底显示原文
**理由**:
- 后端解析需要严格 schema，与"AI 自由文本输出"语义冲突
- 前端切分让 LLM 输出的"格式不严格"作为用户体验的一部分（看到提示，可手动重试）
- 兜底原文展示保证最差情况下用户仍能看到内容
**影响**:
- prompt 必须明确强制四栏 marker（已在 R011 锚定）
- 后端 1 次格式不全的轻提示重试可减少触发"格式漂移"提示的概率

## D009 · 视觉设计判断标准：不抢用户注意力
**决策日期**: 2026-04-26
**背景**: 视觉规范文档明确产品哲学是"为深度思考而设计的安静工具"
**决定**: 任何视觉元素必须通过这个测试——"它在传达必要信息，还是在装饰自己"；判断标准不是"好看不好看"
**理由**:
- 这是产品哲学的视觉延伸，不是审美偏好
- 提供 PR/PR 评审、设计提案的统一裁决标准
**影响**:
- 任何加色块、加渐变、加阴影、加图标的提议都要先通过此测试
- 反面参考（Miro/FigJam/ChatGPT 网页版）→ 砍；正面参考（iA Writer/Linear/早期 Notion/Bear）→ 学

## D005 · 折叠态点击展开采用「pointerup + 位移阈值」判定
**决策日期**: 2026-04-26
**背景**: 节点 header 拖拽用 setPointerCapture 实现，capture 生效后会吞掉 click 事件，导致折叠按钮和"点 collapsed 卡片展开"完全失效
**决定**:
- 折叠按钮在 onPointerDown 上 stopPropagation，阻止 capture 链建立
- collapsed 卡片整片走 onPointerDown→拖拽流程，单击展开判定改用 onPointerUp 时的位移距离（小于 4px 视为单击）
**理由**:
- 不能简单禁掉 setPointerCapture（拖拽出容器边界时需要它保证 move/up 不丢）
- click 在 capture 场景下不可靠，pointerup + 位移是 PointerEvents 规范下推荐的判定方式
- 4px 阈值既覆盖正常点击的指针抖动，又不影响真实拖拽
**影响**:
- 后续任何带拖拽的 UI 元素（边、提炼弹窗等）都不能依赖 click 事件
- 阈值若调整需要在两个文件保持一致（App.tsx 中的 CLICK_THRESHOLD）

## D013 · 工具调用协议自适应（native_tools 优先 / react_text 兜底）
**决策日期**: 2026-04-26
**背景**: agent 实现需要决定走 OpenAI Function Calling（依赖模型 tool_calls 能力）还是手写 ReAct prompt + 文本解析。前者解析鲁棒但部分模型（DeepSeek-R1 / OpenAI o1 等推理模型）不完整支持；后者所有模型可用但解析脆弱
**决定**:
- 引入 `ToolCallMode = 'native_tools' | 'react_text'` 两枚举值
- 运行时由 `detectToolSupport()` 根据 settings.llmModel 自动选择：白名单模型走 native_tools，黑名单走 react_text，未知模型一次试探调用判定，结果按模型名缓存
- agent loop 对调用方透明——不暴露当前模式，统一以 `agent_*` SSE 事件输出
**理由**:
- 不锁死任一种协议，让产品在不同模型生态下都可用
- 用户切换 settings.llmModel 后无需手动配置，自动适配
- native_tools 在主流模型上鲁棒性远高于自己 parse；react_text 仅作兜底
**影响**:
- LLM 客户端（M2 实施）必须扩展 `tools` / `delta.tool_calls` 字段，同时保留 react_text 模式的 prompt 拼装路径
- 探测结果不持久化，避免错误结果污染长期配置
- 新增模型时白/黑名单需要同步更新

## D014 · web_search / fetch_page 均经 Tavily API（不引入 playwright）
**决策日期**: 2026-04-26
**背景**: 网页内容读取最自然的方案是 playwright + chromium（能跑 SPA / 动态渲染），但代价是 ~500MB 包体增量 + electron 维护浏览器实例 + 进程池复杂度。fetch + cheerio 轻但无 JS 渲染。Tavily 提供 Search 与 Extract 两个端点，覆盖搜索 + 内容抓取两个场景
**决定**:
- web_search 调 Tavily Search API（`https://api.tavily.com/search`）
- fetch_page 调 Tavily Extract API（`https://api.tavily.com/extract`）
- 不引入 playwright；不在 mock-server / electron 维护浏览器实例
- 单次 fetch_page 内容上限 50_000 字符（在工具内部截断，标记 truncated=true）
**理由**:
- electron 包体不增加 chromium，分发友好
- Tavily 专为 LLM 设计，返回 markdown 摘要 + 已剥离脚本/样式，与下游 LLM 输入格式天然契合
- 失败语义统一（与 search 同 provider，错误处理同源）
- 登录墙 / 付费墙仍会失败，按 §4.6 诚实告知用户（不绕行——法律风险）
**影响**:
- 用户必须在 settings 配置 Tavily API key（M3 接入时新增字段 `tavilyApiKey`）
- Tavily 服务故障会同时影响两个工具
- 后续若需要离线 / 自托管搜索，需另启决策（不在 MVP 范围）

## D015 · agentTrace 扩 Message 字段而非新表
**决策日期**: 2026-04-26
**背景**: agent 轨迹（thought/action/observation/final 序列）需要持久化。可选：扩 Message.agentTrace 字段（JSON blob）或建独立 messages_agent_steps 表
**决定**: 在 `Message` 接口加 `agentTrace?: AgentStep[] | null` 字段
**理由**:
- 轨迹与消息严格一对一绑定，读时一次取出无需 JOIN
- 现有持久层是 JSON 文件适配器，blob 字段无负担
- 与已有的 `reasoningContent` 字段架构对称，认知成本低
**影响**:
- `agentTrace` 受 INV-11 扩展（R019）守卫——不回灌下游 LLM
- 未来若要做轨迹查询索引（如"找出所有用过 web_search 的消息"），届时再做表迁移；MVP 不预先优化
- 持久化 schema 仍是 JSON 文件，备份/恢复策略不变

## D016 · Agent 触发判定纯 LLM，不做前端关键词预检
**决策日期**: 2026-04-26
**背景**: 何时启动 agent 有三种实现思路：(1) 前端正则匹配"搜/查/读"等关键词、(2) 前端关键词预检 + LLM 兜底、(3) 完全交给 LLM 通过 tool_calls 主动决定
**决定**: 走方案 3——纯 LLM 判断；前端不做任何关键词检测
**理由**:
- 关键词正则会侵入对话语义（用户说"我搜了一下"也会误触发）
- 原则 C 的本质是"用户用动作动词明确请求"——这种"明确"由 LLM 通过 prompt 引导更准确
- system prompt 已经明确"默认不启动 agent"的偏置，AI 自己保守判断成本低
- 失败模式可观察：通过 §八 启动率指标监测，若 <10% 或 >50% 再调整 prompt
**影响**:
- LLM 必须支持 tool_calls 或 react_text 至少一种（D013 自适应保证）
- 触发的"准确率"是产品调优指标，不是产品规则
- 失败模式 1（"用户嫌 agent 启动太保守"）的应对方案是引入"要我搜一下吗？"轻量交互，仍不退化为关键词预检

## D017 · Agent 上下文分层（主线 vs 完整轨迹）
**决策日期**: 2026-04-26
**背景**: agent 跑出的中间内容（thought/action/observation）若并入主线对话，下次用户继续聊时 AI 看到一长串工具调用历史会迷失重点；但用户又需要看到完整过程才能保持透明性（原则 D）
**决定**:
- **完整存储**：`Message.agentTrace` 存完整轨迹，UI 能折叠/展开复盘
- **主线对话流**：节点对话历史"主线"仅含 user message + assistant Final Response，**不含** agent 中间过程
- **下游 LLM 输入**：assembleContext / toLLMMessage 剥离 agentTrace 与 reasoningContent
- **提炼任务**：只打包主线，不打包轨迹
**理由**:
- "agent 过程是给用户看的，不是给 AI 自己看的"——这个分层让透明性与对话质量两不影响
- 用户若希望某段轨迹内容进入下游，可在主线对话里**显式引用**——引用动作本身是用户主权的表达
- token 经济上，轨迹长度可观，并入主线会让多轮对话快速触达上下文上限
**影响**:
- INV-11 扩展为 R019——agentTrace 与 reasoningContent 同等待遇
- 测试需扩展 contract.test.ts，确保 agentTrace 字段不出现在下游 LLM 调用
- 跨节点分支（继承父节点对话）继承的是主线，不继承父节点的 agentTrace

## D018 · detectToolSupport 黑名单优先 + 默认乐观，不做试探调用
**决策日期**: 2026-04-26
**背景**: D013 确定工具调用协议自适应（native_tools 优先 / react_text 兜底）。具体实现 detectToolSupport 时面临三种策略：
- (a) 试探调用：每次新模型先发一次极小 LLM 请求带空 tools，看返回判定支持
- (b) 白名单优先：仅显式列出的模型走 native_tools，其余降级 react_text
- (c) 黑名单优先：仅显式列出的推理模型走 react_text，其余默认 native_tools
**决定**: 选 (c) — 黑名单优先 + 未命中时默认 native_tools，不做试探调用
**理由**:
- 试探调用增加首字延迟（每次 sendMessage 多一次 RTT）；研究场景对响应速度敏感
- 业界主流 chat 模型（gpt-4* / claude-* / deepseek-chat / qwen* / mistral-* / gemini-* 等）已普遍对齐 OpenAI Function Calling 协议；白名单会让"未列入"的新模型默认降级，不利于跟进生态
- 推理模型（deepseek-reasoner / o1-* / r1-*）的输出格式与 tool_calls 协议存在已知冲突，必须显式标注降级 react_text
- 探测错误时由 agent loop 兜底降级（M2b 实现）— 调用工具失败时切换 react_text 重试，不在探测层做容错
**影响**:
- 进程内缓存（Map<modelName, ToolCallMode>），不持久化 — 避免错误判定永久固化
- 新增推理模型族时必须同步更新黑名单（REACT_TEXT_PREFIXES）
- 测试用 `__resetToolSupportCacheForTest()` 暴露给单元测试清空缓存
- 黑/白名单都未命中的模型如果实际不支持 native_tools，首次调用工具会失败 — M2b 的 agent loop 必须实现"native_tools 失败自动降级 react_text 并缓存"

## D019 · agent 触限后用一次额外 LLM 调用给 Final Response（不再带 tools）
**决策日期**: 2026-04-26
**背景**: agent loop 触达硬约束（max_steps=8 / max_same_tool=5 / max_time=3min）时如何收尾？三种思路：
- (a) 直接结束并显示"已超限请重试"——用户体验差，且已收集的 observations 浪费
- (b) 用产品代码拼一段固定模板"我已搜索/阅读了 N 个来源…"——内容机械、对用户低帮助度
- (c) 不带 tools 调一次 LLM，把 messages（含已收集 observations）喂回去让 LLM 基于现有信息给 Final Response
**决定**: (c) — agent_final 事件先告知前端触限原因，紧接着调 streamChat（不带 tools）拿到的 content 流作为 Final Response 流式 yield 给用户
**理由**:
- 文档 §六原话："已收集信息交给 AI 做最终回复"——此决策直接落地该意图
- 用户视角的体验完整：触限不是"卡住"，而是"AI 综合已有信息回答了你"
- 实现成本低：复用现有 streamChat；总结调用本身**不带** tools，确保不会再触发 agent loop 形成递归
**影响**:
- 触限发生时实际 LLM 调用次数 = max_steps + 1（最后一次是总结调用）
- 总结调用的 messages 含大量 tool 角色消息——若 token 估算超 80% 会被 ContextOverflowError 拦截；这种情况下用户会看到 error，预期罕见但需监测
- 软约束（system prompt 中"5 步停下汇报"）由 LLM 自觉遵守；硬约束 + 触限恢复由代码强制——两层不互替

## D020 · 拆分 INV-11 语义：agentTrace 永不回传 vs reasoningContent 按协议要求
**决策日期**: 2026-04-26
**背景**: 用户报告 DeepSeek-Reasoner 思考模式下连续发消息 `400 invalid_request_error: The reasoning_content in the thinking mode must be passed back to the API`。根因排查：早期 INV-11 注释写"reasoningContent 不入下游"是基于 OpenAI 协议假设（reasoning 是模型内部态），把"agentTrace 永不回传"和"reasoningContent 不回传"两个不同动机**混为一谈**：
- agentTrace 不回传：协议无关——agent 内部记录不是 LLM 协议字段（防 prompt injection / 上下文污染）
- reasoningContent 不回传：协议相关——OpenAI 假设服务端管理状态；但 DeepSeek-Reasoner 协议**反过来**要求客户端回传

**决定**:
- **拆分语义**：R019 仅约束 agentTrace（协议无关 / 永不回传）；新增 R020 约束 reasoningContent（按协议要求决定）
- **toLLMMessage 改造**：白名单透传 `reasoningContent`；agentTrace 仍由白名单 select 守卫（不被选入）
- **toOpenAIMessage 改造**：在 reasoningContent 非空时写 `reasoning_content` snake_case 到请求体；**始终写入不按模型族分支**——支持的模型用，不支持的模型忽略此字段，避免脆弱的字符串匹配
- **estimateMessagesTokens 扩容**：纳入 reasoningContent 估算（避免 ContextOverflowError 漏判）
- **测试启用**：原 `it.skip` 的"INV-11 协议层"测试启用，新断言 (a) agentTrace 不在 messages 中；(b) assistant 历史含 reasoningContent

**理由**:
- 原 INV-11 是基于 OpenAI 协议假设的"普适规则"；DeepSeek-Reasoner 把这个假设打破——必须按协议要求决定
- "始终透传"比"按模型分支"更稳：模型族字符串匹配脆弱（新模型上线就 false negative）；下游不支持的模型忽略未知字段是 OpenAI 协议规范行为
- 拆分后两条规则各有清晰的协议归属：R019 是产品守卫，R020 是协议适配

**影响**:
- `LLMMessage` 加可选 `reasoningContent: string \| null` 字段（M2a 起 LLMMessage 已扩 toolCalls / toolCallId，本次再加一个不破坏既有协议）
- 跨进程测试通信新增 `GET /api/__test__/last-llm-messages` 端点（暴露 mockStream 入参快照）
- 后续若要支持 OpenAI o1（不需回传）/ Anthropic（字段名 thinking）协议，在 toOpenAIMessage 内按需扩展，不影响 toLLMMessage 透传层
- INV-11 历史描述退役；conversation.ts / llm-client.ts 模块顶部注释同步修正

**2026-04-26 补充修订**：

第一版 D020 仅修复了**跨段路径**（conversation.toLLMMessage 透传），但用户继续报 400。重新查阅 DeepSeek 官方文档（https://api-docs.deepseek.com/zh-cn/guides/thinking_mode）发现协议是**两层分情况**：

| 路径 | 触发条件 | reasoning_content 要求 |
|---|---|---|
| **跨段**（两个 user 之间无 tool_calls） | 普通对话连续两轮 | 可省略（传了 API 忽略，无害） |
| **段内**（两个 user 之间有 tool_calls） | agent native_tools 模式调工具 | **必须**回传，不传 400 |

- 第一版 D020 仅覆盖"跨段透传"——但当前 agent.runAgentLoop 内部 push 的 assistant tool_calls message 没有 reasoning_content 字段，导致段内第二个 sub-turn 的 LLM 调用 400。这是 R020b 的根本动机
- 补充修订：拆 R020 为 R020a（跨段透传）+ R020b（段内累积），并在 agent.ts `OneRoundResult` 加 `reasoningBuf` 字段、`consumeLLMRoundStream` 累积 reasoning delta、`runAgentLoop` push 时携带 reasoningContent
- 段内方案与文档"messages.append({role: 'assistant', content, reasoning_content, tool_calls})"对齐
- E014 同步精确化：触发条件三个并列（native_tools 模式 + enableReasoning + 有 tool_calls）；react_text 模式（deepseek-reasoner 黑名单命中）不走 native_tools 不受影响

## D021 · 撤销 LLM 调用前置 token 守卫
**决策日期**: 2026-04-26
**背景**: `streamChat` 之前在调 LLM 前做"前置 token 估算守卫"——`if (tokensIn > limit * 0.8) throw ContextOverflowError`。问题：
- `MODEL_LIMITS` 维护成本高（白名单覆盖不全；用户用未在白名单的模型走默认 32_000 → 但真实模型可能上限 64K/128K → 误判 false positive）
- 估算系数（中文 ×0.7，其他 ×0.4）保守，对 reasoning 模型偏差更大
- 用户实测 DeepSeek-Reasoner 64K 限制下被误判为 32K 触限阻断（错误信息 "context_overflow: 34319/32000"）
- 真实 LLM API 自身有准确的 context overflow 判定，会立即返回错误，前置守卫是冗余且不可靠的中间层

**决定**:
- 删除 `streamChat` 内的 token 估算阻断；信任真实 LLM API 的拒绝行为
- `estimateTokens` / `estimateMessagesTokens` / `MODEL_LIMITS` / `getModelLimit` / `ContextOverflowError` 类**保留**（未来 settings 可能展示 token 用量；如果有重新激活守卫需求可低成本恢复）
- mock-server 的 `if (e instanceof ContextOverflowError)` catch 块保留（dead-defensive 路径）

**理由**:
- 真实 LLM API 是 context limit 的权威源，前置守卫永远只能"逼近"
- 守卫误判（false positive）的代价高于"让请求发出去被 API 拒"的代价：前者用户被无声阻挡，后者用户能看到具体错误并决策
- 撤销后用户可以使用任何模型而无需更新 `MODEL_LIMITS`；模型上限自然由 API 反馈

**影响**:
- 撤销前置守卫后真实超长请求会增加一次无效 LLM 调用（但 DeepSeek 等会立即返回错误且不计费失败请求）
- 配套修改：`nodeActions.applyStreamEvent` 把 `error` 事件写入 message（store.markMessageError）让用户在节点内看到错误，不只在 DevTools console
- `tests/integration/conversation/messages.test.ts:49-52` "上下文超长返回 413" 测试已 skip，撤销后该路径永不触发；保持 skip 状态，注释更新

## D012 · AI 消息渲染选用 react-markdown + remark-gfm，拒绝 streamdown
**决策日期**: 2026-04-26
**背景**: AI 输出原本以 `whiteSpace: pre-wrap` 当纯文本渲染，缺少 Markdown 富格式。曾评估 Vercel streamdown，但其强依赖 Tailwind / shadcn token / mermaid 75MB 硬依赖，对当前 React 18 + 内联样式 + Electron 打包体积敏感的项目代价过高
**决定**:
- AI 消息（`message.role !== 'user'`）走 `<MarkdownContent>`（react-markdown@9 + remark-gfm@4）
- 用户消息保持纯文本 + `pre-wrap`（用户输入无 Markdown 语义）
- `RefinedContent`（提炼节点四栏）保持自定义 marker 切分，不进 Markdown 管道
- `reasoningContent`（思考过程）保持 `pre-wrap` 纯文本
- 不引入 Tailwind / shadcn / mermaid / KaTeX / Shiki；样式通过 react-markdown `components` 映射 + 内联 style 承担
- 流式期间通过 `closeOpenMarkdown` 闭合未完成的 `**` / `*` / `` ` `` / ```` ``` ````，避免半成品语法导致渲染抖动
- 安全：默认禁 raw HTML（不开 rehype-raw）；`a`/`img` 走协议白名单（`http(s)` / `mailto` / `data:image`）
**理由**:
- streamdown 的 Tailwind 强耦合与 mermaid 硬依赖与项目"内联样式 + 极简依赖"的取向冲突
- react-markdown 默认禁 raw HTML 是天然 XSS 防御，配合协议白名单足以应对 prompt injection 场景
- `closeOpenMarkdown` 的浅层闭合策略实现成本低（~20 行），覆盖 80% 流式抖动场景
- `React.memo` + 模块级 `components` 常量保证 token 高频更新下子树稳定
**影响**:
- 后续若需要数学公式 / Mermaid 图 / 代码语言着色，应在 `MarkdownContent.tsx` 内逐项接入（如 `rehype-katex` / `rehype-highlight`），而非引入 streamdown
- 节点卡片宽度有限的约束传递到 Markdown 样式：表格强制 `overflow-x: auto`、h1-h6 字号降级到 13-15px、宽代码块滑动展示
- 任何对 AI 消息样式的改动应集中在 `MarkdownContent.tsx` 的 `components` 映射，避免散落

## D022 · 节点 fullscreen 形态用全局 fullscreenNodeId，不扩 node.displayMode 三值枚举
**决策日期**: 2026-04-26
**背景**: 用户提出"节点应该可以展开为大屏对话框，而不是扎进节点内部输入"。规划阶段评估两种状态模型：
- A：把现有 `node.collapsed: boolean` 改为 `node.displayMode: 'collapsed' | 'expanded' | 'fullscreen'`（节点状态自包含）
- B：保留 `node.collapsed: boolean`，新增**全局 store 字段** `fullscreenNodeId: string | null`

**决定**:
- 选 B：全局 `fullscreenNodeId` 字段，**不持久化**（`partialize` 排除），不动 node schema
- 进入大屏时同步把节点 `collapsed=true`（避免画布与 Modal 同时展示同一节点的展开内容）
- 关闭大屏后节点保持折叠态（用户明确决策 F），由 `closeFullscreen` 只清空 `fullscreenNodeId`、不动 collapsed 实现
- 同时只能 1 个节点处于 fullscreen，由 `openFullscreen` 直接覆写字段保证

**理由**:
- "覆盖层 Modal" 在产品语义上天然就是全局唯一（同一时刻最多 1 个），与全局字段一一对应；用 node 自身字段反而要在打开新节点时主动清旧节点的字段，逻辑反而绕
- node schema 是持久化层契约（含 mock-server / api-contract / fixtures），改 displayMode 会牵动整套迁移；全局字段不进 schema 零迁移成本
- 不持久化是产品决策：刷新视为用户离开了大屏，恢复到一个被遗忘的全屏态体验差
- 与既有 `activeNodeId` / `selectedEdgeId` / `streamingByNode` 等"运行时派生 UI 状态"放在一起，归类一致

**影响**:
- `domain/state-machines.md` 节点折叠态从 2 态扩为 3 态（expanded/collapsed/fullscreen），新增 fullscreen↔collapsed 双向迁移
- `domain/rules.md#R013` 加 fullscreen 视觉规格（宽 `min(70vw, 900px)`、高 `min(80vh, 800px)`、遮罩 `rgba(0,0,0,0.4)`、字号 14）
- 节点 header 新增 `⛶` 触发按钮，仅展开态可见（折叠态卡片 200×56 太小，跳过）
- 流式控制"全局并发 1"（R018）不受影响——fullscreen 仅是 UI 形态，不影响 streaming 调度

## D023 · Minimap 极简实现：不显示 edge / 不抽 toggle / 实时随 store 更新
**决策日期**: 2026-04-26
**背景**: 用户提出"画布右下角显示一个全局预览的小视窗"。规划阶段需在以下选项间取舍：
- 是否显示 edge（连线）？
- 是否提供"折叠为图标"toggle 让用户隐藏？
- 节点宽高怎么估算？（折叠态精确 200×60，展开态实际高度由内容决定）

**决定**:
- **不显示 edge**：minimap 主要作用是"位置感知 + 跳转"，180×120 尺寸下连线会变成像素噪点
- **默认展开 + 不加 toggle**：第一版减少 UI 状态；用户后续若反馈占用空间再加
- 节点宽高估算：折叠 200×60（精确）、展开统一估 360×360（minimap 比例不敏感，不做精确测量）
- 视口框包含到 bbox 计算中（保证视口框始终落在 minimap 内可见）
- 单击空白跳转 / 视口框内拖拽 → 全部直接 `setViewport` 写 store；App 顶层 `useEffect([canvas])` 自动同步本地 vx/vy/zoom state（依赖 zustand persist 的对象引用变化触发）

**理由**:
- edge 渲染在小尺寸下视觉收益低、加大计算量、还要处理 bezier 曲线缩放，不值得
- toggle 是"未来可能用到"的扩展点，第一版无证据需要；遵循"不为不存在的需求加状态"
- 节点高度精确测量需 ResizeObserver 监听每个 DOM，与 minimap 的"低保真俯瞰"定位不符；统一估值能让多次重渲染中 minimap 表现稳定（避免节点高度抖动导致 bbox 跳变）

**影响**:
- `domain/rules.md#R013` 增加 minimap 视觉规格条目
- `domain/glossary.md` 新增"全局预览（Minimap）"术语
- 节点高度估算偏大（实际可能 100-200px，估 360）→ minimap 比例略偏，但不影响功能；后续若发现偏离过大再换更精确策略

## D024 · 边渲染自适应 4 方向锚点 + 折叠态真实尺寸
**决策日期**: 2026-04-26
**背景**: 用户反馈两处边渲染异常：
- 父节点折叠时，连线起点悬空在卡片下方约 140px 处（不贴卡片底边）
- 默认分支布局是父节点右侧 +440px（水平相邻），但边强制走"父底→子顶"，曲线绕大 U 型与节点真实方位不匹配，"看着混乱"

根因：旧实现在 `Edge.tsx` 用 `NODE_ESTIMATED_HEIGHT = 200` 写死高度，且锚点固定为父底中→子顶中，不感知 `collapsed` 状态也不区分相对方位。

**决定**:
- 锚点策略：按父子中心点 `(dx, dy)` 的主轴方向择最近一对边中点
  - `|dx| ≥ |dy|` → 水平边（dx≥0：父右中→子左中；dx<0：父左中→子右中）
  - `|dy| > |dx|` → 垂直边（dy≥0：父底中→子顶中；dy<0：父顶中→子底中）
- 节点尺寸：根据 `collapsed + type` 取真实 box（折叠 200×56 dialogue / 200×60 refined，展开 360×200 估算），常量来自 `Node.tsx` 实测渲染高度
- 控制点：沿锚点法向（主轴方向）外推 `|delta|/2`，使贝塞尔切线在锚点处与所在边垂直，曲线自然切出后弯入对端
- 几何函数抽到 `prototype/src/canvas/edge-geometry.ts`（无 React 依赖，纯函数），`Edge.tsx` 仅保留 SVG 渲染与命中区

**理由**:
- 折叠态卡片高度仅 56/60px，写死 200 必然悬空——节点尺寸是边几何的输入，必须真实
- 默认分支布局水平相邻（D 系列分支决策遗产），强制垂直锚点违反节点真实拓扑；4 方向锚点让边自适应任意布局
- 控制点取 `|delta|/2` 是经验值：让贝塞尔在两端都呈现切线一致的"S 弯"形态，既不过度弯曲也不近似直线
- 抽出 edge-geometry 让几何独立可测（13 个单测覆盖 4 方向 + 折叠/展开 + 边界）

**影响**:
- `domain/rules.md#R013` 第 83 行更新（"垂直中点"描述失效）
- 新增 `prototype/src/canvas/edge-geometry.ts` + `tests/unit/canvas/edge-geometry.test.ts`
- 折叠态宽度从 360 缩到 200 同步反映在 x 锚点（旧实现也偏右 80px）
- 展开态高度仍用 200 估算（消息多时实际可能更高）→ 当前可接受，后续若边明显偏离展开卡片底边再升级 ResizeObserver 测量

## D025 · 帮助弹窗实现选择（位置 / 内容 / ESC 不分级 / 不抽 hook）
**决策日期**: 2026-04-26
**背景**: 用户提出"在界面上加一个帮助快捷按钮，点击查看快捷键和功能说明"。规划阶段需在以下选项间取舍：
- 按钮挂载点：左下角独立 fixed / 顶部 toolbar ⚙ 旁
- 弹窗实现：复用现有 Modal 模板 / 抽通用 Modal 组件 / 引 markdown 渲染
- ESC 行为：与 fullscreen 分级关闭 / 一起关闭
- 是否抽 useEscapeKey hook 给三处 Modal 共用

**决定**:
- 按钮放在顶部 toolbar 中、⚙ 设置按钮**左侧**，规格与 ⚙ 完全一致（共用 `toolbarBtnStyle` 常量）；图标用 `?` 字符（与 ⛶/⚙/`−` 一致的纯字符 icon 风格）
- 弹窗 inline 在新文件 `HelpDialog.tsx`，参考 SettingsDialog 的 480px pattern；4 个区块（关于 / 核心操作 / 键盘快捷键 / 节点三态）内容直接 JSX 写死，不引 markdown 解析器
- ESC **不分级**：HelpDialog 的 keydown 监听器不调 stopPropagation，与 fullscreen 同时打开时一起关闭（用户合理预期"一键全清"）
- **不抽** `useEscapeKey` hook：当前 3 处 Modal（settings/fullscreen/help）的 ESC 监听各自 inline 三行 useEffect，抽 hook 收益小于"减少一层间接抽象"的价值
- 状态管理：`helpOpen` 用本地 `useState` 在 App.tsx 维护，不入 store（与 settingsOpen 同模式，无跨组件共享需求）
- zIndex 取 300，介于 NodeFullscreenModal(200) 与 SettingsDialog(1000) 之间

**理由**:
- ⚙ 旁的位置让"工具栏动作"语义自然分组，比左下角独立按钮的认知成本低
- 内容硬编码避免引 markdown 解析器（增加 bundle、引入解析时机/转义/链接等额外维度），帮助文案稳定不需要动态加载
- ESC 不分级是"YAGNI"——分级关闭需要全局 Modal 栈管理，目前没有证据表明用户会抗拒"一起关"
- 不抽 hook 遵循"3 次以下不重复就不抽"的经验法则（CLAUDE.md "Three similar lines is better than a premature abstraction"）
- 引入 `toolbarBtnStyle` 模块级常量是对"两个完全相同的内联样式"的去重（jscpd 在第一版命中 21 行重复），属于真实重复，不是过度抽象

**影响**:
- `domain/rules.md#R013` 增加 HelpDialog 视觉规格、Modal zIndex 层级表、toolbar 按钮统一规格
- `domain/modules/ui-interaction.md` 弹窗模态章节追加 HelpDialog 条目
- 后续若新增 Modal，需查 R013 zIndex 层级表选合适层级；若新增 toolbar 按钮，复用 `toolbarBtnStyle` 常量
- 帮助内容若需扩展（如新增快捷键），直接改 `HelpDialog.tsx` 的 JSX；同步更新 R013 来源行

