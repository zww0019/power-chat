# 2026-05-10 electron-builder 产物命名修复

## 背景

GitHub Actions 跑 `pnpm build:linux` 时 deb 打包失败：

```
Parent directory does not exist:
.../electron/release/@power-chat - cannot write to
.../electron/release/@power-chat/electron_0.1.0_amd64.deb
```

## 根因

`electron/package.json` 的 `name` 字段是 scoped 名 `@power-chat/electron`。electron-builder 默认产物文件名模板含 `${name}`，scope 名里的 `/` 被 fpm 当成路径分隔符，生成不存在的父目录。

副作用：deb 包内 desktop / icon 文件名变成脏名 `@power-chatelectron.{desktop,png}`。

AppImage 通道使用 `productName` 而非 `name`，恰好绕开了该问题。

## 修复

仅改 `electron/package.json` 的 `build` 段：

| 字段 | 值 | 作用 |
|---|---|---|
| `artifactName` | `power-chat-${version}-${arch}.${ext}` | 锁定所有平台产物文件名，绕开 `${name}` |
| `executableName` | `power-chat` | 统一 Linux 可执行/desktop/icon 命名前缀 |

不改 `name` 字段（避免 monorepo 引用波动），不改 workflow。

## 影响范围

- Linux：`power-chat-0.1.0-x64.{AppImage,deb}`
- macOS：`power-chat-0.1.0-universal.{dmg,zip}`
- Windows：`power-chat-0.1.0-x64.{exe,zip}`

GitHub Release 资产命名统一为 ASCII，便于下载和脚本处理。

## 知识层级

L3 实现参考——构建配置细节，可随 electron-builder 升级调整。
