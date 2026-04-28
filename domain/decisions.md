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

## D006 · 节点标题生成双轨制（2026-04-27 第二次修订：自动轨 + 主动轨并存）
**决策日期**: 2026-04-27（同日两次迭代：先废弃自动→改主动；后又恢复自动并保留主动，形成双轨）
**背景**:
- 2026-04-26 旧方案：每 3 轮对话节流自动触发；触发计数器用 sequence 偏移（`(nextSeq+2)%6`）+ 失败 `.catch(() => null)` 静默，导致用户反馈"对话 6 轮但标题不更新"
- 2026-04-27 第一次修订：完全废弃自动触发，改为用户主动点击 ↻ 按钮
- 2026-04-27 第二次修订：保留按钮的同时**恢复自动触发**，但修掉旧实现的两个根本 bug

**决定（双轨制）**:
1. **自动轨**：在 `sendMessage` 的 `runAgentAssistantStream` 的 `onComplete` 内触发，每 3 轮（6 条 message）一次
   - 触发条件改用**实际消息条数**：`messages.length >= 6 && messages.length % 6 === 0`，规避 sequence 偏移 bug
   - 永远强制覆盖（不判断 `node.title` 是否已有值，与主动轨语义对齐）
   - 通过 SSE `'title'` 事件透传成功标题；失败时通过新增的 `'title_error'` 事件透传简化错误码（empty_node / not_configured / llm_failed / unknown），前端 toast 提示
   - 事件顺序硬约束（E016）：title / title_error 事件必须在 done 之前 yield
2. **主动轨**：用户点击节点 header / 折叠卡 / 大屏 Modal 标题旁 hover 显示的 ↻ 图标按钮
   - 走独立 `POST /api/nodes/:id/regenerate-title` 端点，一次性返回 `{title}`
   - 成功 toast.success；失败 toast.error
3. **共用错误码语义**：`conversation.classifyTitleError`（后端归类）和 `nodeActions.extractTitleErrorCode`（前端从 HTTP 错误响应提取）输出同一组 code，前端 `titleErrorMessage` 统一映射 toast 文案——两轨之间无文案漂移

**理由**:
- 自动轨保证"长期对话节点的标题保鲜度"——用户不必每 3 轮去手动点一下
- 主动轨保证"用户主动意图永远成立"——不依赖任何触发条件，随时可强制刷新
- 错误可见（修掉旧 bug）：自动轨不再静默吞错，失败时 toast 提示
- sequence 偏移 bug 从根上规避：用 `messages.length` 计数而非 sequence 整除

**影响**:
- 类型变更：`StreamEvent` 恢复 `'title'` + 新增 `'title_error'`；`runAgentAssistantStream` 恢复 `onComplete` 参数
- 后端：`conversation.sendMessage` 的 `onComplete` 闭包；`classifyTitleError` 函数把领域错误转成简化 code
- 前端：`applyStreamEvent` 增加 `case 'title' / 'title_error'`；`titleErrorMessage` 共享映射
- 历史 db.json 中已有的标题保留不动，不做数据迁移

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

## D026 · 字号松绑 + AI 消息复制 + 胶囊样式抽取
**决策日期**: 2026-04-27
**背景**: 用户反馈"字体太小且看着太密"，并要求"AI 回复消息补充复制功能，逻辑与编辑消息一致"。规划阶段需在以下选项间取舍：
- 文字优化幅度：是否升档 / 是否突破 R013 字号阶梯 / 行高与 padding 调整粒度
- 复制按钮位置：右下并排（与分支按钮同侧）/ 左下（与编辑按钮位置对称）/ 右下分层
- 复制内容格式：保留原始 markdown / 渲染为纯文本
- 是否给 user 消息也加复制按钮
- 复制按钮是否需要 disabled 态（与编辑按钮的 R021 守卫"一致"）
- 重复样式抽取粒度：5 处胶囊按钮各持一份 / 抽 1 个常量 / 抽函数 + 变体

