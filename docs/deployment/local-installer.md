# 本机安装发布

Lumina 的安装包部署已编译的本机运行时、静态 Web 资源和 Lumina 自有的 Codex plugin bundle。普通用户安装桌面应用不需要 Node.js、npm、Git、终端或源码 checkout；当前安装后的运行时提供入口、Gateway、bridge 和 Runtime 项目服务。Codex plugin 的 MCP host 当前由 Codex 以 `node` 启动，因此启用 plugin 另需 Codex 环境提供 Node.js >=18。项目快照、历史、资产 metadata 和 bytes 由 Runtime 的受控文件项目库持有；浏览器 IndexedDB 只持有独立 settings。

> `--prepare` 只生成未签名 staging，不能作为发布物。`--release` 会在缺少平台签名或公证前置条件时失败，不会生成或宣称已经签名的发布物。

## 先生成计划

`--plan` 不生成二进制，适合在任意开发机审查 Windows/macOS 目标和原生发布要求：

```powershell
npm run package:installer:plan -- --platform win32 --arch x64 --out release
npm run package:installer:plan -- --platform darwin --arch arm64 --out release
```

## 准备原生 staging

`--prepare` 先构建生产 Web 和 canvas bridge，再用目标平台本机 Node 生成 SEA runtime 并写入 installer staging。它只能在目标平台和目标 CPU 架构上运行：

```powershell
npm run package:installer:prepare -- --platform win32 --arch x64 --out release
```

Windows staging 包含 `LuminaRuntime`、`LuminaProtocol.vbs`、静态 Web 资源、版本元数据、Lumina-owned `Lumina-Codex-Plugin`（含 `.codex-plugin/plugin.json`、`.mcp.json`、README、launcher 和 skills）以及不含端口的 `lumina://open` 书签。macOS staging 将同一 plugin bundle 放在 `Lumina.app/Contents/Resources/Lumina-Codex-Plugin`。两者都不包含 Git checkout、`node_modules`、用户的 Runtime 项目库、浏览器 settings、偏好或凭据库。

## 生成可发布安装包

发布命令会重新构建 staging，再执行原生签名和安装器工具：

```powershell
npm run package:installer -- --platform win32 --arch x64 --out release
```

| 平台 | 原生前置条件 | 必需环境变量 | 发布结果 |
| --- | --- | --- | --- |
| Windows | 匹配目标架构的 Windows、`ISCC.exe`、`signtool.exe` | `LUMINA_WINDOWS_CERT_SHA1`；可选 `LUMINA_WINDOWS_TIMESTAMP_URL` | 先签 runtime，再构建并签安装器 |
| macOS | 匹配目标架构的 macOS、`codesign`、`pkgbuild`、`productbuild`、`xcrun notarytool` | `LUMINA_MACOS_APP_SIGN_IDENTITY`、`LUMINA_MACOS_INSTALLER_SIGN_IDENTITY`、`LUMINA_MACOS_NOTARY_PROFILE` | 签 app、构建安装包、提交公证并 stapler |

未在对应平台执行过 `--release`、未验证签名链或未完成 macOS 公证时，不能把 `--prepare` 输出称为已签名发布物。

## 安装和打开行为

