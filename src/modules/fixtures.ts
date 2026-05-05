// 业务 fixture：来自 docs/01-journeys/analyst-research-cycle.md 的真实对话内容
// 让用户一启动就能看到一份"中国新茶饮 2026 出海"的真实研究 demo
//
// 设计原则（Stage 3 skill 要求）：
// - fixture 数据必须真实到能一眼看出业务价值
// - 用关键词模糊匹配 user 输入，返回对应预设回复
// - 缺省回复也是真实的"研究助手"风格

export interface CannedResponse {
  matchKeywords: string[];
  reasoning: string;
  content: string;
}

// 关键词匹配的预设回复（journey-1 的对话原型）
export const CANNED_RESPONSES: CannedResponse[] = [
  {
    matchKeywords: ['新茶饮', '出海', '阻力'],
    reasoning: `用户在写报告，要的是结构化分析…
需要从供应链、本地化、监管、品牌力四个维度切入…
要给案例支撑而不是泛泛而谈…
按重要性排序，第一是供应链——直接影响生死。
监管次之，因为 SKU 不合规等于资源沉没。
品牌叙事是个软指标，但天花板取决于此。`,
    content: `四个主要阻力，按重要性排序：

**1. 供应链与原料本地化（最大阻力）**
茶叶、奶基底、糖浆等核心原料的跨国供应链未成熟。蜜雪冰城在印尼通过自建基地缓解，但 2024 年泰国门店因原料断供曾大面积闭店。

**2. 口味本地化与品牌叙事**
霸王茶姬主打"东方茶"叙事在马来西亚奏效，但在欧美遇冷——消费者对"茶饮"这个品类本身缺乏中式语境。

**3. 监管与食品标准**
欧盟食品添加剂标准比中国严格，喜茶 2023 年试入德国时部分 SKU 因色素问题被迫下架重做。

**4. 单店模型的本地化**
国内"小店密集 + 外卖"模型在东南亚部分有效，在欧美高人工成本下完全不可复制——必须做大店 + 体验式消费。`,
  },
  {
    matchKeywords: ['品牌叙事', '欧美', '反例'],
    reasoning: `用户挑战了一个简化的判断…
要给出更精细的分层——不能笼统地说"茶饮在欧美"。
应该按品类拆：奶茶 vs 果茶 vs 纯茶。
Boba Guys 是个明显的反例。`,
    content: `更精细的分层：

**奶茶（boba/bubble tea）**：在欧美年轻华裔/亚裔聚集区已经形成稳定客群。Boba Guys 在旧金山和纽约都有成熟门店，单店年营收 $1.2M+。这条赛道**叙事不是问题**，分销和品类教育已被前辈完成。

**果茶**：欧美消费者认知接近"奶昔/思慕雪"，不需要"茶"的文化语境。喜茶在伦敦 2024 年的果茶 SKU 销量明显高于纯茶 SKU。

**纯茶（无奶基底）**：这是最难的一档。欧美对"茶"的文化锚定是英式红茶 + 日式抹茶，对中式茶饮缺乏接受框架。

所以更准确的说法是：**茶饮品类在欧美不是死路，但需要按子品类差异化进入**——奶茶用品类教育已完成的市场红利，果茶绕开"茶"的叙事直接切水果，纯茶暂时不做或做高端化定位。`,
  },
  {
    matchKeywords: ['供应链', '原料', '蜜雪', '霸王茶姬'],
    reasoning: `用户要 (a)(b)(c) 三个明确部分。
(a) 拆原料：茶叶、奶基底、糖浆、果浆、配料。
(b) 四个品牌的供应链解法各不相同：自建 vs 长链合作 vs 区域代工 vs 总部直供。
(c) 失败案例：蜜雪 2024 泰国闭店是公开案例。`,
    content: `**(a) 核心原料来源与替代方案：**
- 茶叶：福建/云南为主，海外可用斯里兰卡/印度替代部分品类
- 奶基底：植脂末来自马来西亚/印尼，鲜奶用本地（关键合规变量）
- 糖浆/果浆：可在东南亚本地代工，欧美需找清真/有机认证供应商
- 配料（珍珠/椰果）：广东/福建出口，海外仓储成本高

**(b) 四品牌的解法：**
- **蜜雪**：印尼建自有原料基地（投入 ~3 亿人民币），其他市场用区域代工
- **霸王茶姬**：东南亚走"原料本地代工 + 总部品控"双轨制
- **喜茶**：以总部直供为主，欧美市场进入慢，不愿降低品控
- **奈雪**：相对保守，以授权 + 总部供应链为主

**(c) 失败案例：**
蜜雪冰城 2024 年 Q2 泰国 14 家门店因珍珠原料供应商质量问题被迫闭店两周——单一供应商风险暴露。教训：海外供应链必须 dual-source 起步。`,
  },
  {
    matchKeywords: ['监管', '欧盟', '东南亚', '北美'],
    reasoning: `三市场监管差异要量化。
重点是食品添加剂标准、清真认证、HACCP 认证。
要列具体合规预备，不能泛说"做好合规"。`,
    content: `**三市场监管差异概览：**

| 维度 | 欧盟 | 东南亚（含马来/印尼） | 北美 |
|---|---|---|---|
| 食品添加剂 | 极严（约 320 种允许） | 中等 | 中等 |
| 清真要求 | 部分国家 | 强制（穆斯林为主市场） | 弱 |
| 进口检疫 | 严苛 | 中等 | 严苛但可预期 |
| 标签合规 | 14 种过敏原标注 | 较松 | FDA 标签必备 |

**出海前必须做的合规预备（按优先级）：**
1. **HACCP 体系**（出海首战场无差别要求）
2. **目标市场的添加剂红黑名单**——SKU 评估在产品开发阶段做，不要等装柜
3. **清真认证**（仅东南亚）：JAKIM（马）/ MUI（印尼）认证周期 6-9 个月
4. **冷链合规**：欧美对冷链记录的 traceability 要求高
5. **本地法人/进口商**：欧盟 GDPR + 食品类目分别需要 representatives

**最常见的"沉没成本"：**
是 SKU 配方在国内做完才送检，发现某个色素/香精被禁，需要重做整个配方——损失 3-6 个月研发周期。建议**配方开发阶段就并行做目标市场合规筛查**。`,
  },
];