**决定**:
- **字号**：inline 气泡 13→14（与 fullscreen 14 对齐）；节点 Header 13→14；输入框 13→14；折叠卡 gap 2→4；操作按钮 padding 2×8→3×10、字号维持 11；行高 1.6→1.65；大屏 Modal 标题 15→16（顺手修复 R013 越档）。所有调整严格在 R013 现有六档（22/16/14/13/11/10）内迁移，不引入新档位
- **复制按钮位置**：左下 `left:0, bottom:-8`，与 user 气泡编辑按钮位置对称；当该消息已派生分支（BranchBadge 占据 `left:0`）时，复制按钮 `left` 改为 56 让位避让
- **复制内容**：保留原始 markdown 符号（直接写入 `message.content`），不剥离；不带入 `reasoningContent` / `agentTrace`（已是独立字段，无需额外处理）
- **不给 user 消息加复制**：v1 范围限定
- **不加 disabled 态**：复制不修改数据，与 R021 守卫的"截断/编辑"语义无关；"逻辑与编辑消息一致"的"一致"指 hover 触发 + 胶囊视觉规格 + 位置对称，不延伸到 R021 守卫
- **剪贴板实现**：`navigator.clipboard.writeText` 主路径 + `document.execCommand('copy')` 兜底（覆盖 Electron file:// 非安全上下文）；成功/失败用 `toastStore` 反馈
- **胶囊样式抽取**：在 NodeChatPanel.tsx 内引入 `pillBase`（共形：fontSize 11 / padding 3×10 / borderRadius 12）+ `pillPrimary(disabled?)`（紫边白底主色变体），CopyButton/EditButton/BranchButton/BranchBadge/UserBubbleEditor 取消提交按钮统一引用，调整视觉规范改 1 处生效
- **标题刷新逻辑抽取**：新建 `prototype/src/canvas/useTitleRegeneration.ts` hook，节点内 / 大屏 Modal 两处复用同一份 loading 守卫 + stopPropagation + try/finally；用 `loadingRef` 而非把 `loading` 纳入 `useCallback` 依赖，避免重建 trigger 引用导致消费方重渲

**理由**:
- 字号在档内迁移而非引入 15px：保持 R013 六档纯度，避免视觉规范碎片化；inline 与 fullscreen 字号统一让用户在两种形态间切换时无视觉跳跃
- 左下对称位置：与 user 编辑按钮形成"操作按钮固定在气泡左下"的视觉规律，新增按钮无需额外学习成本；右下保留给"分支"语义按钮（独立维度）
- 保留 markdown：用户在外部编辑器（VSCode / Notion / Markdown 渲染器）粘贴时能保留格式；若需纯文本可在外部去渲染
- 不加 disabled：避免给用户造成"复制也会破坏数据"的错误心智模型
- execCommand 兜底：Electron 早期版本或部分 file:// 上下文 `navigator.clipboard` 不可用，历史踩坑经验保留
- 抽 pillBase + pillPrimary：jscpd 在第一版扫描中命中 5 处样式重复（34 行 257 tokens），抽取后复扫 0 clones；属于真实重复
- 抽 useTitleRegeneration hook：jscpd 命中 11 行 84 tokens 重复，且节点内 / 大屏 Modal 两处的标题刷新行为完全同形，无差异化；用 ref 而非依赖项保护 trigger 引用稳定，是 React useCallback 处理"读快照而非订阅状态"的标准模式

**影响**:
- `domain/rules.md#R013` 更新字号阶梯说明（fullscreen 不再"略放大"，inline 也用 14）+ 新增"消息操作胶囊按钮统一规格"条目
- `domain/modules/conversation.md` 新增"AI 消息复制（仅前端能力）"小节
- `prototype/src/canvas/NodeChatPanel.tsx` 新增 `pillBase` / `pillPrimary` / `CopyButton` / `copyViaExecCommand`；EditButton/BranchButton/BranchBadge/UserBubbleEditor 全部改用胶囊常量
- 新增 `prototype/src/canvas/useTitleRegeneration.ts` hook
- 后续新增"消息上的 hover 操作按钮"应直接复用 `pillPrimary()`；新增标题刷新入口直接调 `useTitleRegeneration(nodeId)`；不再单独写 loading 守卫
- **2026-04-27 后续修订（见 D027）**：`pillPrimary` 已被工具栏改造删除；本影响项中"复用 `pillPrimary()`"已失效，新增消息操作按钮请改用 `MessageToolbar` + `ToolbarIconButton`

