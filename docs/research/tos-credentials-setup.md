# 火山引擎 TOS 桌面端接入：凭证与后台准备调研

调研日期：2026-08-18

调研范围：桌面端/客户端接入 TOS 所需的后台资源、AK/SK、STS 临时凭证、IAM 用户与角色、Bucket、Region、Endpoint、最小权限及预签名 URL。

来源范围：仅使用火山引擎官方文档和火山引擎官方 TOS SDK GitHub 仓库。未使用社区文章、第三方 SDK 文档或非官方教程。

## 结论

接入 TOS 不只是拿到一组 AK/SK。至少需要准备以下内容：

1. 火山引擎账号已完成实名认证，并开通 TOS。
2. 创建一个 TOS Bucket，确定 Region，建议保持私有权限。
3. 配置一个 IAM 身份和 TOS 对象权限。
4. 确定客户端使用长期 AK/SK、STS 临时凭证，还是预签名 URL。
5. 配置与 Bucket Region 匹配的 TOS Endpoint。

对于可分发的桌面客户端，官方建议不要把永久 AK/SK 放进客户端代码，应由服务端通过 STS 下发临时凭证。另一种更收敛的方案是由服务端生成指定对象、指定 HTTP 方法和指定有效期的预签名 URL，再让客户端直接上传或下载。[临时凭证最佳实践][sts-best-practice] [客户端使用 STS 访问 TOS][sts-client]

结合 Lumina 当前是 Tauri 桌面应用这一事实，推荐的生产链路是：

```text
桌面端 → 业务服务/凭证服务 → STS 临时凭证或预签名 URL
桌面端 → TOS 私有 Bucket 上传
业务服务 → 为模型请求生成短期 GET 预签名 URL
```

如果只是单用户本地开发，可以先使用 IAM 子账号的 AK/SK 接入 Tauri Rust 后端；这应被视为开发或受控环境方案，不应把永久密钥打进 React bundle 或公开发布包。

## 一、后台需要创建什么

### 1. 开通 TOS

首次使用前，需要注册火山引擎账号、完成实名认证并开通 TOS 服务。官方控制台快速入门随后要求创建存储桶，才能上传对象。[TOS 控制台快速入门][tos-quickstart]

### 2. 创建 Bucket

创建 Bucket 时需要确定：

- Bucket 名称：在 TOS 范围内全局唯一，创建后不可更改。
- Region：Bucket 所属地域，创建后不可更改。
- 访问策略：建议选择私有。
- 对象 ACL 默认策略：建议不要为了给模型读取而把整个 Bucket 设置为公共读。

官方快速入门将私有设为默认推荐选项；公共读会允许匿名读取，并可能产生流量费用、数据泄露及财产损失风险。[TOS 控制台快速入门][tos-quickstart]

### 3. 创建 IAM 用户或角色

有两条路径：

| 场景 | 后台身份 | 客户端最终拿到的内容 |
| --- | --- | --- |
| 开发、内部工具、单用户桌面端 | IAM 用户（子账号）+ 自定义 TOS 权限 | 该用户的 AK/SK，或由它换取 STS |
| 正式发布的桌面端 | IAM 角色 + 服务端凭证服务 | 临时 AK、临时 SK、SecurityToken、过期时间，或预签名 URL |

IAM 用户可以直接绑定权限策略，也可以加入用户组继承权限。角色通过关联权限策略获得资源权限，并通过信任策略决定谁可以扮演它。[创建 IAM 用户并授予权限][iam-user] [角色介绍][iam-role]

角色本身不是一组 AK/SK。官方 Access Key 文档明确说明，主账号和 IAM 用户可以拥有 Access Key，角色不能拥有 Access Key。[Access Key 管理][access-key]

## 二、AK/SK 与 STS 到底需要哪些字段

### 长期 AK/SK

长期凭证包含：

- `Access Key ID`，简称 AK。
- `Secret Access Key`，简称 SK。

SDK 使用 AK/SK 对 TOS 请求进行签名。官方 TOS Rust SDK 示例从环境变量读取 AK/SK，并用 `region`、`endpoint` 创建客户端。[官方 TOS Rust SDK][rust-sdk]

长期 AK/SK 适合：

- 本地开发调试。
- 受控的内部桌面工具。
- 服务端或 CI 环境。

不建议把长期 AK/SK 放入面向普通用户发布的客户端。官方客户端 STS 示例明确指出，客户端代码中放永久 AK/SK 存在安全风险，应由服务端生成临时凭证并设置有效期。[客户端使用 STS 访问 TOS][sts-client]

### STS 临时凭证

客户端使用 STS 时，不能只下发一个 AK。通常需要成套下发：

