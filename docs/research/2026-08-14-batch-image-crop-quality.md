# 批量图片裁剪清晰度与 JPEG 编码方案调研

日期：2026-08-14

状态：技术选型建议，不包含产品代码改动

## 1. 结论摘要

对 `5464x8192 -> 1440x1920` 这类大比例缩小，建议按以下顺序推进：

1. **保留 `fast_image_resize + Lanczos3`。** 它已经是高质量、SIMD 加速的缩放实现；官方同类性能基准中，其 Lanczos3 速度不弱于 libvips。仅为“看起来更锐”替换 libvips、ImageMagick 或 OpenCV，尚无画质证据支持，收益不足以覆盖 Windows 原生依赖和打包复杂度。[S2][S3]
2. **在缩放后、JPEG 编码前增加一层轻微、可控的输出锐化。** Photoshop 官方将 `Bicubic Sharper` 定义为用于缩小、带增强锐化的双三次插值方法；这与当前样本中 PS 结果更锐、文件也更大的现象一致。[S4]
3. **锐化应有半径、强度和阈值，不直接使用固定强度的通用 `unsharpen()`。** 第一轮建议围绕 `sigma/radius 0.55-0.8 px`、`amount 0.25-0.4`、`threshold 2-4/255` 做盲测，优先只增强亮度细节，避免彩边、皮肤噪点和白底轮廓光晕。
4. **JPEG 编码器不是当前清晰度差异的主因。** 现有 `image` crate 在 `quality=100` 时量化表已降到全 `1`；换成 libjpeg-turbo 主要改善吞吐，换成 mozjpeg/jpegli 主要改善“同画质下的体积”，都不能恢复缩放阶段没有保留下来的高频细节。[S7][S8][S10][S11]
5. **将线性光缩放作为独立 A/B 项，而不是与锐化绑在一起上线。** `fast_image_resize` 明确说明它默认不会把 sRGB 转为线性空间，并提供 `create_srgb_mapper()`；开启后更符合颜色计算，但可能改变当前观感并明显增加内存，因此需要单独验证。[S2]
6. **把 `pic-scale` 留作第二阶段纯 Rust A/B 候选。** `pic-scale 0.7.11` 内置 SIMD、多线程、30 多种滤镜，以及 Linear、Sigmoidal、Lab/Oklab 等颜色空间缩放，并支持预乘 Alpha；它适合集中验证颜色空间和透明边缘，但目前没有样本证据表明其 Lanczos3 比现有实现更清晰，不应先于输出锐化引入。[S21]

推荐的最小方案是：

```text
解码/方向校正 -> 裁剪 -> Lanczos3 缩到目标尺寸
-> 白底合成 -> 目标尺寸亮度锐化（带阈值） -> JPEG 4:4:4
```

不建议第一步就引入 libvips、ImageMagick、OpenCV、mozjpeg 或 jpegli。

## 2. 当前实现与样本证据

### 2.1 当前实现

仓库当前锁定版本为：

- `fast_image_resize 6.0.0`
- `image 0.25.9`
- `imageproc 0.26.1`

导出链路位于 `src-tauri/src/commands/batch_image_crop.rs`：

1. `image.crop_imm(...)` 裁剪；
2. `fast_image_resize` 的 `Convolution(Lanczos3)` 缩放到目标像素；
3. 透明像素合成到白色；
4. `image::codecs::jpeg::JpegEncoder` 以 `quality=100` 编码。[S1]

`image 0.25.9` 的 JPEG 源码显示：质量 `100` 会让标准亮度、色度量化表的值全部夹到 `1`，已经是该编码器的最高量化质量；编码器同时支持写入 DPI、ICC 和 EXIF，但当前导出链路没有设置这些信息。[S7]

### 2.2 大文件的实际内存含义

压缩文件的 `33 MB` 不能代表处理时内存。`5464x8192` 是 `44,761,088` 像素：

