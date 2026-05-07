// 共享类型从 src/types 导入，避免双份维护（D008 / R013 治理）。
// 仅 type-only re-export，不引入 src 中的 class（如 ContextOverflowError 等）。
//
// 不要在此文件重新定义 Message / Node / Edge 等核心类型——历史上两份定义
// 曾导致字段不同步（reasoningContent 可选性不一致），Stage 5 统一后形成此约定。
export {};
