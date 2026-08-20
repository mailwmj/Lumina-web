# Tauri macOS 与 Windows 打包及 GitHub Actions 调研

> 调研日期：2026-08-09  
> 仓库：OpenCanvas（当前工作区）  
> 外部资料范围：仅使用 Tauri、GitHub Actions、Apple、Microsoft 官方一手资料。  
> 变更范围：本次只新增本文档，不修改业务代码、Tauri 配置或 CI。

## 1. 结论

**事实**：当前仓库已经具备远程打包三类目标的主链路：Windows 使用 `windows-latest` + MSVC `amd64` 构建 NSIS x64 安装器；macOS 使用 `macos-latest`，安装 `aarch64-apple-darwin` 与 `x86_64-apple-darwin` 两个 Rust target，再构建 `universal-apple-darwin` Universal DMG。Tauri 官方 CLI 明确支持 Universal target，且要求两个 target 均已安装；Apple 官方定义的 Universal binary 同时包含 `arm64` 和 `x86_64` 代码，因此当前一个 macOS Universal DMG 同时覆盖 Apple Silicon 与 Intel。

**结论**：使用 GitHub Actions 远程打包是合适的，而且当前方案已接近可用。Windows x64 与 macOS Universal 的编译路径有官方支持；但当前 workflow 没有配置签名和公证，GitHub Release 产物不应视为面向公众的正式安装包。若目标是直接从 GitHub Releases 下载，优先补齐 macOS Developer ID 签名 + notarization，以及 Windows Authenticode 签名；若目标是 Mac App Store，还必须单独处理当前启用的 macOS private API。

**推荐交付形态**：先维持一个 Universal macOS DMG 和一个 Windows x64 NSIS `.exe`。只有在下载体积、架构级验收、Intel 专用签名/UDID 或分架构故障隔离成为实际需求时，才把 macOS workflow 拆成 `aarch64-apple-darwin` 与 `x86_64-apple-darwin` 两个 job/artifact。

## 2. 当前仓库事实

### 2.1 已读取的仓库文件

- `AGENTS.md`：要求研究先读实际状态、区分事实与推断、按数据流审查；打包相关改动需做验证，且不应把稳定技术约束与临时操作混在一起。
- `CONTEXT.md`：当前文档是画布 Agent 的领域上下文，与桌面打包没有额外约束。
- `package.json`：版本为 `0.2.2`；`build` 为 `tsc && vite build`；`tauri` script 映射到 Tauri CLI；没有专用的按平台打包 script。见 `package.json:4-12`。
- `package-lock.json`：锁定的 `@tauri-apps/cli` 为 `2.10.0`，锁定的 `@tauri-apps/api` 为 `2.10.1`。
- `src-tauri/tauri.conf.json`：启用 bundle，`targets` 为 `all`；配置了 Windows WiX/NSIS 语言和 macOS/Windows 图标；设置了 `app.macOSPrivateApi: true`。见 `src-tauri/tauri.conf.json:12-14`、`:46-67`。
- `src-tauri/Cargo.toml`：使用 Tauri 2，启用 `protocol-asset`、`devtools`、`macos-private-api`；Rust package 版本为 `0.2.2`。见 `src-tauri/Cargo.toml:1-16`。
- `src-tauri/Cargo.lock`：锁定 `tauri` 为 `2.10.2`、`tauri-build` 为 `2.5.5`。
- `.github/workflows/build.yml`：当前唯一 CI workflow，包含 Windows 构建、macOS 构建和 release job。

本次检查开始前工作区已有未提交的业务文件变更；本文档没有修改、暂存或覆盖这些变更。

### 2.2 当前 workflow 的产物路径