// 提炼任务的预设输出（按 R011 强制四栏结构 + 全角中括号 marker）
export const REFINE_RESPONSE: CannedResponse = {
  matchKeywords: [],
  reasoning: `用户给了 N 段对话，要做综合提炼。
需要识别共同点：三个维度（供应链、监管、品牌叙事）都和"出海首站选择"相关。
矛盾点：东南亚 vs 欧美的取舍。
依赖关系：供应链 → 决定了能去哪，监管 → 决定了能否落地，叙事 → 决定了上限。
未解决问题：中东市场缺数据、单店模型未敲定。`,
  content: `【核心结论】
首站选择应基于"供应链可达性 × 监管熔断风险 × 品牌叙事适配"的最弱环节决定，而非单一维度最优。

【关键论据】
- 供应链不可达直接致命：蜜雪 2024 泰国 14 店因珍珠原料断供闭店两周
- 监管不通过则资源沉没：喜茶 2023 试入德国部分 SKU 因色素问题下架重做
- 叙事不适配致使增长上限低：茶饮品类在欧美与东南亚天然接受度差距显著
- 三因素彼此乘积，不可单点取舍

【未解决 / 待验证】
- 中东市场（非传统茶饮地区）的实际数据缺失
- 蜜雪与霸王茶姬的供应链投入回报比未量化
- "本地化大店模型"在欧美的最低盈利单店量未敲定

【可能的下一步】
- 比对蜜雪与霸王茶姬 2024 年报中供应链 capex 与单店毛利
- 调研 Boba Guys 在旧金山的单店营收与员工模型`,
};

