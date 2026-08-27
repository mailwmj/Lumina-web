# GitHub Actions 安装包发布

GitHub Actions 的 `Build Lumina Web and installers` workflow 只接受版本 tag 或显式指定已存在 tag 的 `workflow_dispatch`。它在相同 tag commit 上构建 Web、GenerationGateway、Canvas Agent、本机 runtime、Lumina-owned Codex plugin bundle 和安装器。默认的 signed 模式只发布两个已签名并验证的安装包（Windows x64、macOS arm64）、各自 SHA-256、签名/公证验证输出和 tag/commit 元数据。

小规模内部测试可以在 `workflow_dispatch` 中选择 `release_mode: unsigned`。该模式会生成并上传 Actions artifact，并可按明确标记创建 GitHub Release；产物和 Release 说明都会标记为 unsigned test artifact、未签名且未公证，仅用于受控测试。

`npm run package:installer:prepare` 仍然只是目标平台上的 staging，不会被 Actions 上传。

## 普通用户

从 GitHub Release 下载与电脑匹配的 Lumina 安装包和同名 `.sha256`：

- Windows 的 `x64` 适用于大多数 Intel/AMD 电脑。
- 当前不打包 Windows arm64 和 Intel macOS；macOS 测试包仅提供 `arm64`，适用于 Apple silicon Mac。

Windows 双击 `.exe`，macOS 双击 `.pkg` 并按安装器提示完成安装。安装包内含 Lumina 自有的 `Lumina-Codex-Plugin` bundle，但安装器不会修改 Codex 的配置或安装目录；用户仍须在 Codex 官方支持的本地 plugin/marketplace 导入界面中明确选择该 bundle，由 Codex 管理自己的副本。仓库不提供未经验证的 Codex 命令或固定路径。正常 Lumina 桌面安装不需要 Node.js；当前 Codex plugin 的 MCP host 通过 `node` 启动 launcher，因此启用 plugin 还需要 Codex 环境提供 Node.js >=18。unsigned Release 虽然可以作为 GitHub Release 下载，但不是代码签名或公证的普通用户正式版本；安装系统可能显示安全警告。

安装会注册 `lumina://open` 并放置书签。点击协议链接或书签时，隐藏本机 runtime 会启动或复用，然后请求系统默认浏览器在已登记的本地入口打开 Lumina；安装器本身不会弹出独立画布窗口。项目快照、历史和资产连续性由应用 payload 外的 Runtime managed library 保证，不依赖浏览器 Profile。更新、Repair、重装和普通卸载必须复用 Windows `%LOCALAPPDATA%\Lumina\library` 或 macOS `~/Library/Application Support/Lumina/library`；若已登记 Origin 被占用，按安装器提示 Repair，不要改用另一个端口。

浏览器 IndexedDB 只持有独立 settings，不是项目 fallback、迁移源或 dual writer。`canvas_open` 的 Codex 正式路径是在 Codex 内置浏览器中打开返回 URL；connected Chrome 不是插件回退路径。OS-default 协议/书签入口可以证明 Runtime 启动，但不能替代插件在 Codex 内置浏览器中的打开、握手、断线、重连和 project revision 验收。Codex 中的“打开 Lumina”通过用户在 Codex 官方界面导入后安装的 plugin 连接 Runtime；Lumina 安装器只提供 Lumina-owned bundle，不负责注册、更新或卸载 Codex 副本。打开或连接不会获得写入或生图权限，任何写入、导入和运行仍需要画布中的明确授权。

## 发布管理员初始配置

在 GitHub repository 的 `release-signing` Environment 配置 protection rules，并仅授予批准发布的维护者访问。以下值只创建为 Actions secrets 或 Environment secrets，绝不写入 repository、Release notes、人工证据或 workflow log：

