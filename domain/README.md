# 业务知识库

## 查询协议

处理任务前按以下顺序查阅：

1. 先读 glossary.md 确认术语
2. 读涉及模块的 modules/<module>.md
3. 检查 rules.md 中是否有相关硬规则
4. 如果涉及状态流转，读 state-machines.md

## 回写协议

完成任务后按以下分类更新：

- 术语新增/修改 → glossary.md
- 发现新的业务硬规则 → rules.md（必须带编号和来源）
- 做出业务层面的决策 → decisions.md（必须写明背景、决定、理由、影响）
- 模块内部业务逻辑变化 → modules/<module>.md
- 遇到意外边界情况 → edge-cases.md

## 禁止写入的内容

- 代码片段、函数签名、API 路径
- 文件索引、类/方法名列表
- 实现细节（只记"是什么"和"为什么"）