```text
AccessKeyId       临时 AK
SecretAccessKey   临时 SK
SecurityToken     临时会话 Token
Expiration        过期时间
```

官方 TOS 表单签名文档说明，使用临时 AK/SK 时必须同时携带与临时 AK 配对的 `SecurityToken`；TOS Browser/SDK 配置也将 STS Token 作为独立字段。[TOS 浏览器表单签名][tos-form-signature] [TOS Browser.js 上传对象][browser-upload]

STS 的典型链路是：

```text
服务端持有受保护的长期凭证
        ↓
调用 STS AssumeRole
        ↓
获取临时 AK / SK / SecurityToken / Expiration
        ↓
下发给桌面客户端
        ↓
客户端使用临时凭证访问 TOS
```

火山引擎官方临时凭证最佳实践要求：非 ECS、容器、函数等云上运行环境的应用，建议使用角色扮演 AssumeRole 向访问环境下发临时凭证。[临时凭证最佳实践][sts-best-practice]

### IAM 用户与 IAM 角色的分工

- IAM 用户：可以拥有 AK/SK，适合作为服务端调用方或开发环境身份。
- IAM 角色：绑定 TOS 权限策略和信任策略，不直接拥有 AK/SK。
- 凭证服务：持有一个有权调用 `sts:AssumeRole` 的服务端身份，代表客户端扮演 TOS 角色。
- 桌面客户端：只拿短期凭证或预签名 URL，不拿角色的永久密钥。

官方角色文档描述了“创建角色并授权 → 服务端调用 STS AssumeRole → 得到临时 AccessKey 和 Token”的流程；角色文档还说明，主账号不能直接扮演角色，需要由 IAM 子用户获得相应的 AssumeRole 权限。[角色扮演流程][role-assume]

## 三、Region、Endpoint、Bucket 应如何配置

三者需要成套配置：

```text
region  = cn-beijing
endpoint = https://tos-cn-beijing.volces.com
bucket  = 你创建的 Bucket 名称
```

上面是北京地域的公网 TOS Endpoint 示例。实际项目应按照 Bucket 所在地域填写对应 Region 和 Endpoint。官方 TOS Rust SDK 示例使用 `https://tos-cn-beijing.volces.com` 与 `cn-beijing`；官方上传示例也要求 Endpoint 和 Region 对应 Bucket 所在区域。[官方 TOS Rust SDK][rust-sdk] [普通上传（Python SDK）][put-object]

注意：TOS SDK 使用 TOS 协议 Endpoint，不要把 S3 协议 Endpoint 误传给 TOS SDK。火山引擎官方排障文档以 `tos-cn-beijing.volces.com` 为示例，并明确区分 `tos-s3-cn-beijing.volces.com`。[TOS Endpoint 排障][endpoint-troubleshooting]

如果客户端运行在需要内网访问的火山云网络中，可根据官方地域文档选择对应内网 Endpoint；普通互联网桌面端通常使用公网 Endpoint。

## 四、推荐的最小权限

### 运行时权限

如果 Lumina 只需要把本地媒体上传到固定前缀，并让下游服务读取该媒体，建议从下面的对象级权限开始：

```json
{
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "tos:PutObject",
        "tos:GetObject"
      ],
      "Resource": [
        "trn:tos:::YOUR_BUCKET/lumina/*"
      ]
    }
  ]
}
```

这表示：

- `tos:PutObject`：上传对象，适用于普通 PUT 上传，也覆盖分片上传的主要写入动作。
- `tos:GetObject`：读取对象；生成或使用 GET 预签名 URL 时，对应的最终访问动作是读取对象。
- `Resource`：尽量限制到一个 Bucket 的一个前缀，不要直接授权整个账号或所有 Bucket。

火山引擎官方“指定桶上传和下载对象”示例使用 `tos:GetObject`、`tos:PutObject`，资源为 `trn:tos:::bucketname/*`；该文同时说明，API/SDK 上传下载不需要为了列举资源而额外授予 `ListBuckets`、`ListBucket`。[IAM 用户指定桶上传下载][iam-object-permission]

### 按功能追加权限

| 功能 | 可能需要的权限 | 是否默认加入 |
| --- | --- | --- |
| 创建 Bucket | `tos:CreateBucket` | 否；仅后台初始化身份需要 |
| 普通上传 | `tos:PutObject` | 是 |
| 下载或 GET 预签名 URL | `tos:GetObject` | 是，如果需要读 |
| 断点/分片上传恢复 | `tos:ListMultipartUploadParts` | 按实际 SDK 流程加入 |
| 取消失败的分片上传 | `tos:AbortMultipartUpload` | 按实际 SDK 流程加入 |
| 删除 staging 对象 | `tos:DeleteObject` | 后续清理功能需要时加入 |
| 在应用内列举 Bucket/对象 | `tos:ListBuckets`、`tos:ListBucket` | 只有确实需要列表 UI 时加入 |
| 修改 ACL | `tos:GetObjectAcl`、`tos:PutObjectAcl` | 不建议默认加入 |

