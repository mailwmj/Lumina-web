# GitHub Actions 安装包发布

GitHub Actions 的 `Build Lumina Web and installers` workflow 只接受版本 tag 或显式指定已存在 tag 的 `workflow_dispatch`。它在相同 tag commit 上构建 Web、GenerationGateway、Canvas Agent、本机 runtime、Lumina-owned Codex plugin bundle 和 macOS arm64 安装器。所有 GitHub 安装包均使用无签名模式发布，仅提供 macOS arm64，并附带 SHA-256、无签名状态、tag/commit 元数据和构建验证结果。

tag push 与 `workflow_dispatch` 走同一无签名路径，不需要 `release-signing` Environment、证书或公证 secrets。每个 GitHub Release 都会明确说明安装包未代码签名、未公证；其 SHA-256 仍可用于下载后完整性校验。

## 共享 TOS

`package-installer` 会从仓库 Secrets 读取 `LUMINA_TOS_ACCESS_KEY` 和
`LUMINA_TOS_SECRET_KEY`，并将它们编译到安装包内的本机 Runtime Gateway。
Bucket、地域和 Endpoint 已固定为 `luminanative`、`cn-beijing` 和
`https://tos-cn-beijing.volces.com`。凭证不会进入 Web 静态资源、Codex
plugin、项目数据或日志，因此新用户安装同一发布包后无需另行配置即可上传
视频参考图。更新凭证后必须重新构建并发布安装包；未配置这两个 Secrets 的
构建不会获得 TOS 能力。

`npm run package:installer:prepare` 仍然只是目标平台上的 staging，不会被 Actions 上传。

## 普通用户

从 GitHub Release 下载 macOS arm64 的 Lumina 安装包和同名 `.sha256`，适用于 Apple silicon Mac。

macOS 双击 `.pkg` 并按安装器提示完成安装。安装包内含 Lumina 自有的 `Lumina-Codex-Plugin` bundle，但安装器不会修改 Codex 的配置或安装目录；用户仍须在 Codex 官方支持的本地 plugin/marketplace 导入界面中明确选择该 bundle，由 Codex 管理自己的副本。仓库不提供未经验证的 Codex 命令或固定路径。正常 Lumina 桌面安装不需要 Node.js；当前 Codex plugin 的 MCP host 通过 `node` 启动 launcher，因此启用 plugin 还需要 Codex 环境提供 Node.js >=18。GitHub Release 安装包未代码签名、未公证，安装系统可能显示安全警告；安装前应校验随包提供的 SHA-256。

安装会注册 `lumina://open` 并放置书签。点击协议链接或书签时，隐藏本机 runtime 会启动或复用，然后请求系统默认浏览器在已登记的本地入口打开 Lumina；安装器本身不会弹出独立画布窗口。项目快照、历史和资产连续性由应用 payload 外的 Runtime managed library 保证，不依赖浏览器 Profile。更新、Repair、重装和普通卸载必须复用 Windows `%LOCALAPPDATA%\Lumina\library` 或 macOS `~/Library/Application Support/Lumina/library`；若已登记 Origin 被占用，按安装器提示 Repair，不要改用另一个端口。

浏览器 IndexedDB 只持有独立 settings，不是项目 fallback、迁移源或 dual writer。`canvas_open` 的 Codex 正式路径是在 Codex 内置浏览器中打开返回 URL；connected Chrome 不是插件回退路径。OS-default 协议/书签入口可以证明 Runtime 启动，但不能替代插件在 Codex 内置浏览器中的打开、握手、断线、重连和 project revision 验收。Codex 中的“打开 Lumina”通过用户在 Codex 官方界面导入后安装的 plugin 连接 Runtime；Lumina 安装器只提供 Lumina-owned bundle，不负责注册、更新或卸载 Codex 副本。打开或连接不会获得写入或生图权限，任何写入、导入和运行仍需要画布中的明确授权。

## Runner 合同

每个矩阵条目在开始打包前同时检查 Node 的实际 `process.platform` 与 `process.arch`，错配立即失败。workflow 不会跨架构伪造原生 runtime。

| 目标 | runner | 额外合同 |
| --- | --- | --- |
| macOS arm64 | GitHub-hosted `macos-14` | 必须保有 `pkgbuild` 和 `productbuild`。 |

若 GitHub-hosted runner 的可用架构发生变化，不要改写矩阵来假装成功。先新增具备相同原生工具链的受控 self-hosted runner label，并在此表和 workflow 矩阵中同步记录；缺少 runner 会使 Release 无法开始。

## Tag 发布流程

1. 在受保护分支完成变更与完整验证。`package.json` 版本和 tag 必须严格匹配，例如版本 `0.2.33` 对应 `v0.2.33`。
2. 在 macOS arm64 真实平台以无签名候选包完成干净安装、升级/Repair/重装/卸载，以及手动浏览器协议入口和 Codex 内置浏览器插件入口的人工记录。将无敏感信息的 capture 和实际 SHA-256 按 [local release acceptance](./local-release-acceptance.md) 写入 evidence manifest。
3. 创建并推送 annotated tag，或在 Actions 的 `workflow_dispatch` 输入该已存在 tag。所有 jobs checkout 同一个 tag commit，Release job 还会再次验证 macOS arm64 artifact 的 tag、commit、SHA-256 和非空验证输出。
4. Actions 运行 Web gate 和 `verify:local-release -- --channel beta`，然后在原生 macOS arm64 runner 上构建无签名安装包。无需预先配置签名、时间戳或公证 secrets；任一 runner、构建、SHA-256 或 tag/commit 校验失败都会阻止 GitHub Release 创建。

Actions artifacts 可用于诊断失败的候选，但不表示已发布。只有全部 checks 成功且 GitHub Release 已附带 macOS arm64 installer、SHA-256、验证输出和 metadata 后，才是可分发版本。