- Windows 安装器注册当前用户的 `lumina://open`，书签通过隐藏的 Windows Script Host 启动 runtime，不显示终端或独立画布窗口。
- Windows 用户可以在安装时选择任意目录。安装完成后，安装器把实际 `LuminaRuntime.exe` 路径写入 `%APPDATA%\Lumina\runtime\runtime-location.txt`。
- macOS 安装器通过 `Lumina.app` URL 类型注册 `lumina://open`，并在安装后刷新 LaunchServices；运行时 app 是无 Dock 的后台 helper。用户选择其他目标卷时，安装器把该卷上的实际 runtime 路径写入系统级安装器 locator `/Library/Application Support/Lumina/runtime/runtime-location.txt`。
- Codex plugin 的 bundle 随 Lumina 安装在 Lumina 自有 payload 中；安装器不会扫描、写入或猜测 Codex 的安装目录。用户应在 Codex 官方支持的本地 plugin/marketplace 导入界面中选择该 bundle，让 Codex 复制并管理自己的 plugin；bundle 自带 README，逐项说明桌面安装、Codex 导入、Node.js >=18 和 Codex 内置浏览器，仓库不提供未经验证的命令或固定 Codex 路径。
- Codex plugin 优先使用 `LUMINA_RUNTIME_PATH` 开发覆盖，其次读取安装器登记，最后才兼容旧版默认目录。登记存在但路径无效、runtime 缺失或版本不兼容时要求 Repair，不扫描磁盘，也不静默连接另一套安装。plugin 更新或 Lumina 升级后，如 Codex 管理的是旧副本，应在 Codex 的官方界面重新导入新 bundle。
- 安装器不会启动 runtime。协议或书签被点击后，启动器才启动或复用本机 runtime，并在 runtime 就绪后交给系统默认浏览器打开已登记 Origin，作为手动外部入口。Codex 正式交互由插件在 Codex 内置浏览器中打开 `canvas_open` 返回的 URL；connected Chrome 不是插件回退路径。项目连续性由 Runtime 项目库保证，不依赖浏览器 Profile。
- 首次端口冲突由 #34 的候选端口选择处理；已登记端口被无关进程占用时，启动器显示修复提示，绝不会换 Origin。
- 安装时协议注册失败、运行时首次启动失败或已登记端口冲突都会显示用户可理解的修复结果。`LUMINA_RUNTIME_DIAGNOSTICS=1` 仅供发布工程诊断启动堆栈，普通安装路径不会启用它。

当前升级、修复安装和重装的数据保留策略保留应用 payload 外的 Runtime 项目库与安装身份元数据；本安装器范围不删除或复制 Runtime 项目库、浏览器 settings 或凭据。

## 升级、修复与重装

安装身份元数据位于应用 payload 外：Windows 是 `%APPDATA%\Lumina\runtime`，macOS 是
`~/Library/Application Support/Lumina/runtime`。它只保留 installation ID、已登记的 Origin、端口、
`lumina://open` 入口、bridge 协议合约，以及用于定位的项目库 ID/root reference。macOS 系统级
`runtime-location.txt` 只是安装器 locator，不属于这些用户级身份元数据，也不是项目库路径。升级、修复安装和
保留用户数据的重装都复用身份元数据。项目库使用 Windows `%LOCALAPPDATA%\Lumina\library` / macOS
`~/Library/Application Support/Lumina/library` 这个独立用户级根目录；安装、升级和 Repair 不把它放入应用 payload，也不接受调用方传入任意 `root`。浏览器 settings 仍按其独立 Profile/Origin 保存，不能被描述为 Runtime 项目事实或项目恢复来源。

每个安装 payload 的 `runtime-version.json` 记录 runtime 版本及实际构建的 bridge 协议。
如果新启动器发现已运行的服务处在不同的 runtime 兼容线，或 bridge 的 protocol major/build
不兼容，它会要求关闭服务后重新打开或执行 Repair；它不会连接不兼容 bridge，也不会改选新端口。
浏览器 bridge 在连接时继续对 protocol major/build fail closed。

升级、Repair 和保留数据的重装会先停止同一安装目录下正在运行的隐藏 runtime，再替换 payload：
Windows staging 使用安装器的应用关闭策略，macOS staging 使用受限于 Lumina runtime 路径的 preinstall
检查。无法停止旧 runtime 时，安装应失败并要求用户关闭后重试，而不是改写已登记 Origin 或中断 Runtime 项目库连续性。
安装成功后会刷新 runtime 路径登记，因此从一个安装目录迁移到另一个目录不要求用户配置 Codex 环境变量。

普通更新、修复、重装和卸载都不会删除 Runtime 项目库、Chrome 的 Lumina settings 或凭据，也不会修改 Codex 自己管理的 plugin 副本；如果用户在 Codex 中保留了指向已卸载 bundle 的引用，Codex 应按其官方界面移除该引用。删除全部 Lumina 数据必须是与普通安装生命周期分离的明确用户操作；当前安装器不提供该动作。

## 验证

```powershell
npm run test:installer
npm run test:local-runtime
npm run package:installer:plan -- --platform darwin --arch arm64 --out release
```

在每个目标平台的签名发布前，还要运行该平台的 `--prepare` 和 `--release`，再从干净账户执行安装、协议入口、建项目、重启恢复、Repair 数据复用和插件连接验证。系统默认浏览器的协议/书签观察不能替代 Codex plugin 在 Codex 内置浏览器中的打开、握手、断线、重连和 project revision 证据。