// 撰写任务的预设输出（session-writer mock：第一人称随笔，去除AI味）
export const WRITE_RESPONSE: CannedResponse = {
  matchKeywords: [],
  reasoning: `用户在写一篇随笔…
从对话素材里捕捉到了几个灵感点：供应链的"生死线"判断、品牌叙事的分层逻辑、失败案例的教训。
第一人称走一遍思考过程，语气轻松但有立场。
段落长短不一，开头用具体场景切入，中间有自我怀疑和修正。`,
  content: `上周和几个做跨境的朋友聊天，聊到茶饮出海。

他们说了很多，我脑子里其实就一个画面——蜜雪冰城在泰国的 14 家店，因为珍珠断供全关了。不是什么大灾大难，就是供应商出了问题。两周。14 家店。

这事让我想了很久。

我们平时讨论出海，总是在谈市场多大、增速多快、哪个国家的人均消费更高。但其实这些数据是一个极其不稳定的透镜——它只在你活下来之后才有意义。活下来之前，唯一重要的事是供应链能不能撑住。

蜜雪的教训够清楚：一个供应商不行，你在海外就没货可卖。这不是"优化"问题，是"是否成立"的问题。所以我后来跟朋友说，选首站别看市场规模排名，看你的原料能不能在当地稳定供货。如果不能，那个市场再大也跟你没关系。

不过写到这我得纠正一下自己——刚才说"唯一重要的事是供应链"，这话太绝对了。监管一样致命。喜茶进德国那回，几个 SKU 因为色素问题直接下架，配方要重做。那种感觉应该是挺崩溃的：你花了几个月铺渠道、搞品牌、签合同，结果一个色素添加剂让你全白干。

供应链和监管，一个是"能不能到"，一个是"到了能不能卖"。这两个过了，才轮到品牌叙事上场。

品牌叙事这个事比较软，但它决定的是上限。霸王茶姬在马来西亚讲"东方茶"能通，在欧美就悬。不是故事不好，是听众不在那个文化语境里。Boba Guys 在旧金山做得好，因为他们没讲"茶文化"，他们讲的是"好喝的饮品"——这完全是两套语言。

说实话，我也不知道他们的单店模型能不能在柏林或者芝加哥跑通。人工成本差太多了。但至少有一点我确信：茶饮品类在欧美不是死路，是不能用一套打法打所有市场。

今天这篇写得有点散。不过本来也是从聊天里长出来的东西，散一点可能更真实。`,
};

// 缺省回复（关键词没匹配上时）
export const FALLBACK_RESPONSE: CannedResponse = {
  matchKeywords: [],
  reasoning: `用户的问题没有被预设关键词匹配。
我作为 mock 给一个真诚的"研究伙伴"风格回复——
承认信息边界，但尝试给出可推进的下一步。`,
  content: `（原型 mock 模式：当前预设的对话覆盖了"新茶饮出海"研究的几个主要分支。

你刚才的问题超出了 mock fixture 的覆盖范围。在真实部署中，这里会调用你配置的 LLM 端点（OpenAI 兼容协议）返回真实回答。

可尝试的问题（已 mock）：
- "中国新茶饮品牌出海有哪些主要阻力？"
- "聊聊供应链问题，重点讲蜜雪和霸王茶姬。"
- "三市场（欧盟/东南亚/北美）监管差异是什么？"
- "品牌叙事在欧美遇冷，给个反例。"
- 选中多个节点 → 点击右上角 "提炼" 按钮）`,
};

export function matchResponse(userText: string): CannedResponse {
  const lower = userText.toLowerCase();
  for (const r of CANNED_RESPONSES) {
    const hits = r.matchKeywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
    if (hits >= 2) return r;
  }
  return FALLBACK_RESPONSE;
}

// === Agent 模式 mock fixture（M2b 端到端测试用） ===
// 让 mock LLM 在收到带 tools 的请求时模拟 OpenAI Function Calling 协议；
// 触发条件参考真实 LLM 在文档 §4.1 的合法/不合法判定，让端到端测试贴近真实行为