| 像素存储 | 单个完整画面理论大小 |
| --- | ---: |
| RGB8 | 128.1 MiB |
| RGBA8 | 170.8 MiB |
| RGB16 | 256.1 MiB |
| RGBA16 | 341.5 MiB |

当前链路同时存在解码图、裁剪结果、`to_rgba8()` 转换结果和目标图，峰值可能达到数百 MiB，需以 Windows 进程峰值实测为准。启用 RGB16 线性光缩放会进一步抬高峰值；libvips 的流式、需求驱动执行只有在批量任务确实出现内存压力时才构成明确优势。[S12]

### 2.3 用户样本的定向实验

样本：`原.jpg`、`lu.jpg`、`ps.jpg`。本次收到的原图实际为 `13,446,022 B`（约 13.45 MB），并不是用户口述场景中的 33 MB；两者都属于压缩文件大小，不能直接代表解码后的像素内存。已知事实：

| 文件 | 像素 | 字节数 | 量化表反推质量 | 色度采样 |
| --- | ---: | ---: | ---: | ---: |
| 原图 | 5464x8192 | 13,446,022 | 99 | 4:4:4 |
| Lumina | 1440x1920 | 713,713 | 100 | 4:4:4 |
| Photoshop | 1440x1920 | 909,185 | 99 | 4:4:4 |

“反推质量”是 ImageMagick 根据 JPEG 量化表给出的估算，不是文件内保存的 Photoshop/Lumina 导出质量滑杆值。Lumina 的量化表元素均为 `1`，因此不能把它较小的体积归因于低 JPEG quality 或 4:2:0 色度抽样。

PS 与 Lumina 的主体比例并不完全相同，因此下列实验只用于缩小候选参数范围，不能作为最终画质证明。

对已经导出的 `lu.jpg` 临时应用 ImageMagick Unsharp Mask，并再次以 `quality=100`、4:4:4 编码：

| 参数 | 文件大小 | 全图 Sobel 标准差 | 3x3 局部对比标准差 |
| --- | ---: | ---: | ---: |
| Lumina 原结果 | 713,713 B | 0.11063 | 0.01510 |
| PS 结果 | 909,185 B | 0.11624 | 0.01656 |
| `0x0.6 + amount 0.25 + threshold 0.015` | 830,157 B | 0.11645 | 0.01622 |
| `0x0.6 + amount 0.40 + threshold 0.015` | 843,042 B | 0.11976 | 0.01686 |

这组结果支持两个判断：

- 轻微锐化足以把简单边缘/局部对比统计推到 PS 样本附近；
- 锐化增加高频信息后，JPEG 文件自然变大，所以“PS 文件更大”可以由更锐的像素内容解释，并不证明 Lumina 的 JPEG 质量参数较低。

限制：该实验经历了二次 JPEG 编码，且未对人物比例和裁剪区域做严格配准。正式结论必须基于原图一次性完成“相同裁剪 -> 缩放 -> 锐化 -> 编码”。

## 3. 缩放与锐化方案比较

