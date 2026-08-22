# GitHub Actions 安装包发布

GitHub Actions 的 `Build Lumina Web and installers` workflow 只接受版本 tag 或显式指定已存在 tag 的 `workflow_dispatch`。它在同一 tag commit 上构建 Web、GenerationGateway、Canvas Agent、本机 runtime 和安装器，并创建明确标记为 **unsigned beta** 的 GitHub prerelease。

当前 beta 发布三个原生安装包：Windows x64、macOS x64 和 macOS arm64。每个包都附带 SHA-256、unsigned beta 验证输出，以及绑定 tag、commit、版本、平台和架构的 metadata。不支持 Windows on Arm。

这是可安装的测试版本，不是签名或公证的正式版本。workflow 不读取证书、私钥、notary profile 或 `release-signing` Environment；`package:installer:prepare` 仍只生成 staging，只有 `package:installer:unsigned` 才构建可上传的 unsigned beta 安装包。

## 普通用户

从 GitHub 的 **Pre-release** 下载与电脑匹配的 Lumina 安装包和同名 `.sha256`：

- Windows x64 适用于大多数 Intel/AMD Windows 电脑。
- macOS x64 适用于 Intel Mac。
- macOS arm64 适用于 Apple silicon Mac。

Windows 双击 `.exe`，macOS 双击 `.pkg` 并按安装器提示完成安装。正常安装不需要 Node.js、npm、Git、终端或源码 checkout。

Windows 的 unsigned 安装器可能被 SmartScreen 或 Defender 显示“未知发布者”警告。只在确认 GitHub prerelease 的 tag、SHA-256 和 metadata 后继续安装。macOS 的 unsigned `.pkg` 没有 Developer ID 签名或 Apple notarization，Gatekeeper 会阻止普通双击安装；仅在受信任的测试机器上由知情用户按组织的 Gatekeeper 例外流程安装。不要把这些绕过步骤用于未知来源的软件。

安装会注册 `lumina://open` 并放置书签。点击协议链接或书签时，隐藏本机 runtime 会启动或复用，然后在已登记的 Chrome Origin 打开 Lumina；安装器本身不会弹出独立画布窗口。更新、Repair、重装和普通卸载不会复制或清除 Chrome IndexedDB、项目、资产、设置或凭据。若 Chrome 的已登记 Origin 被占用，按安装器提示 Repair，不要改用另一个端口。

Chrome 是项目、历史、资产、设置和提供商凭据的唯一事实源。继续使用已有 Lumina 项目的同一 Chrome Profile。Codex 中的“打开 Lumina”通过安装的本地 plugin 连接同一已登记 Origin；先让 Codex 连接该 Chrome Profile。打开或连接不会获得写入或生图权限，任何写入、导入和运行仍需要画布中的明确授权。

## Runner 合同

每个矩阵条目在开始打包前同时检查 Node 的实际 `process.platform` 与 `process.arch`，错配立即失败。workflow 不会跨架构伪造 native runtime。

| 目标 | runner | 额外合同 |
| --- | --- | --- |
| Windows x64 | GitHub-hosted `windows-latest` | workflow 安装 Inno Setup，并要求 `ISCC.exe` 可用。 |
| macOS x64 | GitHub-hosted `macos-13` | 必须原生提供 `pkgbuild` 和 `productbuild`。 |
| macOS arm64 | GitHub-hosted `macos-14` | 必须原生提供 `pkgbuild` 和 `productbuild`。 |

若 GitHub-hosted runner 的可用架构发生变化，原生架构检查会失败，Release 不会创建。恢复该目标前，维护者必须配置具有相同原生工具链的受控 runner，并更新矩阵和本文档；不能把未运行的架构标为成功。

## Tag 发布流程

1. 在受保护分支完成变更与完整验证。`package.json` 版本和 annotated tag 必须严格匹配，例如版本 `0.2.33` 对应 `v0.2.33`。
2. 在 Windows x64、macOS x64 和 macOS arm64 的真实目标机器上完成知情安装、`lumina://open`、书签、Chrome/Codex 双入口的 beta 验证。记录实际包的 SHA-256、runner 和安装结果；不要在记录中写入 API key、浏览器凭据、项目资产或完整提示词。
3. 创建并推送 annotated tag，或在 Actions 的 `workflow_dispatch` 输入该已存在 tag。所有 jobs checkout 同一个 tag commit；Release job 再次验证三份 artifact 的 tag、commit、SHA-256、目标矩阵和非空 unsigned beta 验证结果。
4. Actions 先运行 Web gate 和 `verify:local-release -- --channel beta`，然后在三个原生 runner 上打包。任一 runner、构建、哈希、metadata 或 beta gate 失败都会阻止 GitHub Release。

Actions artifacts 可用于诊断失败的候选，但不表示已发布。只有所有 jobs 成功且 GitHub prerelease 附带三组 installer、SHA-256、验证输出和 metadata 后，才是本策略下可分发的 unsigned beta。