## D027 · 消息悬浮工具栏改造（替换 D026 中的胶囊按钮设定）
**决策日期**: 2026-04-27
**背景**: D026 落地后用户反馈"悬浮胶囊"视觉过重，希望改造为"悬浮工具栏"——更轻量、聚合感更强。规划阶段需在以下选项间取舍：
- 聚合形态：横向 icon 工具栏 / 多按钮各自圆点 / 单按钮 ⋯ 下拉菜单
- 出现位置：气泡内右上角 / 气泡上方 / 气泡下方
- 适用气泡：user + assistant 都改 / 仅 assistant 改
- 显示形式：仅图标 / 图标+文字 / 图标+tooltip
- BranchBadge 处理：保持常驻 / 移到右下让位 / 并入工具栏作为一项
- 是否保留胶囊感

**决定**:
- **位置**：user 工具栏在气泡**右下** `right:0,bottom:-8`，assistant 工具栏在气泡**左下** `left:0,bottom:-8`（与 D026 中 user 编辑按钮的左下位置不同，**反转方向**）
- **样式**：去胶囊感，纯 icon + 透明背景 + 无边框/阴影；按钮颜色默认 `#94a3b8` / hover 或 highlighted `#6366f1` / disabled `#cbd5e1`；按钮字号 13、`padding:'2px 4px'`；容器 `display:flex / gap:6`
- **按钮项**：user = `✎`（编辑）；assistant = `📋`（复制）+ `↳`（分支）+ `⑂N`（已派生分支时追加，点击展开浮层）；不新增功能项
- **BranchBadge 改造**：从常驻徽章改为工具栏内的 hover 触发项；popover 状态由父 AssistantBubble 受控（`popoverOpen` state）；popover 打开期间工具栏强制保持可见 + 该按钮持续 `highlighted` 主色
- **触发**：沿用 hover 80ms 防抖
- **抽象**：在 NodeChatPanel.tsx 内引入 `MessageToolbar`（容器） + `ToolbarIconButton`（图标按钮），统一所有消息操作按钮的样式与交互
- **删除**：`pillPrimary()` / `pillPrimaryDefault` / 独立 `EditButton` / `CopyButton` / `BranchButton` 组件 / `hasBranchBadge` 让位逻辑
- **保留**：`pillBase`（UserBubbleEditor 取消/提交按钮还需要"主/次按钮"对比，胶囊视觉合理）

**理由**:
- 去胶囊感后视觉负担降低，且消息列表越长，按钮越多时，扁平 icon 比胶囊更不抢戏
- user 右下 / assistant 左下 = 各自气泡"远离消息列表外缘"的内侧角；与 D026 的"对称位置"相比，反转方向更符合"工具栏聚合在气泡内侧"的视觉规律
- BranchBadge 并入工具栏 = 信息密度从"扫一眼可见"降为"hover 才知道"——用户已明确选择此代价（决策点 R）
- popover 打开时工具栏强制可见：避免鼠标穿过工具栏与浮层之间的间隙时工具栏 hover 失效带飞 popover；属于"延长可见时间"而非"改变交互语义"
- ToolbarIconButton 内部 hover state 自治：透明 icon 必须靠颜色变化提示交互，把 hover state 放在按钮自身比放在父级集中管理更内聚
- 保留 pillBase 给 UserBubbleEditor：编辑模式是模态化的"操作面板"语境，主/次按钮的胶囊形对比保留更明确——不与气泡尾部工具栏的"轻量浮层"语境混淆