| 目标 | 当前 runner 与命令 | 当前产物处理 | 判断 |
| --- | --- | --- | --- |
| Windows x64 | `windows-latest`；`ilammy/msvc-dev-cmd@v1` 设置 `arch: amd64`；`npx tauri build` | 从 `src-tauri/target/release/bundle/nsis/*.exe` 取第一个 NSIS 安装器，重命名为 `Storyboard-Copilot_<version>_x64-setup.exe` 并上传 | **事实**：与 Windows x64 目标一致。`windows-latest` 的官方架构为 x64；Tauri 要求 Windows 使用 Microsoft C++ Build Tools/MSVC。 |
| macOS Universal | `macos-latest`；安装 `aarch64-apple-darwin,x86_64-apple-darwin`；`npx tauri build --target universal-apple-darwin` | 从 `src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg` 取 DMG，命名为 `Storyboard-Copilot_<version>_universal.dmg`；同时尝试上传 `.app` | **事实**：一个 Universal 产物覆盖 Apple Silicon 与 Intel；不是两个独立 DMG。 |
| GitHub Release | `needs: [build-windows, build-macos]`；`contents: write`；下载两个 artifact 后上传 `.exe` 与 `.dmg` | 使用 `softprops/action-gh-release@v1` 创建正式 Release | **事实**：release job 已有基本权限和跨 job artifact 传递；当前 Release 不包含 MSI，也不包含单独架构 DMG。 |

相关本地证据：`.github/workflows/build.yml:19-90`、`:92-170`、`:172-251`。

## 3. 官方事实与对本仓库的影响

### 3.1 macOS Intel / Apple Silicon

**事实 — Tauri**：Tauri CLI 的 `build --target` 接受 `universal-apple-darwin`；官方说明要求同时安装 `aarch64-apple-darwin` 与 `x86_64-apple-darwin`。官方 GitHub Actions 示例也用 macOS runner 分别构建 Apple Silicon 和 Intel target，并把两者放入同一矩阵。

> “compiling an universal macOS application requires both `aarch64-apple-darwin` and `x86_64-apple-darwin` targets to be installed.”

