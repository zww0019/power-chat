// 工具协议定义。所有工具必须实现 ToolDefinition；agent loop 通过统一接口调用。
//
// parameters 字段直接采用 OpenAI Function Calling 兼容的 JSON Schema，
// 这样 native_tools 模式可零拷贝拼装 request；react_text 模式由 agent.ts
// 把 description + parameters 反向序列化进 system prompt。
export {};