| 方案 | 预期画质收益 | CPU / 内存 | Rust/Tauri/Windows 接入 | 维护与许可证 | 判断 |
| --- | --- | --- | --- | --- | --- |
| 现有 `fast_image_resize` Lanczos3 | 高质量缩小；Lanczos 可能有轻微振铃，但不是当前“偏软”的主要嫌疑 | SIMD；官方单图基准表现很好；当前为整图内存 | 已接入、纯 Rust；Windows x64 可用 SSE4.1/AVX2 | 活跃；MIT OR Apache-2.0 [S2][S3] | **保留** |
| 缩小后亮度 Unsharp Mask | 最直接增加目标尺寸的边缘微对比，最接近 Adobe “缩小并增强锐化”的处理方向 | 在 1440x1920 上做，额外缓冲约在数十 MiB 内；CPU 成本远小于对 45MP 原图处理 | 可用现有 `image`/`imageproc` 实现，无新原生依赖 | 继承现有依赖许可证 [S5][S6] | **首选实验** |
| `image::imageops::unsharpen` | 有 `sigma` 和阈值，但内部锐化量固定为一次差分，控制不足 | 目标尺寸高斯模糊 + 输出缓冲 | 已有依赖、纯 Rust | MIT OR Apache-2.0 [S6][S7] | 只适合快速原型 |
| `imageproc::sharpen_gaussian` | 有 `sigma` 和 `amount`，但当前公开函数只接受灰度图，源码也标有“support colour images”待办 | 高斯模糊使用可分离滤波；部分 API 有 Rayon 版本 | 已有依赖、纯 Rust | 活跃；MIT [S5] | 可复用模糊能力，不直接套灰度输出 |
| `pic-scale 0.7.11` | 内置 30 多种滤镜及 Linear、Sigmoidal、Lab/Oklab 等颜色空间；可在一个库内验证线性光缩放和预乘 Alpha | SIMD、运行时 CPU 能力检测、多线程；实际速度和峰值内存需用 Lumina 的 45MP 样本实测 | 纯 Rust 接入路径；要求 Rust 1.89，当前本地 Rust 1.97.1 满足 | BSD-3-Clause OR Apache-2.0 [S21] | **第二阶段 A/B**；没有证据支持为当前锐度问题立即替换现有库 |
| libvips | 内置 resize 与 sharpen；质量可调，但没有证据说明同核 Lanczos 会比当前实现更清晰 | 需求驱动、分块、横向多线程，通常低内存；但只做单次 resize 时不保证更快 | Rust binding 仍需打包原生 libvips 与依赖 DLL；Windows 有独立预编译生态 | 活跃；LGPL-2.1-or-later [S12][S13][S14] | 仅在批量峰值内存成为问题时再评估 |
| ImageMagick | 滤镜、色彩管理、`-unsharp` 参数非常完整，适合建立对照基准 | Q16/HDRI 构建内存较重；进程或 MagickWand 都增加开销 | Windows 可用，但需随应用分发 MagickCore/MagickWand 与 delegates；Rust binding 也是 FFI | 活跃；ImageMagick License，分发需归属声明 [S15][S16][S17] | 适合作为离线基准，不建议嵌入首版 |
| OpenCV | `INTER_AREA` 官方建议用于缩小，也有 `INTER_LANCZOS4`；高斯模糊与加权可拼出 USM | SIMD/线程成熟，但完整 OpenCV 体量和初始化成本明显超过本需求 | `opencv-rust` 依赖系统/预编译 OpenCV，Windows 构建、DLL 和 ABI 管理成本高 | 活跃；Apache-2.0 [S18][S19][S20] | 对“裁剪 + 缩放 + JPEG”明显过重 |

### 3.1 为什么不先换缩放核

`fast_image_resize` 把 Lanczos3 定义为截断 sinc 的高质量 6x6 最小核，并将它设为默认卷积算法。[S2]

项目官方 x86_64 单线程对照基准中，`4928x3279 -> 852x567` RGB8 Lanczos3 为：

- `fast_image_resize AVX2`: 13.21 ms
- libvips: 15.78 ms
- `image` crate: 189.93 ms

ARM64 对照中相同任务为：

- `fast_image_resize NEON`: 62.16 ms
- libvips: 88.65 ms
- `image` crate: 433.80 ms

这是库作者的特定硬件性能基准，不等于 Lumina 的 Windows 实测，也不能证明两个库的输出画质相同；它只说明“换 libvips 才能获得缩放性能”不是成立前提。[S3]

OpenCV 的 `INTER_AREA` 适合强降采样并可减少摩尔纹，但往往比 Lanczos 更平滑；`INTER_LANCZOS4` 则是 8x8 邻域。两者都不能替代目标尺寸的输出锐化。[S18]

### 3.2 推荐的锐化实现

建议实现可调的亮度 USM，而不是逐 RGB 通道直接增强：

