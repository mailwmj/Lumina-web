# TOS 媒体存储配置

Seedance 的图片、视频和音频输入会由 Tauri/Rust 上传到私有 TOS Bucket，并生成短期 GET 预签名 URL。预签名 URL 只用于当前模型请求，不写入节点或项目持久化数据。

## 本地开发配置

在启动 Tauri 进程的环境中配置以下变量：

```text
LUMINA_TOS_BUCKET=your-private-bucket
LUMINA_TOS_REGION=cn-beijing
LUMINA_TOS_ENDPOINT=https://tos-cn-beijing.volces.com
LUMINA_TOS_ACCESS_KEY=...
LUMINA_TOS_SECRET_KEY=...
LUMINA_TOS_SECURITY_TOKEN=...       # 使用 STS 时填写
LUMINA_TOS_URL_TTL_SECONDS=3600
```

`LUMINA_TOS_ACCESS_KEY` 和 `LUMINA_TOS_SECRET_KEY` 只在 Rust 后端读取。不要把它们放入前端 bundle、localStorage、项目 JSON、节点数据或日志。

## 打包到安装包

若需要让同事安装后无需配置本机环境变量，可在**构建安装包的机器**上设置下列变量后执行 `npm run tauri build`。构建脚本会把它们写入 Rust 二进制，安装包运行时优先使用这些值：

```text
LUMINA_EMBEDDED_TOS_BUCKET=your-private-bucket
LUMINA_EMBEDDED_TOS_REGION=cn-beijing
LUMINA_EMBEDDED_TOS_ENDPOINT=https://tos-cn-beijing.volces.com
LUMINA_EMBEDDED_TOS_ACCESS_KEY=...
LUMINA_EMBEDDED_TOS_SECRET_KEY=...
LUMINA_EMBEDDED_TOS_URL_TTL_SECONDS=3600
```

`LUMINA_EMBEDDED_TOS_BUCKET`、`LUMINA_EMBEDDED_TOS_ACCESS_KEY`、`LUMINA_EMBEDDED_TOS_SECRET_KEY` 必须同时设置。`LUMINA_TOS_SECURITY_TOKEN` 是会过期的 STS 令牌，不支持嵌入安装包。

打包凭证会被写入应用二进制，可被拥有安装包的人提取。该模式只适用于你接受该风险且能随时轮换、吊销此 IAM 凭证的受控分发场景；不要将构建命令、环境变量导出或 CI 日志分享给他人。

PowerShell 构建示例（在自己的构建机填写值，不要提交脚本或密钥文件）：

```powershell
$env:LUMINA_EMBEDDED_TOS_BUCKET = "your-private-bucket"
$env:LUMINA_EMBEDDED_TOS_REGION = "cn-beijing"
$env:LUMINA_EMBEDDED_TOS_ENDPOINT = "https://tos-cn-beijing.volces.com"
$env:LUMINA_EMBEDDED_TOS_ACCESS_KEY = "..."
$env:LUMINA_EMBEDDED_TOS_SECRET_KEY = "..."
npm run tauri build
```

## GitHub Actions 发布安装包

当前 `.github/workflows/build.yml` 只在推送 `v*` tag 或手动运行 workflow 时发布 Release；普通 commit push 不会生成 GitHub Release。

在仓库的 `Settings -> Secrets and variables -> Actions` 中配置：

Variables：

```text
LUMINA_TOS_BUCKET=luminanative
LUMINA_TOS_REGION=cn-beijing
LUMINA_TOS_ENDPOINT=https://tos-cn-beijing.volces.com
LUMINA_TOS_URL_TTL_SECONDS=3600
```

Secrets：

```text
LUMINA_TOS_ACCESS_KEY=<TOS IAM AccessKey ID>
LUMINA_TOS_SECRET_KEY=<TOS IAM Secret AccessKey>
```

Windows 和 macOS 构建任务会把这些值映射为 `LUMINA_EMBEDDED_TOS_*`，并在构建前校验必需凭证；凭证缺失时不会生成不完整的安装包。

发布方式二选一：

```bash
# 方式一：推送 tag，自动构建并创建 Release
git push origin main
git tag -a v0.2.29 -m "Release v0.2.29"
git push origin v0.2.29
```

或在 GitHub Actions 页面手动运行 `Build Lumina`，填写 `release_tag`（例如 `v0.2.29`）和可选的 `release_notes`。工作流完成后，Windows `.exe` 和 macOS `.dmg` 会挂到对应 GitHub Release。

可在正式打包前执行只读连通性测试。该测试只调用 `HeadBucket`，不会上传、删除或列举对象：

```powershell
cd src-tauri
cargo test checks_live_tos_bucket_connection --lib -- --ignored --nocapture
```

若 IAM 策略未授予 `tos:HeadBucket`，可改用端到端验证；它会写入、读取并删除一个 `lumina/diagnostics/` 下的临时文本对象，因此还需要 `tos:DeleteObject`：

```powershell
cargo test checks_live_tos_upload_and_presigned_read --lib -- --ignored --nocapture
```

## 运行策略

- Bucket 保持私有，不使用公开读 ACL。
- 对象写入 `lumina/{project}/staging/{uuid}/input.{ext}` 前缀。
- 远程 URL 会逐跳校验，解析到 localhost、私网、链路本地或元数据地址时拒绝。
- staging 对象应在 TOS 侧配置生命周期规则自动清理。
- 默认建议使用短期 STS 凭证；若选择嵌入永久 AK/SK 分发，需以受控分发、最小权限和可随时轮换为前提。

## 相关命令

- `upload_media_to_tos`：上传并生成短期 GET URL。
- `persist_media_bytes_to_project`：将没有本地路径的浏览器拖拽媒体先写入项目 `uploads/`。
