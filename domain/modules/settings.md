# 设置模块（settings）

## 职责
持有 LLM 配置 singleton（baseURL / model / apiKey / 思考模式开关 / 隐私确认）。

## 配置完整性判定
`baseURL` / `model` / `apiKey` 三者皆非空 = 配置完整。
- 任一为空时：阻断 LLM 调用（INV-9 守卫）；前端检测到此态强制弹出设置弹窗

## apiKey 隔离与脱敏
- 真实 apiKey 仅以明文存入本地 .data/db.json，不出本机
- 服务端对外（HTTP / IPC）暴露的 apiKey 永远是脱敏字符串（前 3 + 中间 ••• + 后 4）
- PUT 是合并写入：不传字段不覆写；这是 apiKey 表单 dirty flag 防覆写约束的依赖

## 连通测试
- POST /api/settings/test 用当前 baseURL + apiKey 调 OpenAI 兼容的 `/models`
- 成功返回模型列表（用于前端 datalist 引导用户选择）
- 失败映射 502，附错误信息
- USE_MOCK_LLM=1 时返回固定假数据，避免触发外部网络

## 前端表单约束（dirty flag）
- apiKey input value 始终留空，脱敏值仅作 placeholder
- 用户编辑 apiKey 时置 dirty=true，提交时才把 apiKey 加入 patch
- 未编辑则提交不带 apiKey 字段（依赖 PUT 合并语义保持原值）

## 强制弹出触发
- 应用 hydrate 完成后立即 GET /api/settings 检测
- 任一字段为空 → setSettingsOpen(true)
- 用户主动通过齿轮按钮也可打开（无强制）