**影响**:
- `domain/rules.md#R013` 替换原"消息操作胶囊按钮统一规格"为"消息操作工具栏统一规格"；新增"编辑模式按钮保留胶囊形"补充条目；来源行追加 D027
- `domain/modules/conversation.md` "AI 消息复制（仅前端能力）"小节重写：增加工具栏形态、按钮项清单、popoverOpen 兜底说明；删除"BranchBadge 让位避让"过期描述
- `prototype/src/canvas/NodeChatPanel.tsx` 删除 `pillPrimary` / `EditButton` / `CopyButton` / `BranchButton` / 旧 `BranchBadge`；新增 `MessageToolbar` / `ToolbarIconButton` / `BranchBadgeButton`；handleCopy 内联进 AssistantBubble；引入 `popoverOpen` 状态
- 后续新增"消息上的 hover 操作按钮"应使用 `MessageToolbar` + `ToolbarIconButton`，而非已删除的 `pillPrimary`；按钮颜色须遵守 R013 中工具栏 token

## D028 · 暖质感视觉系统重做（Token 体系 + Bear/Things 风）
**决策日期**: 2026-04-27
**背景**: 用户反馈"当前整个界面看起来都特别小气"。logic-reviewer 调查后定性"小气感"来源 8 项：字号普遍 11–13px、助手气泡无层次、节点阴影 0.03 alpha 近无、顶部工具栏散胶囊、Unicode/Emoji 图标廉价感、间距压缩、无动效、配色冷蓝紫与暖米底相分裂。规划阶段需在以下决策点取舍：
- 是否引入 Token 体系（tokens.css + theme.ts）
- 主色：保留冷蓝紫 vs 切焦糖茶（Bear 风）vs 切深天蓝（Things 风）
- 字号是否上调（base 14→15）
- 是否引入图标库（lucide-react）
- 顶部工具栏是否整合为 blur 胶囊
- 改造颗粒度（分批 review vs 全套一次完成）

**决定**:
- **Token 体系**：新建 `prototype/src/styles/tokens.css`（CSS 变量）+ `prototype/src/styles/theme.ts`（TS 镜像）作为视觉单一事实源，覆盖颜色 / 字号 / 间距 / 圆角 / 阴影 / 动效 / 字体 / keyframes 八类；组件统一从 token 读取，禁止硬编码视觉值
- **主色切焦糖茶 #B8783A**（accent-500），副色墨绿 #5C7556（moss-500）；冷蓝紫 #185FA5/#6366f1/#a78bfa 全量替换；暖米奶油底（paper #FBF9F2 / canvas #F1EFE8）+ hsl 偏黄 8% 的暖灰阶（ink-50..900）
- **字号上调**：base 14→15、节点 header 14→16、大屏标题 16→18；行高统一 1.65–1.75；fontWeight 启用 600/700 以增加层次
- **lucide-react 替换全部 Unicode/Emoji 图标**（💬→MessageSquare / ✎→Pencil / ⑂→GitBranch / ↳→CornerDownRight / ⛶→Maximize2 / ◆→Sparkle / ✦→Sparkles / ⚙→Settings / ?→HelpCircle 等），size 13–18、strokeWidth 1.6–2.0；Edge 删除按钮的 × 改用两条 SVG line（lucide 不便嵌套进外层 SVG）
- **顶部工具栏整合**：左 Logo / 中提炼按钮（焦糖渐变） / 右状态条 + 帮助 + 设置 三段式 floating bar，各段半透明 paper(0.72) + backdrop-blur 20px + radius.pill
- **节点立体感**：默认阴影从 0.03 alpha 升级到 shadow-md（多层柔和暖阴影）；hover/active 升 shadow-lg；提炼节点加 3px 焦糖渐变顶部饰条
- **气泡层次**：助手气泡从透明改为 surface-soft（暖白）+ 0.5px ink-200 + radius.md；用户气泡 accent-50 + accent-100 边
- **空状态再设计**：88×88 焦糖渐变图标方块 + Sparkles + 主标题 22px + 副标题 + 主按钮（ink-900 实心）+ 双击提示 五段式
- **动效层接入**：tokens.css 提供 spin/blink/toast-in/modal-in/overlay-in keyframes + 三种 ease 曲线 + 三档时长；弹窗 overlay-in + modal-in 双层；Toast toast-in 入场；节点 hover/active 200ms 过渡；连线选中色变 200ms；流式光标改 blink 方块
- **弹窗共享 primitives**：抽离 `prototype/src/canvas/_dialogPrimitives.tsx`（ModalShell / IconButton / CloseButton / DialogButton），HelpDialog / SettingsDialog / RefinePopover / NodeFullscreenModal 全部改用之；App.tsx 抽 `createNodeAt(logicalX, logicalY)` helper 统一双击和空状态主按钮的创建路径

