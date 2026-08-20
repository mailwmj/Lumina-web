# Tauri 跨平台打包调研

日期：2026-08-09

## 结论

当前项目可以通过 GitHub Actions 远程打包：Windows x64 和 macOS universal（同时包含 Intel 与 Apple Silicon）。仓库已经有对应的 workflow，主要缺口不是编译能力，而是发布级签名、公证和产物覆盖范围。

## 仓库现状（Fact）

- `.github/workflows/build.yml` 已有 `windows-latest` job，并通过 MSVC `amd64` 构建 Windows x64 NSIS 安装包。
- 同一 workflow 已有 `macos-latest` job，安装 `aarch64-apple-darwin` 与 `x86_64-apple-darwin` Rust targets，并运行 `tauri build --target universal-apple-darwin`。
- `src-tauri/tauri.conf.json` 已启用 bundle，并配置了 NSIS、WiX、DMG 所需的图标；`targets: "all"` 会让 Windows 同时尝试生成 MSI 和 NSIS。
- 当前 release job 只把 `.exe` 与 `.dmg` 上传到 GitHub Release；macOS `.app` 仅作为 workflow artifact 上传，MSI 没有被上传。
- workflow 当前没有配置 Apple Developer ID 签名、公证或 Windows 代码签名 secrets。

## 官方规则（Fact）

- Tauri CLI 的 `build --target` 支持 `universal-apple-darwin`，并要求同时安装 `aarch64-apple-darwin` 与 `x86_64-apple-darwin` targets。
- Tauri 的 Windows 安装器支持 WiX 生成 MSI 和 NSIS 生成 `-setup.exe`；MSI 只能在 Windows 上生成。Tauri 官方建议优先用 Windows runner/CI 进行 Windows 构建。
- GitHub-hosted runners 提供 Windows x64（`windows-latest`）和 macOS Intel/arm64 runner；当前 workflow 使用的 `macos-latest` 是 arm64 runner，但它可以安装两个 Rust target 生成 universal app。
- macOS 从浏览器下载分发时需要代码签名以避免不受信任/损坏提示；面向用户的 Developer ID 分发还应进行 Apple notarization。Tauri 支持通过 CI secrets 导入 `.p12` 证书并完成签名/公证。
- Tauri 官方 `tauri-action` 可以在 GitHub Actions 中构建 macOS、Linux、Windows 并上传到 GitHub Release；当前仓库的手写 workflow 已能完成同样的核心流程，因此不必为了远程打包强行替换。

## 建议的收尾顺序（Inference）

1. 先用现有 workflow 手动 `workflow_dispatch` 验证无签名构建，确认 macOS universal DMG 和 Windows x64 NSIS 都能生成。
2. 决定 Windows 发布格式：只发 NSIS `.exe`，或同时将 MSI 纳入 artifact/release。
3. 面向普通用户发布时，在 GitHub Environments/Secrets 中配置 Apple Developer ID 签名、公证凭据和 Windows 代码签名凭据。
4. 在至少一台 Intel Mac、Apple Silicon Mac 和 Windows x64 机器上安装并运行一次，重点验证文件选择、剪贴板、SQLite 数据目录和 AI 请求等平台相关路径。

## 来源

- Tauri CLI：<https://v2.tauri.app/reference/cli/>
- Tauri Windows Installer：<https://v2.tauri.app/distribute/windows-installer/>
- Tauri macOS Code Signing：<https://v2.tauri.app/distribute/sign/macos/>
- Tauri GitHub Action：<https://github.com/tauri-apps/tauri-action>
- GitHub-hosted runners：<https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
- Apple macOS notarization：<https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>