```text
Y = luminance(R, G, B)
blurred = gaussian_blur(Y, sigma)
detail = Y - blurred
detail = abs(detail) >= threshold ? detail : 0
Y' = clamp(Y + amount * detail)
将 Y' 的变化回写 RGB，保持色相/色度尽量不变
```

第一轮候选参数：

| 档位 | sigma / radius | amount | threshold |
| --- | ---: | ---: | ---: |
| 轻 | 0.55 px | 0.25 | 3/255 |
| 默认候选 | 0.65 px | 0.35 | 3/255 |
| 较强 | 0.80 px | 0.40 | 4/255 |

这些是基于当前单个样本收敛出的实验起点，不是最终产品常量。必须加入以下保护：

- 只在发生明显缩小时启用；原尺寸导出或放大不自动套同一参数；
- 阈值抑制皮肤、纯色背景和 JPEG 噪声；
- 检查发丝、睫毛、衣服文字、白底人物轮廓是否出现黑白光晕；
- 保留“关闭锐化”的基准分支，避免主观评价失去参照；
- 一次性从原始像素处理并编码，禁止拿已有 JPEG 再锐化、再保存。

### 3.3 sRGB/线性光缩放

`fast_image_resize` 官方说明：Resizer 不会自动在线性空间工作；对 sRGB 正确缩放时，应先转线性，再缩放，再转回，并提供 `create_srgb_mapper()` 和 U8/U16 映射能力。[S2]

建议将其设为第二个独立实验变量：

- 质量价值：改善高反差边界混色和亮度计算的物理正确性；
- 风险：结果未必更符合用户对 Photoshop 的主观锐度预期；
- 成本：较稳妥的 RGB16 线性中间图会显著抬高 45MP 图片的峰值内存；
- 决策：先用当前样本和黑白细线、文字、透明边缘测试图 A/B，不与 USM 同时改变。

如果该阶段确认线性光或透明边缘处理有稳定收益，可再用 `pic-scale` 做纯 Rust 对照。它的价值是把颜色空间转换、滤镜和预乘 Alpha 放进同一缩放 API，而不是承诺“换库即变清晰”。A/B 仍应固定裁剪矩形、Lanczos3、锐化参数和 JPEG 编码，只改变缩放实现。[S21]

## 4. JPEG 编码器比较

| 编码器 | 主要收益 | 画质/体积特征 | CPU / 接入成本 | 维护与许可证 | 对本问题的建议 |
| --- | --- | --- | --- | --- | --- |
| `image` crate JPEG | 纯 Rust、零新增原生运行库、API 简单 | 当前 q100 量化表全 `1`；不以最先进的感知优化或最小体积为目标 | 接入成本最低；当前已稳定工作 | 活跃；MIT OR Apache-2.0 [S7] | **继续使用作为画质实验基线** |
| libjpeg-turbo | JPEG 编解码吞吐 | 官方称在支持 SIMD 的平台通常比 libjpeg 快 2-6 倍；可控制采样、优化 Huffman、渐进式 | C/CMake；Rust 需 FFI/绑定和 Windows 静态或 DLL 打包 | 活跃；IJG + BSD-3-Clause + zlib 条款，二进制分发有归属要求 [S8][S9] | 仅在编码耗时成为瓶颈时采用 |
| mozjpeg | 相同兼容 JPEG 下提高压缩效率 | 通过更积极的编码优化争取同画质更小文件，通常比普通编码慢；不负责缩放或锐化 | C/CMake；Rust 多为 `mozjpeg-sys` 类绑定，Windows 构建链更复杂 | 稳定但发布节奏低于 libjpeg-turbo；IJG/BSD/zlib 系许可证 [S10] | 只为体积 KPI 评估，不解决当前偏软 |
| jpegli | 高质量区间的 JPEG 压缩效率与感知质量 | Google 官方称在兼容既有 8-bit JPEG 解码器的前提下，相比传统 JPEG 可有约 35% 压缩密度提升，并使用自适应量化等技术 | C++/CMake；当前缺少与现有纯 Rust 链路同等成熟、低风险的接入路径 | Google 活跃开发；BSD-3-Clause [S11] | 有明确“同画质降体积”需求时做独立 PoC |