**理由**:
- 设计 Token 是"全套改造"的地基：未来任何全局视觉调整（换主色、调字号档、改阴影体系）只改 1 处即可——避免散落硬编码导致的视觉规范碎片化
- 主色焦糖茶（暖橙偏茶）与画布暖米底色相协调，符合用户选择的 "Bear 奶油纸感 + Things 圆润分寸感"；冷蓝紫 + 暖米底是当前最割裂的视觉冲突，必须切除
- 字号上调而非维持小档：当前用户的"小气感"主诉的核心是字号普遍偏小（11–13px 是 IDE/工具类应用尺度，不适合"思考画布"这种长阅读 + 长编辑场景）；上调到 15/16/18 后长 AI 回复阅读体验显著改善
- lucide-react 替换 Unicode/Emoji：解决"图标大小不齐 / 基线漂移 / 廉价感"三大问题；30KB gzip 成本可接受
- backdrop-blur 顶部胶囊：代替统一 toolbar 容器，可让画布在工具栏背后透出营造空间感；blur 是低成本制造层次的现代手法
- 全套一次完成：用户明确要求"全套"，分批 review 反而打断视觉一致性体验
- 抽 _dialogPrimitives.tsx：jscpd 在阶段 5 检出 4 处弹窗内部重复（CloseButton / Button / Modal overlay 外壳 / createNode 逻辑），用户选择本轮一并修；同目录抽离成本极低，未来新增弹窗收口

**影响**:
- 新增 `prototype/src/styles/tokens.css` + `prototype/src/styles/theme.ts`（视觉 token 双形态事实源，单一事实源在 tokens.css）
- 新增 `prototype/src/canvas/_dialogPrimitives.tsx`（ModalShell / IconButton / CloseButton / DialogButton）
- 改造 16 个组件文件（App.tsx / canvas/{Node,NodeChatPanel,Edge,Minimap,AgentTrace,RefinedContent,MarkdownContent,SettingsDialog,HelpDialog,NodeFullscreenModal,RefinePopover,ToastContainer}.tsx + styles/global.css）：全部接入 token、全部 Unicode 图标替换为 lucide
- `domain/rules.md#R013` 大幅重写为"形态级约束 + token 索引指针"形式：具体色值/字号/圆角/阴影/动效一律走 token，不在 R013 内逐一展开（避免 token 升级时 rules.md 变成漂移源）
- `domain/modules/agent.md` AgentTrace 视觉规格更新（背景从 #F5F4EE 切 rgba 暖米半透明 + accent-200 边 / 字号 11→token.text.xs / 步骤图标改 lucide）
- `domain/modules/ui-interaction.md` AgentTrace + 启动过渡 + 中断按钮视觉规格同步更新
- 新增依赖 `lucide-react@^1.11.0`（约 30KB gzip）
- 后续新增弹窗一律复用 `ModalShell`；新增 icon 按钮一律复用 `IconButton`；新增主/次按钮一律复用 `DialogButton`；新增图标一律 lucide-react；新增可复用样式抽到 `_dialogPrimitives.tsx` 或新建 primitives 文件而非逐组件内联


## D029 · OpenRouter 思考兼容改造（provider 显式枚举 + 字段并集解析）
**决策日期**: 2026-04-28
**背景**: 用户接入 OpenRouter 后报告"开启思考无效"。代码梳理定位两个并列根因：
- **请求侧**：`buildOpenAIRequestBody` 无差别发 `reasoning:{enabled:true}`——这是项目自造字段名，OpenRouter 实际接受 `reasoning:{effort:"medium"}`，字段名不匹配被静默忽略，思考从未激活
- **响应侧**：`parseSSELine` 只读 `delta.reasoning_content`（DeepSeek 私有字段）——OpenRouter 流式响应使用 `delta.reasoning`（字符串）和 `delta.reasoning_details`（结构化数组），前端永远收不到思考内容