来源：[Tauri CLI reference](https://v2.tauri.app/reference/cli/#build)、[Tauri GitHub Actions pipeline](https://v2.tauri.app/distribute/pipelines/github/)。

**事实 — Apple**：Universal binary 内含两套架构代码；Apple Silicon 优先运行 `arm64`，Intel Mac 运行 `x86_64`。Apple 还要求在两种架构上测试行为和性能，而不是只验证能否生成文件。

> “A universal binary runs natively on both Apple silicon and Intel-based Mac computers.”

来源：[Apple：Porting your macOS apps to Apple silicon](https://developer.apple.com/documentation/apple-silicon/porting-your-macos-apps-to-apple-silicon)、[Apple：Building a universal macOS binary](https://developer.apple.com/documentation/Apple-Silicon/building-a-universal-macos-binary)。

**对本仓库的影响 — 推断**：当前 macOS job 的 target 安装和 Universal 命令与官方要求相符；因此从配置形态看，它已经覆盖 macOS Intel 与 Apple Silicon。它仍需在两种真实机器或等价验证环境中检查 Rust 依赖、原生库、图片处理路径和运行时行为。当前仓库没有发现 `externalBin` 或按架构声明的外部二进制；如以后增加这类依赖，必须为每个 target 提供对应文件。

**runner 事实**：截至本调研日，GitHub 官方 runner 参考表将 `macos-latest` 列为 arm64，将 `macos-15-intel`/`macos-26-intel` 列为 Intel；`windows-latest` 列为 x64。GitHub 同时提醒 `-latest` 会随最新稳定镜像迁移。

来源：[GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[GitHub Actions runner images](https://github.com/actions/runner-images)。

**对本仓库的影响 — 建议**：当前 Universal 构建在 arm64 `macos-latest` 上是可行方向，但生产构建应考虑固定 `macos-15`/`macos-15-intel` 等明确标签，或至少把 runner 镜像迁移纳入验收。需要 Intel 原生执行、固定 Intel UDID 或排查 Intel 专属问题时，增加 `macos-15-intel` job；这不是当前 Universal 编译的必需条件。

### 3.2 macOS 签名、公证与当前 private API

**事实 — Tauri/Apple**：macOS 直接下载分发需要代码签名；使用 Developer ID 分发时还需要 notarization。Apple 的公证流程要求有效代码签名、Developer ID 证书、Hardened Runtime 和安全时间戳。Tauri 默认 macOS `hardenedRuntime` 为 `true`，当前配置没有显式覆盖它，但应在正式发布验证结果。

来源：[Tauri macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)、[Apple：Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)、[Apple：Configuring the hardened runtime](https://developer.apple.com/documentation/xcode/configuring-the-hardened-runtime/)。

**当前缺口 — 事实**：`.github/workflows/build.yml` 没有 Apple 证书导入、签名身份、notary credentials 或公证步骤；`src-tauri/tauri.conf.json` 也没有 `bundle.macOS.signingIdentity`。因此当前 CI 生成的是编译/打包产物，不是已完成 Apple 发行信任链的产物。

**待补配置 — Tauri 官方支持的 CI 入口**：

- 签名侧：将导出的 `.p12` 证书安全放入 GitHub Secrets，并提供 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`；必要时显式设置 `APPLE_SIGNING_IDENTITY`。Tauri 示例还使用 `KEYCHAIN_PASSWORD` 创建临时 keychain。
- 公证侧：二选一使用 App Store Connect API 凭据（`APPLE_API_ISSUER`、`APPLE_API_KEY`、`APPLE_API_KEY_PATH`）或 Apple ID + app-specific password + Team ID（`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`）。
- 公证完成后保留 Tauri 的 stapling 流程；只有在明确需要异步首轮提交时才考虑 `--skip-stapling`。

来源：[Tauri macOS CI/CD signing](https://v2.tauri.app/distribute/sign/macos/)、[Tauri macOS notarization](https://v2.tauri.app/distribute/sign/macos/)、[GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

**`macOSPrivateApi` 的影响 — 事实 + 推断**：Tauri 文档说明 `macOSPrivateApi: true` 会启用透明背景 API 并设置全屏偏好；本仓库同时在 Rust 依赖中启用了 `macos-private-api`。这不等同于“不能生成 DMG”，但若未来提交 Mac App Store，Apple 的 App Review Guidelines 要求使用公开、文档化 API，因此当前设置是 App Store 路径的明确风险/待决策项。直接 GitHub 下载与 Mac App Store 应视为两条不同的发布配置，不应默认共用同一安全假设。

来源：[Tauri configuration reference](https://v2.tauri.app/reference/config/)、[Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)、[Apple distribution overview](https://developer.apple.com/documentation/technologyoverviews/distribution)。

### 3.3 Windows x64 与安装器

**事实 — Tauri/GitHub**：Tauri Windows 依赖 Microsoft C++ Build Tools 和 Edge WebView2；Rust 默认 host triple 应为 `x86_64-pc-windows-msvc`。Tauri Windows 安装器有两种主路径：WiX 生成 `.msi`，NSIS 生成 `-setup.exe`；MSI 只能在 Windows 上创建。GitHub 官方将 `windows-latest` 标为 x64。

> “Tauri applications for Windows are either distributed as Microsoft Installers (`.msi` files) ... or as setup executables (`-setup.exe` files) ...”

来源：[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)、[Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/)、[GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

**对本仓库的影响 — 事实**：当前 workflow 的 `windows-latest`、MSVC `amd64` 和 NSIS `.exe` 路径与 Windows x64 交付一致。`tauri.conf.json` 的 `targets: "all"` 表示 Tauri 可构建所有支持的 bundle target，其中包括 `msi`、`nsis`、`app`、`dmg` 等；但 workflow 只检查和上传 NSIS `.exe`，没有发布 MSI。由于 `targets: "all"` 还会触发 MSI 构建，Tauri 文档提示 Windows MSI 构建依赖 VBSCRIPT optional feature；当前 workflow 没有显式检查该 feature。

来源：[Tauri configuration reference](https://v2.tauri.app/reference/config/)、[Tauri Windows Installer prerequisites](https://v2.tauri.app/distribute/windows-installer/)。

**待决策**：

- 若产品只需要下载式安装器，NSIS `.exe` 已足够；可考虑把 `targets` 收窄为 `nsis`，避免无用 MSI 构建和 VBSCRIPT 依赖。
- 若要同时提供 MSI，保留 `targets: "all"` 或显式声明 `msi`/`nsis`，然后单独上传并发布 `src-tauri/target/release/bundle/msi/*.msi`；这属于 CI/发行物配置，不涉及业务代码。
- 当前 Windows workflow 没有配置签名证书。Tauri 指出未签名浏览器下载会触发 SmartScreen 警告；Microsoft 当前官方文档把 Azure Artifact Signing 列为非 Store 分发的推荐服务，并指出 OV/EV 不再应被当作自动绕过 SmartScreen 的保证。公开发布前应完成 Authenticode 签名、时间戳和安装验证。

来源：[Tauri Windows Code Signing](https://v2.tauri.app/distribute/sign/windows/)、[Microsoft：Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)。

**WebView2 的影响 — 事实**：当前配置没有写 `webviewInstallMode`，因此使用 Tauri 默认的 `downloadBootstrapper`；该模式安装包较小，但用户安装时需要联网。Tauri 还支持 `embedBootstrapper`、`offlineInstaller` 和 `fixedVersion`，后两者会显著增大安装包。若目标环境包含离线安装或受限网络，应把该选择写成明确配置并单独验收。

来源：[Tauri Windows Installer WebView2 options](https://v2.tauri.app/distribute/windows-installer/)。

### 3.4 GitHub Actions 远程打包是否适合

**事实**：GitHub-hosted runner 会为 job 提供新的 VM；官方 runner 表直接提供 Windows x64、macOS arm64 和 macOS Intel 标签。Tauri 官方 GitHub pipeline 直接给出 Windows x64、macOS x64 和 macOS Arm64 的构建矩阵。workflow artifact 可在不同 job 间上传和下载，且 GitHub 会在下载时验证 artifact digest。

> “This workflow will build and release your app for Windows x64 ... macOS x64 and macOS Arm64.”

来源：[Tauri GitHub pipeline](https://v2.tauri.app/distribute/pipelines/github/)、[GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[GitHub workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)。

**结论 — 推断**：对本仓库而言，GitHub Actions 是合适的远程打包平台：三个目标都有对应 hosted runner，Windows 不需要跨平台构建 MSI，macOS Universal 的两个 Rust target 可在一个 macOS job 中完成，现有 artifact/release 链路也已存在。远程打包的主要新增约束是证书与公证凭据管理、runner 镜像漂移和真实机器验收，而不是 Tauri 业务架构改造。

**安全边界 — 事实**：Apple `.p12`、notary 凭据、Windows `.pfx`/密码只能存为 GitHub Secrets 或更合适的受保护环境凭据；GitHub 文档说明 fork 触发的 workflow 不会获得除 `GITHUB_TOKEN` 之外的 secrets。签名 job 不应对任意 PR 运行，建议只允许受保护的 tag/release 或手动发布环境执行。

来源：[GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)、[GitHub self-hosted runner security](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners?learn=hosting_your_own_runners)。

## 4. 待补配置清单

| 优先级 | 项目 | 当前状态 | 对本仓库的影响 | 建议 |
| --- | --- | --- | --- | --- |
| P0 | macOS Developer ID 签名 | 未发现证书导入、`APPLE_CERTIFICATE` 或 `signingIdentity` | GitHub 下载的 DMG 不能直接视为公众友好的已验证发行物 | 选定 Developer ID Application 证书；在受保护环境导入 `.p12`，配置 Tauri 规定的 secrets，并验证 `.app` 与 DMG 签名 |
| P0 | macOS notarization | 未发现 API key/Apple ID 凭据或公证步骤 | macOS 直接分发缺少 Gatekeeper 信任闭环 | 接入 App Store Connect API 或 Apple ID app-specific password；完成 notarize + staple；在 Intel/Apple Silicon 各验收 |
| P0 | Windows 代码签名 | 未发现 `.pfx`、证书 thumbprint 或签名命令 | 浏览器下载可能出现 SmartScreen 警告 | 选择 Microsoft 推荐的非 Store 方案或可信 Authenticode CA；把证书、密码和时间戳配置放入受保护环境 |
| P1 | Windows 发行物选择 | `targets: "all"`，但只上传 NSIS `.exe` | 可能构建 MSI 却不发布，且引入 MSI/VBSCRIPT 失败面 | NSIS-only 就显式收窄 targets；需要 MSI 就显式上传、验收和发布 `.msi` |
| P1 | macOS runner 稳定性 | 使用会迁移的 `macos-latest` | Xcode/OS 镜像变更可能导致发行构建漂移 | 生产发布考虑固定 `macos-15`（arm64）和按需的 `macos-15-intel`；保留升级窗口 |
| P1 | `macOSPrivateApi` 发布策略 | 当前为 `true`，且 Rust feature 同步开启 | 直接下载与 Mac App Store 的合规前提不同 | 先明确只做 GitHub direct download 还是还要上 Store；若上 Store，单独评估移除 private API 的功能替代和平台配置 |
| P2 | WebView2 安装策略 | 隐含使用 Tauri 默认下载 bootstrapper | 离线/受限网络安装会失败或依赖额外网络 | 在线安装可保留并在发布说明说明；离线场景改为 `offlineInstaller` 或其他明确策略 |
| P2 | 双架构验收 | workflow 只上传 Universal DMG，没有自动架构检查 | 产物存在不等于两片都可运行 | 在发布 job 增加 `file`/`lipo -info`、签名、公证状态和两种架构启动验收；不把模拟器/单一机器结果当作完整验证 |

## 5. 推荐的后续 workflow 形态（本次未应用）

### 方案 A：继续构建 Universal macOS（推荐）

保留当前核心命令：

```text
rustup targets: aarch64-apple-darwin,x86_64-apple-darwin
tauri build --target universal-apple-darwin
```

优点是用户只需选择一个 macOS DMG，且两种 Mac 都运行原生 slice。后续只需补签名、公证、双架构验证和明确的 runner 版本策略。

### 方案 B：拆分两个 macOS 产物

使用两个矩阵项：

```text
macos arm64:  tauri build --target aarch64-apple-darwin
macos Intel:  tauri build --target x86_64-apple-darwin
```

每个矩阵项使用独立 artifact 名称和文件名。需要 Intel 原生 runner 时使用 GitHub 官方的 `macos-15-intel`；否则 Tauri 官方示例已经证明可在 `macos-latest` 上按 target 构建。该方案应在确定下载体积或架构隔离收益后再采用。

### Windows

继续使用 `windows-latest` x64 runner 和 MSVC。若只交付 NSIS，建议把构建目标与上传路径对齐；若同时交付 MSI，应把 MSI 作为明确的一等产物，而不是依赖 `targets: "all"` 后再忽略它。

## 6. 验证边界

- 已执行只读检查：读取仓库规范、配置、锁文件、CI、git status、近期提交与配置/CI 的 blame；确认当前 Tauri CLI 为 `2.10.0`，且 CLI help 接受 Universal target。
- 本次没有执行正式 `tauri build`，原因是任务是配置研究且工作区已有未提交业务改动；没有必要为了写文档覆盖或污染其构建产物。
- 本次只应验证新增 Markdown 的格式与 git diff；未来真正修改 workflow 或签名配置时，应按 `AGENTS.md` 执行至少 TypeScript 检查，并对 Tauri 打包做 Windows x64、macOS Intel、macOS Apple Silicon 的主路径与异常路径验收。

## 7. 来源索引（均为一手资料）

### Tauri

- [Tauri GitHub pipeline](https://v2.tauri.app/distribute/pipelines/github/)
- [Tauri CLI reference](https://v2.tauri.app/reference/cli/)
- [Tauri configuration reference](https://v2.tauri.app/reference/config/)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri Windows Code Signing](https://v2.tauri.app/distribute/sign/windows/)
- [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/)

### GitHub Actions

- [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub Actions runner images](https://github.com/actions/runner-images)
- [Store and share data with workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)
- [Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [Adding self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)

### Apple

- [Porting your macOS apps to Apple silicon](https://developer.apple.com/documentation/apple-silicon/porting-your-macos-apps-to-apple-silicon)
- [Building a universal macOS binary](https://developer.apple.com/documentation/Apple-Silicon/building-a-universal-macos-binary)
- [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Configuring the hardened runtime](https://developer.apple.com/documentation/xcode/configuring-the-hardened-runtime/)
- [Apple distribution overview](https://developer.apple.com/documentation/technologyoverviews/distribution)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

### Microsoft

- [Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Sign an MSIX package](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview)