编码器选型需要区分三个目标：

- **更锐**：由缩放和输出锐化决定；
- **编码更快**：优先 libjpeg-turbo；
- **同画质更小**：优先对比 mozjpeg 与 jpegli。

把 JPEG 质量从 `100` 调到另一个编码器的 `100` 不能直接横向比较，因为各编码器的 quality 标尺、量化表和感知优化不同。必须固定目标画质，以解码后的像素与人工盲测比较体积。

## 5. 建议实施与验证计划

### 阶段 A：不增加依赖的画质 PoC

1. 保持裁剪、Lanczos3、JPEG 编码不变。
2. 在目标尺寸 RGB 图上加入可配置亮度 USM，仅供测试调用。
3. 用 `amount=0 / 0.25 / 0.35 / 0.40` 生成盲测组。
4. 至少覆盖：当前服装人像、发丝、文字、织物、纯色背景、高 ISO 噪点、透明 PNG 白底合成。
5. 记录每张的耗时、峰值内存、输出体积与光晕检查结果。

成功标准：

- 当前用户样本在 100% 查看时，发丝、眼睛、衣服文字的主观清晰度接近 PS；
- 白底轮廓无明显亮/暗边，皮肤与纯色区域没有噪点放大；
- 输出仍为精确的 `1440x1920`；
- Windows 单张 45MP 图片无 OOM，批量导出交互不阻塞；
- 新测试能在锐化被误删、参数回到 0 或处理顺序错误时失败。

### 阶段 B：颜色正确性 A/B

对同一测试集比较：

- 当前 sRGB 数值直接 Lanczos3；
- sRGB -> linear RGB16 -> Lanczos3 -> sRGB；
- 两者分别配同一组输出锐化。

颜色变化和锐度变化分开评审。若收益只出现在极端测试图、而峰值内存显著恶化，则不应默认开启。

### 阶段 C：仅在指标触发时更换组件

- 峰值内存或多图并发 OOM：PoC libvips；
- JPEG 编码占导出耗时主要部分：PoC libjpeg-turbo；
- 有明确文件大小上限且当前 q95-q100 过大：PoC mozjpeg/jpegli；
- 线性光或透明边缘 A/B 有明确收益，且希望保持纯 Rust：PoC `pic-scale`；
- 不因“PS 文件更大”单独触发编码器替换。

Windows PoC 必须在 x64 release 构建中验证安装包、DLL/静态链接、许可证归属、冷启动、杀毒误报和离线运行，不能只在开发机通过。

## 6. 风险与待验证项

- 当前样本的 PS 与 Lumina 裁剪/人物比例不同，最终比较必须锁定完全相同的裁剪矩形。
- Photoshop 可能使用“自动”重采样或额外输出锐化；仅凭最终 JPEG 无法还原其完整处理参数。[S4]
- `imageproc` 文档说明其滤镜隐式假设线性色彩；直接在 sRGB 通道做滤波可能产生颜色误差。[S5]
- q100 文件更大不等于视觉更好；锐化也可能通过增加高频噪声让文件变大。
- 当前链路不保留 ICC/DPI/EXIF。ICC 会影响颜色而非同像素尺寸下的细节；若面向印刷或 Adobe RGB，应另立色彩管理任务，不与本次锐度修复混合。
- 对透明图应另外验证预乘 alpha 后缩放或先白底合成，避免透明边界色污染；当前服装样本为不透明 JPEG，不受此项影响。

## 7. 一手来源

