# 本地 Lumina 发布验收（Issue #39）

本门禁验证已安装的本地 Lumina 运行时、Chrome 和 Codex 的发布路径。浏览器在注册 Origin 的 Chrome Profile 中仍是项目、历史、资产和凭据的唯一事实源；安装器、运行时和插件不得复制这些数据。

## 自动门禁

运行 `npm run verify:local-release -- --channel beta` 会执行 TypeScript、运行时、安装器、Gateway、Canvas Agent、插件、生产 Chrome E2E 和构建检查。它只证明可在当前环境中复跑的行为，不能替代签名安装包或真实桌面客户端的验收。

`npm run verify:local-release -- --channel complete` 只有在所有自动检查通过，且下列实际平台记录均已附上时才会成功：

| 场景 | 自动覆盖 | 真实发布证据 |
| --- | --- | --- |
| Windows clean install / first start / protocol entry | 运行时和安装器合同 | 签名 Inno 安装包、干净机器和 `lumina://open` 记录 |
| Windows upgrade / repair / reinstall / uninstall | Origin 元数据和打包合同 | 签名安装包升级、repair、重装和卸载记录 |
| macOS clean install / first start / protocol entry | 运行时和安装器合同 | 签名并公证的 pkg、干净机器和 `lumina://open` 记录 |
| macOS upgrade / repair / reinstall / uninstall | Origin 元数据和打包合同 | 签名并公证的 pkg 升级、repair、重装和卸载记录 |
| Chrome 与 Codex 双入口 | 同 Origin Chromium E2E、MCP 与插件合同 | 同一 Chrome Profile、同 Origin、同一项目库和 revision 的双向记录 |
| 显式授权与无重放恢复 | Canvas Agent、MCP、插件和运行时合同 | 打开/连接/重连只读；写入、导入、运行单独授权；断线、超时、token 轮换、stale revision、运行时重启和占用端口的实际记录 |
| 远程模型 | Gateway 和生产构建 | 已批准的远程供应商请求记录，明确 `usedLocalWeights: false` |

Windows 与 macOS 的每条平台路径都必须分别提交 `x64` 与 `arm64` 记录；任一架构缺失都会阻止 `complete`。

人工证据放在 `docs/deployment/evidence/`，并由 [local-release-acceptance-evidence.json](local-release-acceptance-evidence.json) 引用。每个已验证记录必须有 35 天内的 UTC 时间、发布版本、平台、覆盖场景，以及合同中逐项列出的观察结果；每项观察都需要非空截图、录屏或命令输出。双入口记录逐项验证 Chrome Profile、注册 Origin、项目库、双向编辑、revision、授权、每种无重放触发和每种修复诊断。平台安装记录还必须包含实际 `.exe` 或 `.pkg`、从该文件重新计算的 SHA-256，以及包含工具、命令、签名者和工件的签名验证结果；macOS 记录还必须包含公证验证工件。记录不得包含 API Key、token、浏览器凭据、完整提示词或项目资产。

当前清单全部为 `pending`。这不是已完成 Windows Inno/macOS pkg、签名、公证或干净机器验证的声明；在这些记录真实产生前，门禁只能给出 `BETA`，不得将本地发布路径称为 complete。