export type AgentToolHint = 'web_search' | 'fetch_page' | null;

// 检测 user message 是否包含工具触发词。注意优先匹配 URL（fetch_page 比 web_search 更具体）。
// "搜/查/找" 等动作动词触发 web_search；含 http(s)://... 的内容触发 fetch_page。
export function detectAgentToolHint(userText: string): AgentToolHint {
  if (/https?:\/\/\S+/.test(userText)) return 'fetch_page';
  if (/(搜一下|搜下|搜索|查一下|查下|找一下|帮我搜|帮我查|帮我找|search\s)/i.test(userText)) {
    return 'web_search';
  }
  return null;
}

// 触发后的"调用前 thought"——LLM 在调工具前给出的简短解释（content 流）。
// 真实 LLM 通常会先说一句"我先搜一下..."；mock 保持简短。
export const AGENT_PRE_TOOL_THOUGHT: Record<NonNullable<AgentToolHint>, string> = {
  web_search: '让我先搜一下相关信息。',
  fetch_page: '让我读一下这个网页。',
};

// agent 二次调用时（messages 末端含 role=tool 的 observation 回灌），mock LLM 给出的 Final Response。
// 内容是固定模板——测试只关心"二次调用能给出 content 而不再调工具"，不关心具体内容
export const AGENT_FINAL_AFTER_TOOL = `基于工具返回的信息，这是综合性回答。

关键点：
- 第一条主要事实
- 第二条值得注意的细节
- 第三条延伸观察

如需深入某一方向可以继续追问。`;

// 触限测试触发词。让 mock LLM 跨多轮持续返回相同工具调用，绕过"含 tool message 就 final"的默认收敛逻辑。
// 仅用于 limits 测试，不应影响真实使用——真实 user 写"__force_loop_*__"的概率极低
export const AGENT_FORCE_LOOP_SEARCH = '__force_loop_search__'; // 每轮返回 web_search → 撞 max_same_tool=5
export const AGENT_FORCE_LOOP_ALTERNATE = '__force_loop_alternate__'; // 每轮交替返回 web_search/fetch_page → 撞 max_steps=8

// === 测试用：捕获 mockStream 最近一次的入参 messages，让 INV-11 / 协议层测试能读到 ===
// mockStream 在 mock-server 进程内运行，测试在 vitest 进程；测试通过 HTTP
// `GET /api/__test__/last-llm-messages` 端点跨进程读取（仅 mock 模式开放）

import type { LLMMessage } from '../types.js';

let lastMockLLMMessages: LLMMessage[] | null = null;

export function recordMockLLMMessages(messages: LLMMessage[]): void {
  // 浅拷贝：mockStream 调用方（llm-client）持有同一个 messages 数组引用，
  // 若不拷贝，后续对 messages 的 push/splice 会改变快照，导致测试断言读到非入参形态
  lastMockLLMMessages = messages.map((m) => ({ ...m }));
}

export function getLastMockLLMMessages(): LLMMessage[] | null {
  return lastMockLLMMessages;
}

export function __resetLastMockLLMMessagesForTest(): void {
  lastMockLLMMessages = null;
}

// react_text 模式触发词。用于让 mock LLM 在不带 tools 的请求下输出 JSON 字符串，
// 模拟"推理模型不支持 function calling 改用文本协议"的真实场景
export const AGENT_REACT_FORCE_SEARCH = '__react_text_search__';

// react_text 模式 mock 输出：第一轮 LLM 决定调工具的 JSON
export const REACT_FIRST_ROUND_JSON = JSON.stringify({
  thought: '我先搜一下相关信息。',
  action: { tool: 'web_search', args: { query: 'react_text mock query', maxResults: 3 } },
});

// react_text 模式 mock 输出：二次调用 LLM 给出 final 的 JSON
export const REACT_FINAL_JSON = JSON.stringify({
  thought: '信息已足够。',
  final: AGENT_FINAL_AFTER_TOOL,
});