官方桶策略动作说明把 `PutObject` 映射到 PUT 上传、分片上传初始化/上传/合并，把 `GetObject` 映射到读取对象，把 `AbortMultipartUpload` 和 `ListMultipartUploadParts` 列为分片上传相关动作；`DeleteObject` 属于风险操作，应谨慎授权。[桶策略动作说明][bucket-actions]

### 创建权限与运行权限分离

负责创建 Bucket 的管理员或一次性初始化身份可以拥有 `tos:CreateBucket`。桌面端运行时身份不应拥有创建 Bucket、删除 Bucket、修改 ACL 等管理权限。

## 五、预签名 URL 的接入步骤

预签名 URL 是“带有签名和过期时间的临时访问能力”，不是让客户端永久拥有 TOS 权限。官方文档说明，预签名 URL 包含 AK、有效期、资源、操作和签名；持有 URL 的人可以在有效期内执行 URL 对应的操作。[预签名概述（Rust SDK）][presign-rust] [预签名概述（Python SDK）][presign-python]

### 下游模型需要读取媒体时

推荐使用 GET 预签名 URL：

1. 客户端或 Tauri 后端将本地图片/视频上传为私有对象。
2. 服务端或安全的 TOS SDK 客户端针对 `bucket + object key + GET` 生成预签名 URL。
3. 将 URL 传给需要公网访问地址的模型服务。
4. URL 过期后不再可读，需要重新生成；不要把它当作稳定的资源 ID。

### 客户端直传时

如果不希望桌面端持有 TOS 凭证，可以由服务端生成指定对象的 PUT 预签名 URL：

1. 桌面端向业务服务申请上传地址。
2. 业务服务校验用户、文件类型、大小和对象前缀。
3. 业务服务生成短期 PUT 预签名 URL 并返回。
4. 桌面端使用普通 HTTP PUT 上传，不需要 AK/SK。
5. 上传完成后，业务服务或客户端申请 GET 预签名 URL供下游读取。

火山引擎官方预签名文档说明，预签名请求需要对应具体的操作，并通过 SDK 生成普通预签名链接或 POST 表单预签名参数；实际实现应按 SDK 的方法参数指定 Bucket、Object Key、HTTP 方法和过期时间。[预签名概述（C++ SDK）][presign-cpp]

### 预签名 URL 的安全边界

- 有效期尽量覆盖模型排队、下载和重试时间，但不要无限期。
- URL 不应写入普通日志，因为其中包含签名参数。
- 使用 STS 生成预签名 URL 时，URL 有效期不能超过临时凭证有效期。
- 不要把预签名 URL 持久化为 Lumina 节点的永久资源地址；应持久化对象 Key 或内部 Asset ID，使用时重新签名。
- 如果只需要让模型读取对象，不需要把 Bucket 改为公共读。

## 六、上传方式选择

官方 TOS SDK 支持多种上传方式：

- 普通上传：单对象不超过 5 GiB。
- 分片上传：适合较大文件。
- 断点续传：支持并发和断点恢复，适合网络不稳定或大视频文件。

Browser.js 官方文档列出普通上传、分片上传和断点续传的适用范围；当前 Lumina 是 Tauri 应用，后续接入更适合在 Rust 后端使用官方 Rust SDK，而不是让画布组件直接调用 TOS。[Browser.js 上传对象][browser-upload] [官方 TOS Rust SDK][rust-sdk]

## 七、对 Lumina 的落地建议（Inference）

这是结合仓库当前 Tauri 分层和已有“本地媒体 → 公网 URL”需求得出的工程判断，不是火山引擎官方产品规定：

### 第一阶段：私有 TOS 替换当前公网中转

- Tauri Rust 层负责从本地路径读取媒体并上传 TOS。
- Bucket 和对象保持私有。
- 返回短期 GET 预签名 URL给视频模型。
- 节点数据只保存本地文件引用或稳定的 TOS Object Key，不保存带过期时间的 URL。
- 先支持普通上传；视频较大或网络不稳定时再加断点续传。

### 第二阶段：正式发布版本使用 STS

- 部署一个最小凭证服务。
- 服务端长期保存用于 AssumeRole 的凭证。
- IAM 角色只授予指定 Bucket/前缀的 TOS 对象权限。
- 桌面端启动或凭证即将过期时申请临时 AK/SK/Token。
- Tauri Rust SDK 用临时凭证访问 TOS。

