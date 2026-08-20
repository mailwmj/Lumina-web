# Lumina（流光）

<div align="center">
  <img src="./src-tauri/icons/128x128@2x.png" width="100" height="100" alt="Lumina（流光）" style="margin-bottom: -50px;">
  <h1 style="color: ##111227;">Lumina <span>流光</span></h1>
  <h3>基于节点画布的 AI 视频生成工具，支持 Seedance 系列模型，一站式完成素材上传、提示词生成与视频创作</h3>
</div>

## 基于项目

本项目基于 [henjicc/Storyboard-Copilot](https://github.com/henjicc/Storyboard-Copilot) 修改，主要新增：

- **Seedance 系列视频生成**：集成豆包 Seedance 2.0 / 2.0 Fast / 1.5 Pro 视频生成模型
- **提示词润色**：支持图片和视频提示词的 AI 润色优化
- **多模态参考**：支持图片、视频、音频多种素材参考输入
- **交互优化**：改进节点交互和细节体验

## 下载

<div align="center">
Windows 用户请下载 <strong>.exe</strong> 文件，macOS 用户请下载 <strong>.dmg</strong> 文件

Windows 用户如果在启动时遇到了报错，请尝试安装 [WebView2 运行时](https://developer.microsoft.com/zh-cn/Microsoft-edge/webview2#download)
</div>

## 技术栈

- 前端：React 18 + TypeScript + Zustand + `@xyflow/react` + TailwindCSS
- 桌面容器：Tauri 2
- 后端：Rust 命令接口
- 数据存储：SQLite（`rusqlite`，WAL）
- i18n：`react-i18next` + `i18next`

## 环境要求

- Node.js 20+
- npm 10+
- Bun 1.3+（仅用于编译桌面安装包内的 Canvas Agent 可执行文件）
- Rust stable（含 Cargo）
- Tauri 平台依赖（Windows/macOS）

安装与平台准备可参考：
- [基础工具安装配置（Windows / macOS）](./docs/development-guides/base-tools-installation.md)

## 快速开始

```bash
npm install
npm install --prefix canvas-agent
```

仅前端开发：

```bash
npm run dev
```

Tauri 联调（推荐）：

```bash
npm run tauri dev
```

### 外部 Agent MCP

桌面安装包包含由 Lumina 自动管理的本机 MCP companion。用户启用外部 Agent 后，
通过校验的变更会直接应用到当前画布，并保留整批一次撤销；安装后的用户不需要源码、
Node.js 或 Bun。Codex 注册、开发态接入、工具权限和验证方式见
[外部 Agent MCP 文档](./docs/agents/external-agent-mcp.md)。

## 常用命令

```bash
# TypeScript 类型检查
npx tsc --noEmit

# Rust 快速检查
cd src-tauri && cargo check

# 前端构建检查
npm run build

# Tauri 构建桌面应用
npm run tauri build
```

## 功能特性

### 节点画布
- 拖拽式节点编辑
- 多种 AI 节点类型：图片生成、视频生成、分镜生成等
- 连线式工作流编排

### 视频生成
- **Seedance 2.0 / 2.0 Fast**：豆包最新视频生成模型
- **Seedance 1.5 Pro**：支持样片模式（draft）
- 支持多模态参考输入（图片 + 视频 + 音频）
- 多种生成模式：多模态参考、编辑视频、延长拼接

### 提示词工具
- AI 提示词润色优化
- 支持图片和视频提示词
- 参考素材自动标记（@图1、@视频1、@音频1）

## 项目结构（核心）

```
src/
  features/canvas/          # 画布主流程（节点、工具、模型、UI）
  stores/                   # 全局状态与自动持久化策略
  commands/                 # 前端到 Tauri 命令桥接
  i18n/                     # 国际化入口与语言包
src-tauri/src/
  commands/                 # Rust 侧命令实现（含 project_state）
  lib.rs                    # Tauri 命令注册入口
docs/development-guides/    # 开发与扩展文档
```

## 扩展开发

### 新增模型

1. 在 `src/features/canvas/models/image/<provider>/` 新增模型文件
2. 声明 `displayName`、`providerId`、分辨率/比例、默认参数
3. 实现请求映射函数 `resolveRequest`

### 新增节点

1. 在 `src/features/canvas/domain/canvasNodes.ts` 增加类型与数据结构
2. 在 `src/features/canvas/domain/nodeRegistry.ts` 注册默认数据与连线能力
3. 在 `src/features/canvas/nodes/index.ts` 注册渲染组件

详细指南：
- [项目开发环境与注意事项](./docs/development-guides/project-development-setup.md)
- [供应商与模型扩展指南](./docs/development-guides/provider-and-model-extension.md)

## i18n 约定

- 入口：`src/i18n/index.ts`
- 语言包：`src/i18n/locales/zh.json`、`src/i18n/locales/en.json`
- 代码中使用 `useTranslation()` + `t('key.path')`，避免硬编码文案

## 开发文档导航

- [项目开发环境与注意事项](./docs/development-guides/project-development-setup.md)
- [供应商与模型扩展指南](./docs/development-guides/provider-and-model-extension.md)
- [基础工具安装配置（Windows / macOS）](./docs/development-guides/base-tools-installation.md)
