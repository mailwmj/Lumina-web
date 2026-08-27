# Runtime-first 本地发布验收（Issue #39 v2）

本合同验证当前 Runtime-first 本地产品：已安装 Runtime 是项目快照、画布历史、资产 metadata 和 asset bytes 的唯一持久所有者；浏览器 IndexedDB 只保留独立 settings。Codex plugin 通过 Runtime 逻辑 API 使用同一项目库，不接触文件路径，也不创建第二套浏览器项目数据源。

## 自动门禁

`npm run verify:local-release -- --channel beta` 会执行：

- TypeScript 和生产 Web 构建；
- Runtime 项目服务、managed file library、生产重启恢复和 E2E 启动器测试；
- Windows/macOS 安装器合同；
- GenerationGateway；
- Canvas Agent、Codex plugin 及其启动诊断；
- 生产 Runtime Chromium 流程；
- GitHub installer 的 Windows x64 / macOS arm64 目标合同。

自动检查只证明源码和 staging 合同。它不能代替签名安装包、干净账户、真实 Codex Desktop 内置浏览器或平台 Repair 记录。

## Complete 门禁

`npm run verify:local-release -- --channel complete` 仅在全部自动检查通过，且以下三份证据均为 `verified` 时成功：

| 记录 | 必须证明 |
| --- | --- |
| `windows-x64-release-candidate` | 签名 `.exe` 的干净安装、健康检查、协议入口、建项目、重启恢复、升级/Repair/重装复用 `%LOCALAPPDATA%\Lumina\library`、插件导入和 MCP 启动、Node/Runtime/版本不兼容诊断、Codex 内置浏览器打开/握手/断线/重连和 project revision。 |
| `macos-arm64-release-candidate` | 签名并公证的 `.pkg` 完成同一流程，重点证明 `~/Library/Application Support/Lumina/library` 的选择与 Repair 后复用，以及 Codex 内置浏览器插件连接。 |
| `remote-provider-without-local-weights` | 经批准的远程供应商请求完成，且未加载本地模型权重。 |

Windows arm64 和 macOS x64 不在当前 GitHub installer 目标中，因此不伪造也不阻塞当前 complete 合同。若以后增加发布目标，必须先扩展 CI matrix 和本合同，再接受该平台证据。

## 插件与浏览器边界

- Lumina 桌面安装、Codex plugin 导入、Node.js >=18、Codex 内置浏览器是四个独立前置条件。
- 安装器不扫描、写入或猜测 Codex 配置目录。
- `canvas_open` 必须在 Codex 内置浏览器中打开 Runtime 注册 Origin；内置浏览器不可用时报告前置条件并停止，不得回退到 connected Chrome。
- Node 版本过低、Runtime 缺失、Runtime version metadata 无效、plugin/Runtime 兼容线不一致必须分别记录可读诊断。
- connected Chrome 不属于 Codex 插件正式入口；它可以作为手动外部入口，但不得被用来替代 Codex 内置浏览器验收或建立第二套项目库。

## 证据格式

人工证据位于 `docs/deployment/evidence/`，由 [local-release-acceptance-evidence.json](local-release-acceptance-evidence.json) 引用。每份记录必须：

- 使用 35 天内的 UTC 时间和实际发布版本；
- 完整、按顺序记录合同要求的每个 observation；
- 为每个 observation 提供非空截图、录屏或命令输出；
- 引用实际 `.exe` 或 `.pkg`，并由门禁重新计算 SHA-256；
- 包含签名工具、命令、签名者和验证工件；macOS 另含公证验证工件；
- 不包含 API key、token、浏览器凭据、完整提示词或项目资产。

当前三份人工记录均为 `pending`，所以 complete 必须失败并保持 beta。这不是已完成 Windows/macOS 真实安装或插件连接验收的声明。