**决定**:
- **显式 provider 枚举**：Settings 加 `provider: 'openai' | 'deepseek' | 'openrouter' | 'custom'` 字段；不用 baseURL 字符串包含判断（更显式、用户可手动覆写）；旧 db.json 缺字段时按 baseURL 启发式推断一次（含 openrouter.ai → openrouter，依此类推）
- **思考强度三档**：Settings 加 `thinkingEffort: 'low' | 'medium' | 'high'`，默认 medium；UI 在思考开关打开时显示三档按钮；OpenRouter/OpenAI 走 `reasoning.effort`，DeepSeek/custom 不映射
- **请求体按 provider 分支翻译**：详见 R022——四档 provider 各自独立路径，OpenRouter/OpenAI 用 effort，DeepSeek 不写，custom 兜底 enabled 保留旧契约
- **SSE 字段并集解析**：取 `delta.reasoning` / `delta.reasoning_content` / `delta.reasoning_details` 并集，命中任一就拍平为纯文本 yield reasoning 事件给 UI；同时并行 yield reasoning_details 事件让持久化层保留原始结构（用户决策"显示一致 + 上下文保留一起做"）
- **思考显示一致**：所有 provider 拍平到 `Message.reasoningContent` 字符串，UI 复用现有 ReasoningBlock 折叠组件，不为不同 provider 维护差异化展示
- **多轮思考连续性**：详见 R023——OpenRouter 路径下持久化 `Message.reasoningDetails` 并跨轮回灌；其他 provider 静默丢弃，避免中转端点 400
- **移除 Anthropic 分支**：用户使用 Claude 模型统一走 openrouter 路径，OpenRouter 内部翻译 effort 到 thinking.budget_tokens；本侧不维护 Anthropic 协议直连分支（用户在阶段 2 v2 显式要求移除）
- **thinkingModeEnabled 默认值不变**（保持 false）

**理由**:
- 显式 provider 枚举：URL 字符串包含判断脆弱（用户可能用反代/私有路径），且用户可能希望"我用 OpenRouter 的 baseURL 但走 custom 兜底契约"——枚举字段允许这种意图表达
- SSE 字段取并集：四个推理协议家族字段名不一致是事实（OpenRouter 标准化 `reasoning`、DeepSeek 用 `reasoning_content`、OpenRouter 结构化用 `reasoning_details`），上游不会统一；本地取并集比按 provider 切换解析路径更稳（OpenRouter 内部本身也会出现 reasoning + reasoning_details 同帧）
- 显示一致：OpenRouter `reasoning_details` 含 type=reasoning.encrypted 类型（无文本仅有 data）等多种形态，给 UI 维护差异化展示成本高、收益低；拍平到字符串后 UI 链路与现有 DeepSeek 路径完全一致
- 多轮回灌：OpenRouter 文档 §Preserving Reasoning 明确要求 reasoning_details 在多轮 + 工具调用场景必须按原结构回传，否则模型丢失思考连续性

**影响**:
- 既有 DeepSeek/custom 用户**无感升级**：custom 分支保留旧 `reasoning:{enabled:true}` 契约；DeepSeek 路径仍走 reasoning_content 字段；旧 db.json 自动按 baseURL 推断 provider
- OpenAI o1/o3 系列首次可用：之前发 `enabled:true` 也被忽略，现在改成正确的 `effort` 字段
- `Message`/`LLMMessage` 加可选 `reasoningDetails: ReasoningDetail[] | null` 字段；`StreamEvent` 加 `reasoning_details` 事件类型；`db.json` 数据量上限随 OpenRouter 思考密集场景增加（可接受，未来若有问题再做截断）
- 设置弹窗加 Provider 下拉 + Effort 三档按钮（仅在思考开关打开时可见）
- 单元测试覆盖请求体形态四分支 + SSE 字段并集；集成测试验证端到端 reasoning_details 持久化与多轮回灌