### 目前不建议的方案

- 把主账号 AK/SK 写进前端或安装包。
- 把 Bucket 设为公共读，只为了让视频模型能访问。
- 给运行时身份授予 `tos:*` 或整个账号范围。
- 把预签名 URL 当作永久素材 URL 保存。

## 八、后台操作清单

```text
[ ] 注册火山引擎账号并完成实名认证
[ ] 开通 TOS
[ ] 创建私有 Bucket
[ ] 记录 Bucket 名称、Region、公网 Endpoint
[ ] 创建 IAM 子账号或 IAM 角色
[ ] 为运行时身份授权指定 Bucket/前缀的 PutObject、GetObject
[ ] 需要分片时再追加 ListMultipartUploadParts、AbortMultipartUpload
[ ] 开发阶段创建子账号 AK/SK，禁止使用主账号 AK/SK
[ ] 生产桌面端部署 STS/预签名 URL 服务
[ ] 配置凭证过期刷新、失败上传清理和 URL 过期重签
[ ] 验证普通上传、私有 GET、过期 URL、错误权限和大文件上传
```

## 官方来源

- [TOS 控制台快速入门](https://www.volcengine.com/docs/6349/74830?lang=zh)
- [Access Key（密钥）管理](https://www.volcengine.com/docs/6291/65568?lang=zh)
- [创建 IAM 用户并授予权限](https://www.volcengine.com/docs/6257/94013?lang=zh)
- [角色介绍](https://www.volcengine.com/docs/6257/64979?lang=zh)
- [信任身份（Principal）](https://www.volcengine.com/docs/6257/1134850)
- [临时凭证最佳实践](https://www.volcengine.com/docs/6257/2100113)
- [使用 STS 临时 Token 访问 TOS](https://www.volcengine.com/docs/6627/102220?lang=zh)
- [通过角色身份获取临时 AccessKey 和 Token](https://www.volcengine.com/docs/6257/160179?lang=zh)
- [授予 IAM 用户指定桶上传和下载对象的权限](https://www.volcengine.com/docs/6349/1183384?lang=en)
- [桶策略模板及参数说明](https://www.volcengine.com/docs/6349/102127?lang=en)
- [普通上传（Python SDK）](https://www.volcengine.com/docs/6349/92800?lang=zh)
- [上传对象概述（Browser.js SDK）](https://www.volcengine.com/docs/6349/127744?lang=en)
- [基于浏览器上传的表单中包含签名](https://www.volcengine.com/docs/6349/129225?lang=en)
- [TOS Endpoint 排障](https://www.volcengine.com/docs/6349/1110757?lang=zh)
- [预签名机制 PreSignedURL（Rust SDK）](https://www.volcengine.com/docs/6349/2124729?lang=zh)
- [预签名概述（Python SDK）](https://www.volcengine.com/docs/6349/173812?lang=en)
- [预签名概述（C++ SDK）](https://www.volcengine.com/docs/6349/173954?lang=zh)
- [火山引擎官方 TOS Rust SDK](https://github.com/volcengine/ve-tos-rust-sdk)

[tos-quickstart]: https://www.volcengine.com/docs/6349/74830?lang=zh
[access-key]: https://www.volcengine.com/docs/6291/65568?lang=zh
[iam-user]: https://www.volcengine.com/docs/6257/94013?lang=zh
[iam-role]: https://www.volcengine.com/docs/6257/64979?lang=zh
[sts-best-practice]: https://www.volcengine.com/docs/6257/2100113
[sts-client]: https://www.volcengine.com/docs/6627/102220?lang=zh
[role-assume]: https://www.volcengine.com/docs/6257/160179?lang=zh
[rust-sdk]: https://github.com/volcengine/ve-tos-rust-sdk
[tos-form-signature]: https://www.volcengine.com/docs/6349/129225?lang=en
[browser-upload]: https://www.volcengine.com/docs/6349/127744?lang=en
[iam-object-permission]: https://www.volcengine.com/docs/6349/1183384?lang=en
[bucket-actions]: https://www.volcengine.com/docs/6349/102127?lang=en
[put-object]: https://www.volcengine.com/docs/6349/92800?lang=zh
[endpoint-troubleshooting]: https://www.volcengine.com/docs/6349/1110757?lang=zh
[presign-rust]: https://www.volcengine.com/docs/6349/2124729?lang=zh
[presign-python]: https://www.volcengine.com/docs/6349/173812?lang=en
[presign-cpp]: https://www.volcengine.com/docs/6349/173954?lang=zh