| 目标 | 必需 secrets | 用途 |
| --- | --- | --- |
| Windows | `LUMINA_WINDOWS_CERTIFICATE_BASE64`, `LUMINA_WINDOWS_CERTIFICATE_PASSWORD`, `LUMINA_WINDOWS_CERT_SHA1`, `LUMINA_WINDOWS_TIMESTAMP_URL` | Base64 PFX 临时导入 CurrentUser store；workflow 比对 thumbprint，再由 `signtool` 以 SHA-256 签 runtime 和 Inno 安装器。 |
| macOS | `LUMINA_MACOS_APP_CERTIFICATE_BASE64`, `LUMINA_MACOS_APP_CERTIFICATE_PASSWORD`, `LUMINA_MACOS_APP_SIGN_IDENTITY` | 临时 keychain 中签名 `Lumina.app` 与 runtime。 |
| macOS | `LUMINA_MACOS_INSTALLER_CERTIFICATE_BASE64`, `LUMINA_MACOS_INSTALLER_CERTIFICATE_PASSWORD`, `LUMINA_MACOS_INSTALLER_SIGN_IDENTITY` | 签名 `productbuild` 输出。 |
| macOS | `LUMINA_MACOS_NOTARY_KEY_BASE64`, `LUMINA_MACOS_NOTARY_KEY_ID`, `LUMINA_MACOS_NOTARY_ISSUER`, `LUMINA_MACOS_NOTARY_PROFILE`, `LUMINA_MACOS_KEYCHAIN_PASSWORD` | 创建短生命周期 notarytool profile，提交、公证和 stapler 验证。 |

PFX 与 `.p12` 内容必须先在受控环境以 Base64 编码；不要提交证书文件或私钥。Windows 证书 thumbprint 使用 signtool 所需的 SHA-1 lookup 值，但签名摘要始终由 `signtool /fd SHA256 /td SHA256` 固定为 SHA-256。时间戳 URL 也按 secret 管理，避免在 workflow 定义中固化供应商策略。

## Runner 合同

每个矩阵条目在开始打包前同时检查 Node 的实际 `process.platform` 与 `process.arch`，错配立即失败。workflow 不会跨架构伪造原生 runtime。

| 目标 | runner | 额外合同 |
| --- | --- | --- |
| Windows x64 | GitHub-hosted `windows-latest` | workflow 安装 Inno Setup；signed 模式还要求 `signtool.exe` 可用。 |
| macOS arm64 | GitHub-hosted `macos-14` | 必须保有 Xcode 的 codesign、pkgbuild、productbuild、notarytool 和 stapler。 |

若 GitHub-hosted runner 的可用架构发生变化，不要改写矩阵来假装成功。先新增具备相同原生工具链的受控 self-hosted runner label，并在此表、workflow 矩阵和 `lumina-release` Environment policy 中同步记录；缺少 runner 会使 Release 无法开始。

## Tag 发布流程

1. 在受保护分支完成变更与完整验证。`package.json` 版本和 tag 必须严格匹配，例如版本 `0.2.33` 对应 `v0.2.33`。
2. 在 Windows x64 和 macOS arm64 真实平台以签名候选包完成干净安装、升级/Repair/重装/卸载，以及手动浏览器协议入口和 Codex 内置浏览器插件入口的人工记录。将无敏感信息的 capture、实际 SHA-256、签名者和 macOS 公证结果按 [local release acceptance](./local-release-acceptance.md) 写入 evidence manifest。
3. 创建并推送 annotated tag，或在 Actions 的 `workflow_dispatch` 输入该已存在 tag。所有 jobs checkout 同一个 tag commit，Release job 还会再次验证两个 artifact 的 tag、commit、SHA-256 和非空验证输出。
4. Actions 默认先运行 Web gate 和 `verify:local-release -- --channel beta`，然后在两个原生 runner 上签名、公证和验证。signed 正式 Release 还会执行 Web 与本地 `--channel complete`；任一 pending 人工证据、缺少 secrets、runner、签名或 notarization 都会在上传正式 signed Release 资产前失败。若只是小规模测试，可在 `workflow_dispatch` 选择 `release_mode: unsigned`；该路径跳过签名/公证，但现在也会创建一个明确标注 unsigned 的 GitHub Release。

Actions artifacts 可用于诊断失败的候选，但不表示已发布。只有全部 checks 成功且 GitHub Release 已附带两个 installer、SHA-256、验证输出和 metadata 后，才是可分发版本。