- [S1] Lumina 当前导出实现：`src-tauri/src/commands/batch_image_crop.rs`；依赖版本：`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。
- [S2] fast_image_resize README（SIMD、色彩空间、Rayon、基准入口）：<https://github.com/Cykooz/fast_image_resize/blob/main/README.md>；滤镜定义：<https://github.com/Cykooz/fast_image_resize/blob/main/src/convolution/filters.rs>；许可证：<https://github.com/Cykooz/fast_image_resize/blob/main/LICENSE-MIT>
- [S3] fast_image_resize 官方 x86_64 / ARM64 基准：<https://github.com/Cykooz/fast_image_resize/blob/main/benchmarks-x86_64.md>、<https://github.com/Cykooz/fast_image_resize/blob/main/benchmarks-arm64.md>
- [S4] Adobe Photoshop 官方图片重采样说明（Bicubic Sharper）：<https://helpx.adobe.com/photoshop/using/resizing-image.html>
- [S5] imageproc README（线性色彩假设、并行能力、许可证）：<https://github.com/image-rs/imageproc/blob/master/README.md>；`sharpen_gaussian` 源码：<https://github.com/image-rs/imageproc/blob/master/src/filter/sharpen.rs>
- [S6] image 0.25.9 `unsharpen` 文档：<https://docs.rs/image/0.25.9/image/imageops/fn.unsharpen.html>
- [S7] image 0.25.9 JPEG encoder 文档与源码：<https://docs.rs/image/0.25.9/image/codecs/jpeg/struct.JpegEncoder.html>、<https://docs.rs/image/0.25.9/src/image/codecs/jpeg/encoder.rs.html>；项目许可证：<https://github.com/image-rs/image>
- [S8] libjpeg-turbo README（SIMD、API、性能定位）：<https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/README.md>；官方文档：<https://libjpeg-turbo.org/Documentation/Documentation>
- [S9] libjpeg-turbo 许可证与分发要求：<https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/LICENSE.md>
- [S10] mozjpeg 官方仓库、能力与许可证：<https://github.com/mozilla/mozjpeg>
- [S11] jpegli 官方仓库：<https://github.com/google/jpegli>；Google Open Source Blog 介绍：<https://opensource.googleblog.com/2024/04/introducing-jpegli-new-jpeg-coding-library.html>；许可证：<https://github.com/google/jpegli/blob/main/LICENSE>
- [S12] libvips README（需求驱动、低内存、多线程）：<https://github.com/libvips/libvips/blob/master/README.md>；架构说明：<https://www.libvips.org/API/current/how-it-works.html>
- [S13] libvips `resize` / `sharpen` 官方 API：<https://www.libvips.org/API/current/method.Image.resize.html>、<https://www.libvips.org/API/current/method.Image.sharpen.html>
- [S14] libvips 许可证：<https://github.com/libvips/libvips/blob/master/COPYING>；Rust binding：<https://github.com/olxgroup-oss/libvips-rust-bindings>
- [S15] ImageMagick 官方 Resize Filters / Resize 用法：<https://imagemagick.org/Usage/filter/>、<https://imagemagick.org/Usage/resize/>
- [S16] ImageMagick 官方 `-unsharp` 参数：<https://imagemagick.org/script/command-line-options.php#unsharp>
- [S17] ImageMagick 官方许可证：<https://imagemagick.org/script/license.php>
- [S18] OpenCV 官方几何变换文档（`INTER_AREA`、`INTER_LANCZOS4`）：<https://docs.opencv.org/4.x/da/d54/group__imgproc__transform.html>
- [S19] OpenCV 官方图像滤波文档：<https://docs.opencv.org/4.x/d4/d86/group__imgproc__filter.html>；Rust binding：<https://github.com/twistedfall/opencv-rust>
- [S20] OpenCV 官方许可证：<https://opencv.org/license/>
- [S21] pic-scale 官方仓库 README（SIMD、多线程、颜色空间、滤镜、预乘 Alpha）：<https://github.com/awxkee/pic-scale>；`Cargo.toml`（`0.7.11`、Rust 1.89、默认特性、许可证）：<https://github.com/awxkee/pic-scale/blob/master/Cargo.toml>；许可证：<https://github.com/awxkee/pic-scale/blob/master/LICENSE.md>、<https://github.com/awxkee/pic-scale/blob/master/LICENSE-APACHE.md>
