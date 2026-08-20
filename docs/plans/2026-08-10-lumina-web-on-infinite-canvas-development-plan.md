# Lumina Web 基于 Infinite Canvas 的迁移开发计划

> 文档状态：可执行
>
> 目标读者：在一个全新仓库中实施迁移的开发 Agent
>
> 最后更新：2026-08-10
>
> 产物目标：保留 Lumina 的视觉、交互、节点定义与节点逻辑，同时复用 Infinite Canvas 的 Web 画布引擎、内置 Agent 和外部 MCP Agent 基础设施

## 0. 执行方式

1. 先完整阅读本文，再改代码；不得只凭阶段标题实施。
2. 严格按 Phase 0 到 Phase 12 的顺序推进。后续 Phase 以此前 Phase 的退出条件为阻塞项。
3. 每个 Phase 使用独立提交；提交正文记录对应退出条件的验证命令和结果。
4. 任何偏离“固定决策”的实现必须先写 ADR，说明原因、备选方案、影响和回退方式。
5. 业务规则先写可失败的测试，再迁移实现；视觉规则先建立截图基线，再改样式。
6. Lumina 只作为设计与行为的源，不作为运行时依赖。不得把 `@xyflow/react` 节点组件、Zustand Store 或 Tauri/Rust 命令直接复制进新项目。
7. 本文中的目标路径以 Infinite Canvas `web/` 和 `canvas-agent/` 现有布局为准。若新仓库已调整目录，执行 Agent 须在首个提交中提供旧路径到新路径的对照表。

## 1. 目标结果

新项目打开后直接进入可工作的 Web 画布。用户可以创建和连接文字、图片、生图配置三类节点，上传图片、生成或润色文字、用文字和图片作为有序输入生成图片，并让内置 Agent 或 Codex 等外部 Agent 在同一套受控命令接口上读取和操作画布。

完成后的产品必须同时满足以下条件：

1. 画布引擎来自 Infinite Canvas，不引入 React Flow。
2. 核心节点 ID 只有 `text`、`image`、`config`；插件节点不承担核心业务。
3. Lumina 的暗色画布、紧凑控件、荧光绿选中态、紫色端口、顶部栏和底部浮动工具栏得到视觉保留。
4. Lumina 的输入顺序、有效文本、运行快照、停止后拒收迟到结果、多图引用、稳定输出槽和新建结果节点语义得到行为保留。
5. 连线只改变输入，不自动调用模型；所有生成均由用户或经批准的 Agent 显式触发。
6. 内置 Agent 与外部 MCP Agent 使用同一个 `CanvasCommandModule`，不能直接写 Zustand 或任意 `metadata`。
7. 项目、会话、资源和生成任务默认保存在浏览器本地；刷新后可恢复，运行中的不可恢复任务会进入明确的失联状态。
8. P0 外部 MCP 在本机 companion 同源托管的 Web 模式可用；纯静态托管模式不虚假承诺外部 MCP 可用。
9. 中文和英文界面均无裸露 key，输入法组合输入不会触发画布快捷键。
10. 单元、集成、E2E、视觉回归、性能和安全验收全部通过。

## 2. 固定决策

以下决策不是实施过程中的开放问题：

| 主题 | 决策 |
| --- | --- |
| 上游基线 | 以 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) `v0.15.1`、commit `a2576d559ad765ba83e9563894adfbcd4e63405a` 为代码基线 |
| 产品形态 | local-first Web，不再使用 Tauri 或 Rust |
| 画布引擎 | 保留 Infinite Canvas 自研画布、几何、拖拽、缩放、选择和渲染机制 |
| 核心节点 | 仅 `text`、`image`、`config`；其中 `config` 只负责图片生成 |
| 节点扩展方式 | 三类核心节点继续是 built-in；插件机制可以保留，但不能替代核心节点 |
| 视觉来源 | Lumina 当前设计 token、节点 UI 和三张 QA 截图是视觉真相源 |
| 行为来源 | Lumina 的 domain/application 纯逻辑及其测试是行为真相源 |
| 生成产物 | 每次图片生成创建新的 `image` 结果节点，不覆盖配置节点或输入图片 |
| 输入行为 | 上游变化只更新可见输入；不自动重跑当前节点或下游节点 |
| Agent 写入 | 内置 Agent、外部 Agent 和用户 UI 最终都提交受校验的画布命令；Agent 无权写内部运行字段 |
| 外部 Agent | 复用并收紧 `canvas-agent`；Codex 等客户端通过 MCP stdio 接入本机 companion |
| Web 分发 | P0 提供纯 Web 模式和 companion 托管模式；外部 MCP 的正式支持范围是后者 |
| 包管理器 | 新仓库的 `web/` 与 `canvas-agent/` 统一使用 npm 和 `package-lock.json`，移除这两个 package 中重复的 `bun.lock`；其他独立 package 按自身约定处理 |
| 国际化 | 所有用户可见文案使用 i18next，中英文 key 同步提交 |

## 3. 范围与非目标

### 3.1 P0 范围

- 项目列表、项目创建、打开、重命名、删除、导入和导出。
- 无限画布的平移、缩放、框选、单选、多选、拖动、调整尺寸、复制、生成副本、删除、撤销和重做。
- `text` 节点的手工文字、上游上下文、AI 文字生成、结果编辑、模型选择、思考等级、润色、停止和错误状态。
- `image` 节点的点击/拖放/粘贴上传、预览、持久化资源、下载、生成占位、成功结果和错误结果。
- `config` 节点的本地提示词、模型、尺寸、宽高比、输出数量、提示词润色、有序文字/图片输入和图片生成。
- 浏览器内置 Agent：项目内会话、明确画布引用、流式输出、取消、命令预览、批准、执行和整批撤销。
- 外部 MCP Agent：读取、选择、受控编辑、生成、状态查询和整批撤销。
- IndexedDB 本地持久化、资源清理、schema migration、项目备份。
- 暗色与亮色主题；桌面浏览器为主要工作面，窄屏不得出现重叠或不可恢复的遮挡。

### 3.2 非目标

- 视频、音频、分镜、分组、裁剪、标注、扩图和其他 Lumina 工具节点。
- Tauri、Rust、SQLite 数据库、原生菜单、系统钥匙串和桌面安装包。
- 实时多人协作、云同步、账户体系、计费系统和服务端项目数据库。
- 自动迁移 Lumina SQLite 中的历史项目。本文只定义节点语义映射；若需要真实数据导入，应另立需求。
- 在 P0 重写 Infinite Canvas 的画布几何或事件系统。
- 为三个核心节点另做插件版本。
- 在未验证浏览器 Private Network Access、混合内容和证书约束前，宣称远程 HTTPS 站点可稳定连接本机 MCP companion。
- 移动端原生编辑体验。小于 `1024px` 的视口只要求基本可用和无 UI 重叠，不作为高密度生产工作流的首要目标。

## 4. 源代码与视觉基线

### 4.1 Infinite Canvas 基线阅读顺序

执行 Agent 在 Phase 0 必须按以下顺序阅读：

1. `README.md`、`LICENSE`、根 `AGENTS.md`、`web/package.json`、`canvas-agent/package.json`。
2. `web/src/types/canvas.ts`。
3. `web/src/types/canvas-plugin.ts`。
4. `web/src/lib/canvas/node-registry.ts`、`canvas-node-factory.ts`、`canvas-node-geometry.ts`、`canvas-node-size.ts`。
5. `web/src/pages/canvas/project.tsx`。
6. `web/src/components/canvas/canvas-node.tsx` 及 hover toolbar、prompt panel、generation 文件。
7. 项目 Store、`web/src/services/image-storage.ts`、`web/src/lib/localforage-storage.ts`。
8. `web/src/lib/canvas/canvas-agent-ops.ts`、`web/src/pages/canvas/hooks/use-agent-bridge.ts`。
9. `canvas-agent/src/canvas/{schemas,types,operations,session,tools}.ts`。
10. `canvas-agent/src/server/{mcp,http}.ts` 和现有 Agent/session 测试。

已知基线问题：

- `web/src/pages/canvas/project.tsx` 约 3029 行，交互、状态、生成和 Agent bridge 混在同一文件。
- `web/src/components/canvas/canvas-node.tsx` 约 876 行，多个节点语义共用通用 `metadata`。
- 现有 Node Registry 只声明浅层尺寸与渲染信息，没有 typed ports、输入顺序或 Agent 写权限。
- MCP schema 把 `image/text/config/video/audio` 写死，并允许 Agent 提交任意 `metadata` patch。
- Web 画布没有与 `canvas-agent` 同等级的自动化测试覆盖。

这些问题决定了迁移应先建立深模块和测试接缝，而不是直接改两个大文件。

### 4.2 Lumina 基线阅读顺序

Lumina 在本文撰写时的 HEAD 是 `d5e04fd623af0f52e87efd6d901e7af1d013fc7e`，但工作区包含影响当前交互的未提交改动。执行前必须创建一个不可变的 Lumina 源快照或由用户提供对应 tag；不得把该 HEAD 单独当成完整真相源。

1. `CONTEXT.md`：沿用其中“画布引用、有效文本、运行输入快照、变更集、占位节点、任务绑定、整批撤销、失联任务”等领域语言。
2. `src/index.css`：字体、颜色、阴影、半径、画布网格、端口和动效。
3. `src/features/canvas/domain/canvasNodes.ts`、`nodeRegistry.ts`。
4. `src/features/canvas/nodes/TextGenerationNode.tsx`、`TextGenerationUpstreamContext.tsx`。
5. `src/features/canvas/nodes/UploadNode.tsx`、`ImageNode.tsx`、`ImageEditNode.tsx`。
6. `src/features/canvas/ui/nodeControlStyles.ts`、`nodeToolbarConfig.ts`、`SelectedNodeOverlay.tsx`、`NodeActionToolbar.tsx`、`NodeContextMenu.tsx`。
7. 以下 application 纯逻辑和相邻测试：
   - `textGenerationInputs.ts`
   - `textGenerationRun.ts`
   - `textGenerationLayout.ts`
   - `compositionInputState.ts`
   - `imageReferencePrompt.ts`
   - `imageOutputBatch.ts`
   - `generationJobBatch.ts`
   - `imageNodeSizing.ts`
8. `src/features/canvas/models/` 中的模型注册、请求解析和 provider 约束。

视觉参考截图：

- `.playwright-cli/page-2026-08-10T06-25-50-059Z.png`
- `.playwright-cli/page-2026-08-10T06-29-21-478Z.png`
- `.playwright-cli/page-2026-08-10T06-36-44-957Z.png`

Phase 0 必须把这三张图复制到新仓库受版本控制的 `docs/reference/lumina/`，并记录截图 viewport、主题和场景。截图只用于视觉比对，不进入生产 bundle。

## 5. 目标领域模型

### 5.1 节点外壳

保留 Infinite Canvas 的几何字段，但把通用 `metadata?: CanvasNodeMetadata` 收紧为按 `type` 区分的联合类型。建议目标形态：

```ts
type CoreNodeType = 'text' | 'image' | 'config';

type CanvasNode =
  | CanvasNodeBase<'text', TextNodeData>
  | CanvasNodeBase<'image', ImageNodeData>
  | CanvasNodeBase<'config', ImageConfigNodeData>
  | PluginCanvasNode;

interface CanvasNodeBase<TType, TData> {
  id: string;
  type: TType;
  title: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  data: TData;
}
```

`data` 是持久化业务数据；hover、选中、输入法组合态、对象 URL、AbortController 和当前流式 delta 属于运行时 Store，不进入项目 JSON。

### 5.2 `text` 节点契约

```ts
interface TextNodeData {
  schemaVersion: 1;
  inputText: string;
  generatedText: string | null;
  model?: {
    providerId: string;
    modelId: string;
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  isSizeManuallyAdjusted: boolean;
}
```

不变量：

1. `inputText` 是用户本地文字，生成和润色以外的流程不能覆盖它。
2. `generatedText` 首次非空成功前为 `null`；一旦有非空结果，有效文本由它提供。
3. 用户可直接编辑结果；删空结果等同于清除，随后恢复“上游有效文本 + 本地输入”的有效文本。
4. 再次生成重新读取当前上游与 `inputText`，不得把旧 `generatedText` 回灌为输入。
5. 上游文字和本地输入按独立空行拼接；空上游节点保留在 UI 中供管理，但不进入有效文本。
6. 上游文字和图片分别维护稳定顺序；图片上限为 10，模型的更低硬限制仍优先。
7. 每个节点同时最多一个有效 run；停止后该 run 的迟到结果无权写回。
8. 空响应、失败和停止均保留已有结果。
9. 恢复项目时运行态回到 idle，持久化的有效文字保持不变。

### 5.3 `image` 节点契约

```ts
interface ImageNodeData {
  schemaVersion: 1;
  assetId: string | null;
  aspectRatio: string;
  isSizeManuallyAdjusted: boolean;
  origin:
    | { kind: 'upload'; sourceFileName: string | null }
    | { kind: 'generated'; bindingId: string; configNodeId: string; outputIndex: number }
    | { kind: 'import' };
}
```

不变量：

1. 节点只持久化稳定 `assetId`，不持久化 `blob:` URL 或临时 data URL。
2. `AssetRepository` 根据 `assetId` 返回原图、预览图和元信息；节点渲染不直接操作 IndexedDB。
3. 上传先显示对象 URL，再以同一节点 ID 替换为稳定资源；替换不造成尺寸跳变。
4. 图片节点按原始比例计算初始尺寸；用户调整尺寸后 `isSizeManuallyAdjusted` 锁定自动尺寸。
5. 缩放较小时优先预览资源，模型输入、下载和导出使用原始资源。
6. 生图占位节点允许 `assetId: null`；其 pending/error/success 从 `CanvasJobBinding` 派生。
7. 生成结果不得改写上传图或已有生成图。

### 5.4 `config` 节点契约

```ts
interface ImageConfigNodeData {
  schemaVersion: 1;
  prompt: string;
  model: { providerId: string; modelId: string };
  size: '0.5K' | '1K' | '2K' | '4K';
  outputCount: 1 | 2 | 4;
  requestAspectRatio: 'auto' | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '21:9';
  extraParams: Record<string, unknown>;
  isSizeManuallyAdjusted: boolean;
}
```

不变量：

1. `config` 只表示图片生成配置，不保存生成图片 URL。
2. 有效提示词是按用户顺序排列的上游有效文字，随后追加本地 `prompt`，各段以空行分隔。
3. 图片输入按独立顺序传给模型。提示词中的图片引用 token 必须在同一个输入快照上解析。
4. 点击生成时一次性保存文字、图片、模型、比例、尺寸、数量和参数快照；运行期间的编辑不改变已提交任务。
5. 输出数量只接受 `1 | 2 | 4`。一张位于批次原点，两张横向排列，四张按 2x2 阅读顺序排列。
6. 每个输出槽立即创建一个 `image` 占位节点；各任务独立结算，先完成的槽先显示。
7. 一次失败只影响对应槽；listener 异常不能把已成功提交的任务改成失败。
8. 再次生成创建新批次和新结果节点，保留旧结果。

### 5.5 连线契约

```ts
type CanvasValueType = 'text' | 'image';
type CanvasConnectionKind = 'data' | 'result';

interface CanvasConnection {
  id: string;
  kind: CanvasConnectionKind;
  fromNodeId: string;
  fromPort: string;
  toNodeId: string;
  toPort: string;
  valueType: CanvasValueType;
  inputOrder: number;
}
```

| 来源 | 目标 | kind | valueType | 是否允许手动/Agent 直连 |
| --- | --- | --- | --- | --- |
| `text.output` | `text.input` | `data` | `text` | 允许 |
| `image.output` | `text.input` | `data` | `image` | 允许 |
| `text.output` | `config.input` | `data` | `text` | 允许 |
| `image.output` | `config.input` | `data` | `image` | 允许 |
| `config.output` | `image.origin` | `result` | `image` | 只允许 `ImageGenerationModule` 创建 |

连接不变量：

- 禁止自连、重复边和有向环。
- `inputOrder` 在每个目标节点的每种 `valueType` 内独立、连续、稳定；删除或重排后统一归一化。
- `result` 边用于来源追踪，不会让图片节点再次消费图片。
- 拉线创建菜单完全由 `NodeCatalog` 的 ports 推导，不在 UI 写节点白名单。
- Agent 不能伪造 `result` 边或生成来源。

### 5.6 Lumina 语义映射

| Lumina 类型 | 新类型 | 迁移语义 |
| --- | --- | --- |
| `textGenerationNode` | `text` | 原样保留 `inputText`、`generatedText`、模型选择和手工尺寸标记 |
| `textAnnotationNode` | `text` | `content -> inputText`，`generatedText = null` |
| `uploadNode` | `image` | `origin.kind = upload`，媒体进入 `AssetRepository` |
| `exportImageNode` | `image` | `origin.kind = generated/import`，按可追溯信息决定；没有可靠来源时使用 `import` |
| `imageNode` | `config` | 保留 prompt、模型、尺寸、数量、比例和参数；已有结果拆为独立 `image` 并增加 `result` 边 |

这张表是语义设计参考，不代表 P0 必须实现 Lumina SQLite importer。

## 6. 目标模块与接缝

目标依赖方向：

```text
节点 UI / 画布手势 / Agent Adapter
                |
                v
        CanvasCommandModule
          |             |
          v             v
      NodeCatalog   ProjectRepository
          ^
          |
 TextGenerationModule   ImageGenerationModule
          |                    |
          v                    v
   TextModelGateway      ImageModelGateway
                               |
                               v
                        AssetRepository
```

### 6.1 `NodeCatalog`

这是节点定义的唯一真相源。它以很小的 Interface 隐藏默认值、schema、菜单、尺寸、ports、能力和不同 actor 的字段写权限，从而为 UI、连接校验、导入和 Agent 提供杠杆率与局部性。

建议 Interface：

```ts
interface NodeCatalog {
  list(options?: { creatableOnly?: boolean }): readonly NodeDefinition[];
  get<T extends CoreNodeType>(type: T): NodeDefinition<T>;
  create<T extends CoreNodeType>(input: CreateNodeInput<T>): CanvasNodeOf<T>;
}
```

`NodeDefinition` 内部至少包含 Zod schema、默认数据、默认尺寸、ports、菜单信息、可手动调整尺寸策略、资源输出函数和 `user/internal-agent/external-agent/system` 字段 allowlist。调用方不得重复这些规则。

### 6.2 `CanvasCommandModule`

这是所有画布语义写入的唯一 Seam。用户高频拖动可在运行时 Store 中预览，但拖动结束必须通过该模块提交最终位置。

建议 Interface：

```ts
interface CanvasCommandModule {
  inspect(changeSet: CanvasChangeSet): CommandInspection;
  commit(changeSet: CanvasChangeSet): Promise<CommandCommitResult>;
  undo(changeSetId: string): Promise<CommandCommitResult>;
}
```

`CanvasChangeSet` 至少包含：

- `id`：幂等键。
- `projectId`。
- `actor: 'user' | 'internal-agent' | 'external-agent' | 'system'`。
- `expectedRevision`。
- `turnId` 或 `interactionId`。
- `operations`。
- 可读的 `reason`。

`commit` 必须先完整校验，再一次性应用；任意 operation 失败时不得部分落地。校验范围包括 schema、节点存在性、字段 allowlist、port、value type、输入顺序、环、revision、Agent 审批票据和生成来源权限。成功后 revision 单调递增，并生成一条可整批撤销的历史记录。

### 6.3 `TextGenerationModule`

建议 Interface：

```ts
interface TextGenerationModule {
  resolveInputs(nodeId: string): ResolvedTextInputs;
  run(nodeId: string): Promise<TextRunHandle>;
  stop(nodeId: string): void;
  polish(nodeId: string): Promise<void>;
}
```

模块内部持有 run token、AbortController、输入快照和迟到结果防护。UI 只展示状态并调用 Interface；provider Adapter 不直接改节点。

### 6.4 `ImageGenerationModule`

建议 Interface：

```ts
interface ImageGenerationModule {
  start(configNodeId: string): Promise<CanvasJobBatch>;
  cancel(bindingId: string): Promise<void>;
  retry(bindingId: string): Promise<void>;
  resumePending(projectId: string): Promise<void>;
}
```

模块内部完成输入解析、快照、占位节点布局、provider submit/poll/result、资源落库、槽位结算、失联识别和迟到结果拒收。UI、内置 Agent 和 MCP 都不能自行拼装这些步骤。

### 6.5 基础设施 Interface 与 Adapter

以下 Seam 均存在至少两个真实 Adapter，因此值得保留：

| Interface | Adapter 1 | Adapter 2 |
| --- | --- | --- |
| `ProjectRepository` | IndexedDB/localForage | 内存 fake，用于测试 |
| `AssetRepository` | IndexedDB Blob store | 内存 fake，用于测试 |
| `TextModelGateway` | 浏览器直连 provider | companion 代理 provider |
| `ImageModelGateway` | 浏览器 submit/poll adapter | companion 代理 adapter |
| `AgentGateway` | 浏览器内置 Agent | MCP companion bridge |

凭据只存在全局配置中；节点只保存 provider/model ID。项目导出、Agent snapshot、日志和错误详情均不得包含 API key。

## 7. 视觉保留矩阵

| 区域 | 必须保留的 Lumina 规则 | 目标实现 | 验收证据 |
| --- | --- | --- | --- |
| 字体 | `Geist Variable`，中文回退 `Noto Sans SC/PingFang SC`；等宽使用 Geist Mono | 在全局 token 一次声明，不在节点重复字体 | computed style + 中英文截图 |
| 画布 | 暗色 `#030303`；点/线网格低对比，不抢内容 | 改 Infinite Canvas theme token，不重写几何 | 空画布基线截图 |
| 主表面 | 暗色 `#18181b`，抬升层 `#202024`，输入层 `#111113` | 统一 surface token | token 单测或静态检查 |
| 强调色 | `#9de500`，前景 `#09090b` | 只用于主操作、当前工具、选中态和焦点 | 色值检查 + 截图 |
| 边与端口 | 边/端口紫色 `#7c3aed`；端口 20px、3px 白边、轻阴影 | 复用自研 canvas handle，hover/连线时显示 | hover 与连线截图 |
| 节点表面 | 默认强边框；选中为细荧光绿边框和克制 glow | `border-accent` + `--node-selected-shadow` | 未选中/选中截图 |
| 圆角 | 控件 8px，panel/node 10px；不使用大胶囊卡片 | 统一 radius token | CSS 扫描 |
| 顶栏 | 安静、紧凑、约 40px 高；项目名是主信息，工具为图标 | 适配 Web 导航，保留信息层级 | 1200/1440/1920 截图 |
| 底部工具栏 | 画布底部居中浮动，熟悉操作用 Lucide 图标，当前模式用绿底 | 保留 Infinite 手势，替换视觉和布局 | 各模式截图和交互测试 |
| 节点控件 | footer 32px；chip/主按钮高 24px；图标按钮 24x24；字号 11px；图标 12px | 迁移为共享 node-control token | 三类节点同屏截图 |
| 节点工具栏 | 选中节点上方居中，offset 16px；拖动和缩放时随节点 | 用 Infinite 几何坐标投影，不用固定屏幕坐标 | 拖动视频/截图序列 |
| 菜单 | 暗色紧凑分组、禁用态明确、危险操作红色；复制/生成副本/粘贴/删除语义保留 | 统一 menu primitive | 右键菜单截图 |
| 状态 | loading、error、disabled 不改变节点外框尺寸；错误详情按需展开 | 稳定 min/max 尺寸与内部滚动 | 状态矩阵截图 |
| 动效 | 打开/关闭有短过渡；尊重 `prefers-reduced-motion` | CSS/motion token | reduced-motion E2E |
| 亮色 | 亮色仍使用同一层级与绿色强调，文字和边框可读 | 保留主题切换 | WCAG 对比检查 + 截图 |

视觉回归固定 viewport：`1200x845`（对照现有图）、`1440x900`、`1920x1080`、`1024x768`、`390x844`。桌面图的最大差异比例建议先设 `0.02`，稳定后收紧；窄屏以无重叠、可关闭 panel 和可回到画布为硬门槛。

## 8. 交互保留矩阵

| 场景 | 必须行为 |
| --- | --- |
| 画布模式 | 平移与选择是明确模式；底栏状态与光标一致；按空格临时平移时不改持久模式 |
| 节点选择 | 单击单选、修饰键追加、框选多选；点击空白清除；输入控件点击不触发画布选择副作用 |
| 拖动 | 拖动中只更新内存和视觉，不写盘、不追加历史；结束时提交一次位置和一次历史 |
| 尺寸 | 调整尺寸不抖动；文字节点遵守动态最小值；图片保持比例；手工尺寸锁定自动尺寸 |
| 复制 | 复制/生成副本产生新 ID；复制业务数据，不复制运行 token、任务归属或对象 URL |
| 右键菜单 | 节点菜单保留复制、生成副本、粘贴可用性和删除；键盘操作与菜单结果一致 |
| 粘贴图片 | 画布未处于文字输入时，剪贴板图片在指针附近创建 `image`；输入态仍执行文字粘贴 |
| 连线 | 端口 hover 出现；拖线预览稳定；空白释放时按 Registry 推导候选；非法连接有明确反馈 |
| 输入顺序 | 文字和图片分别排序；新输入追加；重排后提示词和 provider payload 使用相同快照 |
| 文字输入 | 中文/日文 IME 组合期间只更新本地 draft；composition end 或 blur 才提交；Delete/Space 等画布快捷键被抑制 |
| 文字生成 | 有效输入与模型可用时才可运行；运行时按钮变停止；停止后迟到结果丢弃；失败保留旧结果 |
| 文字润色 | 只改本地 `inputText`，不改上游上下文和已有 `generatedText`；进行中有独立状态 |
| 图片上传 | click/drop/paste 都进入同一上传流程；立即预览；失败显示可重试错误；成功后不闪回空状态 |
| 图片显示 | zoom-out 用预览、处理与下载用原图；资源缺失显示可识别错误，不无限 loading |
| 图片生成 | 点击生成冻结快照、立即创建 1/2/4 槽位；独立结算；旧结果保留；取消/重试不重复建槽 |
| 撤销 | 用户操作按交互撤销；一个 Agent `CanvasChangeSet` 一步撤销；撤销不删除外部 provider 已生成的资产 Blob，资源清理由引用扫描决定 |
| 持久化 | 项目内容防抖 + idle 保存；viewport 独立轻量保存；刷新恢复上次 viewport；微小缩放抖动不写盘 |
| Agent 引用 | 只有用户明确选择/附加的节点属于该回合上下文；同项目会话不泄漏其他项目引用 |
| Agent 写入 | 先展示变更摘要和审批要求，再原子提交；revision 过期时整批拒绝并要求重新读取 |

## 9. Agent 操作安全模型

### 9.1 命令能力分级

| 能力 | 内置 Agent | 外部 MCP Agent | 规则 |
| --- | --- | --- | --- |
| 读取项目/选择 | 自动 | 自动 | 返回经过裁剪的领域 DTO，不返回凭据、Blob URL 或内部对象 |
| 选择/视口 | 自动 | 自动 | 不改变业务数据，但仍校验 project/client 绑定 |
| 创建、移动、缩放 | 可按当前回合批准策略执行 | 默认预览后执行 | 只允许 Registry 声明字段 |
| 修改文字/提示词/生成参数 | 可按当前回合批准策略执行 | 默认预览后执行 | 只允许用户可编辑字段 |
| 普通 data 连线 | 可执行 | 默认预览后执行 | 必须通过 typed ports、顺序和环校验 |
| 删除节点/边 | 明确批准 | 明确批准 | 摘要必须列出数量和受影响连接 |
| 调用模型/产生费用 | 明确意图或批准 | 明确批准 | 经 `TextGenerationModule`/`ImageGenerationModule` 执行 |
| 写 asset、job、origin、result edge、run state | 禁止 | 禁止 | 只允许 system actor |

“明确意图”只覆盖当前回合中用户直接要求的对应生成，不是永久授权。审批票据必须绑定 `changeSetId + expectedRevision + operation digest`，画布变化后不能复用。

### 9.2 内置 Agent

保留 Infinite Canvas 的浏览器 Agent panel 与流式会话体验，但把它降为 `AgentGateway` 的一个 Adapter：

1. Gateway 接收用户正文、显式画布引用、当前项目 ID 和可用工具描述。
2. 全图 Snapshot 只暴露节点 ID、类型、标题、几何、连接、选择和 viewport；节点正文、提示词、模型输入与图片内容只对本回合显式引用或本回合新建的节点开放，长文本与图片使用受控 resource reference。
3. 模型产生 typed tool call；Adapter 将其转换为 `CanvasChangeSet`。
4. `inspect` 返回人类可读 diff、风险级别和审批需求。
5. 获得批准后 `commit`；成功结果写入当前 Agent 回合，失败保留结构化错误。
6. 回合取消会停止流式模型调用并使未提交工具调用失效，不回滚已经批准并提交的更早 change set。
7. 会话按项目隔离；切换项目不能沿用节点引用。

### 9.3 外部 MCP Agent

保留 `canvas-agent` Node package 的 stdio MCP、浏览器会话绑定、Codex history 和多标签页机制，但发布 v2 画布工具契约：

- `canvas_get_state`：返回经过裁剪的全图拓扑，不返回未显式引用节点的正文或媒体内容。
- `canvas_get_selection`：返回当前显式选择节点的安全业务字段。
- `canvas_inspect_changeset`
- `canvas_commit_changeset`
- `canvas_undo_changeset`
- `canvas_run_text_generation`
- `canvas_run_image_generation`
- `canvas_get_generation_status`

现有 convenience tools 可以保留为内部映射，但最终必须生成同一种 `CanvasChangeSet`。废止接收任意 `Record<string, unknown>` 的 `canvas_update_node` 和任意 `metadata` patch。

P0 连接拓扑：

```text
Codex MCP client
      | stdio
      v
canvas-agent companion
      | same-origin HTTP/WebSocket + session token
      v
companion 托管的 Lumina Web build
      |
      v
CanvasCommandModule
```

companion 必须同时托管静态 Web build 或提供同源反向代理，避免依赖远程 HTTPS 页面访问 `ws://localhost`。纯静态部署继续支持手工画布与内置 Agent；外部 MCP 入口显示为不可用并说明需要 companion 模式。

安全要求：

- companion 启动时生成高熵 token；token 不出现在 URL、日志或 Agent snapshot。
- 限制 Origin、Host、请求体大小和消息频率。
- 写请求绑定准确的 `clientId/projectId/revision`；绑定标签页断开时不得回退写入另一个标签页。
- 读请求可以按产品规则回退到最近活动页，写请求必须保持 turn 绑定。
- Agent 看到的是 asset descriptor；图片二进制只通过显式、限量、可审计的 resource 读取。
- MCP server 不能读取任意本地文件，也不能把网页 provider key 转发给 Codex。

## 10. 本地存储与模型执行

### 10.1 存储

建议 IndexedDB stores：

| Store | 内容 | 规则 |
| --- | --- | --- |
| `projects` | nodes、connections、viewport、revision、history、schemaVersion | 每项目一个权威快照；业务变更原子替换 |
| `assets` | 原始 Blob、预览 Blob、尺寸、MIME、字节数、校验信息 | 只由 `AssetRepository` 读写 |
| `generation_jobs` | `CanvasJobBinding`、provider task ID、输入快照 hash、槽位、状态 | 用于刷新恢复、重试和失联判定 |
| `agent_sessions` | 项目内会话和变更集引用 | 不保存模型凭据 |
| `settings` | 主题、provider 配置、模型目录 | 与项目导出隔离 |

持久化规则：

- 每份项目数据带 `schemaVersion` 和单调 `revision`。
- 未知未来版本只读打开或拒绝，不得静默覆盖。
- viewport 使用独立 debounce 与 epsilon；节点拖动结束才提交项目快照。
- 对象 URL 有明确生命周期，替换/卸载时 revoke。
- 资源清理由全项目、job 和 Agent message 引用扫描驱动；不因撤销节点立即删除 Blob。
- 项目导出包含 manifest、项目 JSON 和引用资源；不包含 API key、对象 URL、运行中 controller 和 Agent companion token。
- 导入先校验 manifest/schema/资源 hash，再以新项目 ID 原子写入；失败不留下半个项目。

### 10.2 模型执行

- `TextModelGateway` 与 `ImageModelGateway` 接收纯 DTO 和 `AbortSignal`，返回纯结果或 typed error。
- provider/model registry 是能力真相源；UI 不根据 model ID 猜能力。
- 节点只保存 provider/model ID，运行时从全局设置解析 base URL、key 和模型约束。
- 图片模型统一支持 `submit -> poll -> result`。同步 provider 由 Adapter 在内部模拟为立即完成的 task。
- provider 支持恢复时，刷新后按 task ID 恢复；不支持时标记失联并提供显式重试。
- 失联或已取消任务的迟到结果只进入资源/日志隔离区，不自动写入画布。
- 浏览器直连 Adapter 只对通过 CORS 和安全验证的 provider 启用；其他 provider 走 companion 代理 Adapter。
- 错误对用户显示简洁文案，详情可展开；日志清除 key、Authorization、完整 data URL 和敏感查询参数。

## 11. 分阶段实施

### Phase 0：冻结来源与建立可运行基线

**目标文件：**

- 根 `LICENSE`、`NOTICE.md`、`AGENTS.md`、`CONTEXT.md`
- `docs/reference/lumina/*`
- `docs/adr/0001-infinite-canvas-base.md`
- `docs/adr/0002-local-first-web-and-companion.md`
- `web/package.json`、`canvas-agent/package.json` 及 lockfile

**步骤：**

1. 从固定 commit 创建新仓库，保留 MIT LICENSE、原作者信息和必要前端标识；记录 upstream remote。
2. 创建 `upstream/infinite-canvas-v0.15.1` tag 或等价不可变引用。
3. 固定 Lumina 源快照，把三张视觉基线图复制进 `docs/reference/lumina/`。
4. 把 Lumina `CONTEXT.md` 中本范围领域语言迁入新项目；删除视频/分镜等不适用段落，保留 Agent、文字和图片术语。
5. 统一 npm lockfile；分别在 `web/` 和 `canvas-agent/` 执行干净安装。
6. 不改业务代码，记录基线构建、类型检查、Agent 测试和手工打开画布结果。

**退出条件：**

- `git rev-parse HEAD` 的上游父提交可追溯到指定 commit。
- `cd web && npm ci && npm run typecheck && npm run build` 通过。
- `cd canvas-agent && npm ci && npm test && npm run build` 通过。
- 三张参考图、两份 ADR、LICENSE/NOTICE 和基线验证记录均已提交。

### Phase 1：建立行为与视觉特征测试

**目标文件：**

- `web/vitest.config.ts`
- `web/playwright.config.ts`
- `web/src/test/*`
- `web/e2e/baseline/*`
- `web/e2e/visual/*`

**步骤：**

1. 为 `web` 增加 Vitest、Testing Library、user-event、jsdom 和 Playwright，增加 `test`、`test:watch`、`test:e2e`、`test:visual` scripts。
2. 给现有画布写最小特征测试：创建节点、选择、拖动结束提交、缩放、连接、撤销、持久化恢复。
3. 建立固定数据 fixture：空画布、三节点工作流、文字运行各状态、1/2/4 图片输出、Agent change set。
4. 对 Lumina 参考场景建立 Playwright 页面和截图断言，先允许基线失败并明确差异，不把 Infinite Canvas 当前视觉误设为目标。
5. 配置浏览器 console error、unhandled rejection 和 React warning 为测试失败。

**退出条件：**

- 新测试可以在故意破坏选择或连接时变红。
- `npm run test` 与现有基线行为测试通过。
- `npm run test:e2e` 在 Chromium 至少通过一条空画布和一条三节点主路径。
- 视觉测试已纳入脚本，报告明确显示“当前实现与 Lumina 目标不同”，而不是缺少基线。

### Phase 2：建立 typed node domain 与 `NodeCatalog`

**目标文件：**

- `web/src/features/canvas/domain/canvas-node.ts`
- `web/src/features/canvas/domain/canvas-connection.ts`
- `web/src/features/canvas/domain/node-catalog.ts`
- `web/src/features/canvas/domain/node-catalog.test.ts`
- 修改 `web/src/types/canvas.ts`
- 修改 `web/src/lib/canvas/node-registry.ts`
- 修改创建菜单和 node factory

**步骤：**

1. 先为三类节点默认数据、schema 校验、port matrix、输入顺序和 actor allowlist 写测试。
2. 实现 discriminated union，消除核心节点的任意 `metadata` 写入；插件节点继续走隔离的 plugin payload。
3. 实现 `NodeCatalog`，让默认值、菜单、尺寸、连接、能力和权限只有一个声明位置。
4. 只在创建菜单展示 `text/image/config`；先隐藏 video/audio/group 旧类型，保留只读 migration 识别。
5. 把 factory、菜单、minimap 和 renderer lookup 改为调用 Catalog。
6. 增加 schema version 和从 Infinite Canvas v0.15.1 通用 metadata 到三类 typed data 的最小 migration。

**退出条件：**

- 搜索核心路径不存在 UI 手写的 `['text', 'image', 'config']` 候选白名单，唯一集合位于 Catalog/domain。
- 非法字段、非法 port、非法 value type、重复边、自连和环均有红绿测试。
- 创建菜单只能创建三类核心节点；旧项目样例不会因 migration 崩溃或被静默覆盖。
- `npm run test && npm run typecheck && npm run build` 通过。

### Phase 3：建立 `CanvasCommandModule` 并收口写入

**目标文件：**

- `web/src/features/canvas/application/canvas-command-module.ts`
- `web/src/features/canvas/application/canvas-change-set.ts`
- `web/src/features/canvas/application/canvas-command-module.test.ts`
- `web/src/features/canvas/application/canvas-history.ts`
- 修改 canvas Store、`project.tsx`、Agent bridge

**步骤：**

1. 先写原子性、revision、幂等、权限、连接、批量撤销和失败不改状态测试。
2. 实现 `inspect/commit/undo`，把 validation、reducer、history 和 persistence trigger 隐藏在模块内部。
3. 将创建、删除、复制、连接、最终 move/resize、节点业务 patch、选择和 viewport 逐类迁入命令。
4. 拖动/缩放中的帧级预览保留在临时 Store；pointer up 只提交一次命令。
5. 把 `use-agent-bridge.ts` 改成 Adapter，只能调用 Command Interface。
6. 从 `project.tsx` 抽出已经形成真实 Seam 的 command wiring 和 history；不做与本阶段无关的 UI 重写。

**退出条件：**

- Agent 和 UI 的业务写入路径都能追踪到 `CanvasCommandModule.commit`。
- 故意让批次最后一个 operation 非法时，前面的 operation 一个也不落地。
- 同一 change set 重放不重复创建节点；过期 revision 整批失败。
- 一个 Agent change set 恰好一步撤销；用户拖动恰好一步撤销。
- 200 次 drag preview 不触发持久化，drag end 只触发一次。

### Phase 4：建立存储、资源和模型 Adapter

**目标文件：**

- `web/src/features/projects/infrastructure/indexeddb-project-repository.ts`
- `web/src/features/assets/application/asset-repository.ts`
- `web/src/features/assets/infrastructure/indexeddb-asset-repository.ts`
- `web/src/features/models/domain/*`
- `web/src/features/models/infrastructure/browser-*`
- `web/src/features/models/infrastructure/companion-*`
- 相邻 contract tests

**步骤：**

1. 为 Project、Asset、TextModel、ImageModel Interface 写内存 fake 和共享 contract tests。
2. 把现有 localForage 项目/图片逻辑收进 Adapter，节点只处理 `assetId`。
3. 实现 schema migration、未知版本保护、原子项目导入、资源引用扫描和对象 URL 生命周期。
4. 从 Lumina 模型定义迁移“能力声明 + 请求映射”，去除 Tauri 命令和 Rust 类型。
5. 实现 browser direct 和 companion proxy 两类 provider Adapter；错误统一为 typed error。
6. 将 provider key 与项目数据、日志、Agent DTO 和导出包隔离。

**退出条件：**

- 两个 Repository 的同一 contract test 同时通过 IndexedDB Adapter 与内存 fake。
- 刷新后项目、viewport 和图片恢复；持久化 JSON 中不存在 `blob:` URL。
- 未知 schemaVersion 不会被覆盖；损坏导入不留下项目或孤立资源。
- provider request snapshot 测试确认模型参数与 UI 选择一致，日志快照不含 key。

### Phase 5：移植 Lumina 画布外壳与共享视觉

**目标文件：**

- `web/src/index.css` 或现有全局主题文件
- `web/src/features/canvas/ui/canvas-shell.tsx`
- `web/src/features/canvas/ui/canvas-bottom-toolbar.tsx`
- `web/src/features/canvas/ui/node-control-styles.ts`
- `web/src/features/canvas/ui/node-toolbar-config.ts`
- `web/src/features/canvas/ui/node-context-menu.tsx`
- 修改 `project.tsx`、theme 和 shared primitives

**步骤：**

1. 迁移第 7 节 token，优先改全局 token，不在各节点散落颜色和尺寸。
2. 保留 Infinite Canvas 手势实现，替换顶栏、画布背景、底部工具栏、菜单、tooltip、selection 和 handle 的视觉。
3. 建立共享节点表面、footer、chip、按钮、toolbar offset 和状态样式。
4. 同时实现暗色和亮色；所有按钮使用 Lucide，未知图标带 tooltip。
5. 修复 5 个固定 viewport 的文本溢出、panel 遮挡和 z-index。
6. 在 reduced-motion 下关闭非必要动画。

**退出条件：**

- 空画布和选中文字节点在 `1200x845` 与三张 Lumina 图的结构、色彩和密度一致，visual diff 达到约定阈值。
- CSS 扫描确认核心色值/尺寸由 token 提供，节点文件无新的重复样式常量。
- 顶栏、底栏、菜单、tooltip、节点工具栏在五个 viewport 无重叠。
- 平移、选择、缩放、框选和键盘操作的 Phase 1 特征测试仍通过。

### Phase 6：实现 `image` 节点与上传链路

**目标文件：**

- `web/src/features/canvas/nodes/image-node.tsx`
- `web/src/features/assets/application/image-upload.ts`
- `web/src/features/canvas/application/image-node-sizing.ts`
- `web/src/features/canvas/application/image-node-sizing.test.ts`
- 上传和渲染 UI tests

**步骤：**

1. 移植 Lumina `imageNodeSizing` 规则和方形/横图/竖图测试。
2. 把 click/drop/paste 统一到一个上传用例，先创建/更新预览，再落 `AssetRepository`。
3. 实现原图与 preview variant 选择、加载、缺失、失败、重试和下载状态。
4. 实现等比 resize、手工尺寸锁定、选中边框、端口和上方工具栏。
5. 保证复制图片节点复用不可变 asset，而删除节点不立即删除仍被引用的 asset。
6. 为超大图片加入解码/预览上限和 object URL revoke 验证。

**退出条件：**

- click、drop、paste 三条路径产出相同领域数据。
- 即时预览替换为持久资源时，节点 ID、中心点和可见尺寸不变。
- 刷新、复制、下载、删除/撤销、缺失资源和超大图片路径均有测试。
- 100 个图片节点下缩放不会反复读取原始 Blob 或产生持续增长的对象 URL。

### Phase 7：实现 `text` 节点与文字生成

**目标文件：**

- `web/src/features/canvas/nodes/text-node.tsx`
- `web/src/features/canvas/nodes/text-upstream-context.tsx`
- `web/src/features/canvas/application/text-generation-inputs.ts`
- `web/src/features/canvas/application/text-generation-run.ts`
- `web/src/features/canvas/application/text-generation-layout.ts`
- `web/src/features/canvas/application/composition-input-state.ts`
- `web/src/features/canvas/application/text-generation-module.ts`
- 对应 Lumina 行为测试的 Web 版本

**步骤：**

1. 逐条迁移 Lumina 现有纯测试，测试命名与业务意图保持对应；不要先复制 React 组件。
2. 实现有效文本、上游文字/图片独立顺序、空输入可管理和 rerun 不回灌旧结果。
3. 实现 `TextGenerationModule` 的单 run、输入快照、停止、迟到结果防护和错误保留。
4. 实现 IME-safe 的 input/result 编辑，blur during composition 也能提交最终值。
5. 移植上游上下文预览、本地输入、结果区、模型/思考等级、润色、生成/停止和紧凑错误详情。
6. 移植动态布局：可选上下文只增加高度，不扩大默认宽度；手工尺寸在动态最小值之上得到保留。
7. 使用全局文本 provider 配置；节点只保存 provider/model/reasoning ID。

**退出条件：**

- Lumina 下列行为测试全部在新项目有等价测试并通过：有效文本、ordered composition、空来源、rerun、图片顺序、reference materialization、单 run、停止迟到结果、旧/新 run 竞争、空响应/失败、IME、布局 min/max。
- 中文 IME 输入时 Space/Delete/Cmd+A 不误触画布命令。
- 生成、停止、润色、失败和结果人工编辑 E2E 通过。
- 三种尺寸节点的 toolbar 始终居中并跟随拖动。

### Phase 8：实现 `config` 节点与图片生成深模块

**目标文件：**

- `web/src/features/canvas/nodes/image-config-node.tsx`
- `web/src/features/canvas/application/image-generation-module.ts`
- `web/src/features/canvas/application/image-generation-inputs.ts`
- `web/src/features/canvas/application/image-reference-prompt.ts`
- `web/src/features/canvas/application/image-output-batch.ts`
- `web/src/features/canvas/application/generation-job-batch.ts`
- `web/src/features/canvas/domain/canvas-job-binding.ts`
- 对应 tests

**步骤：**

1. 迁移 Lumina reference token、输出布局和并发 job batch 测试。
2. 实现上游文字/图片解析和可见重排；prompt token 以节点 ID 保持身份，序号随当前顺序更新。
3. 实现 config UI：本地提示词、模型、尺寸、比例、数量、润色、生成/停止和错误。
4. `start` 先冻结输入快照，再用一个 system change set 原子创建 1/2/4 占位 `image` 与 `result` 边。
5. 每个槽独立 submit/poll/result；成功先落 AssetRepository，再通过 system command 绑定 `assetId`。
6. 实现取消、重试、刷新恢复、失联和迟到结果隔离；重试复用原槽位，不重复建节点。
7. 再次生成创建新 batch；原输入和历史结果保持不变。

**退出条件：**

- 1/2/4 输出位置和连接阅读顺序与 Lumina 测试一致。
- 第二个任务先完成时只更新第二槽；一个失败不阻止其他槽成功。
- 运行中修改 prompt/model/reference 不改变已提交 payload。
- 取消、失败、刷新恢复、不可恢复失联、重试和迟到结果均有集成测试。
- provider 收到的图片顺序与 UI、reference token 展示及快照完全一致。

### Phase 9：接入浏览器内置 Agent

**目标文件：**

- `web/src/features/agent/domain/*`
- `web/src/features/agent/application/agent-gateway.ts`
- `web/src/features/agent/adapters/browser-agent-adapter.ts`
- `web/src/features/agent/ui/*`
- 修改 `use-agent-bridge.ts` 和 Agent stores

**步骤：**

1. 为项目隔离、明确引用、snapshot redaction、tool call、审批、取消和整批撤销写测试。
2. 把现有 Agent panel 接到 `AgentGateway`，保留流式消息、历史和错误恢复体验。
3. 工具描述从 `NodeCatalog` 和 command schema 生成，只暴露三类节点能力。
4. tool call 先进入 `inspect`；UI 展示节点/连接增删改摘要、费用或删除风险和 revision。
5. 批准后提交；revision 冲突时不自动重试写入，先重新读取并让 Agent 重新规划。
6. 将生成工具路由到对应 Generation Module，而不是让 Agent 写 status/result。
7. 会话与项目绑定，切换项目、删除节点和刷新后清理无效引用。

**退出条件：**

- 内置 Agent 能完成“创建文字 -> 创建 config -> 连线 -> 请求生图”的批准流程。
- 未选中的隐式画布内容不进入回合引用 fixture。
- 任意 key、token、Blob URL、data URL 和内部错误栈不出现在 snapshot/历史。
- 删除与生成会要求正确审批；审批后画布变化会使旧票据失效。
- 整个 change set 一步撤销，输入节点和已存资源不被误删。

### Phase 10：收紧并接入外部 MCP Agent

**目标文件：**

- `canvas-agent/src/canvas/schemas.ts`
- `canvas-agent/src/canvas/operations.ts`
- `canvas-agent/src/canvas/types.ts`
- `canvas-agent/src/canvas/session.ts`
- `canvas-agent/src/server/{mcp,http}.ts`
- `canvas-agent/src/web-host/*`
- `web/src/features/agent/adapters/mcp-companion-adapter.ts`
- MCP contract/integration tests

**步骤：**

1. 先为 v2 schema、任意 patch 拒绝、stale revision、准确标签页绑定、断线、幂等和审批写测试。
2. 用 discriminated Zod schema 替换 `recordSchema` 写操作；读 DTO 与 Web domain schema 共享版本号，但避免跨 package 直接引用前端实现。
3. 所有 convenience tool 只构造 change set；最终写请求由 Web `CanvasCommandModule` inspect/commit。
4. companion 增加 Web build 托管或同源代理、token bootstrap、健康检查和连接状态。
5. 保留现有多窗口原则：运行 turn 绑定的写目标断开时失败，不回退到其他活动窗口。
6. 实现 Codex MCP 安装说明和最小配置；工具返回结构化 revision/changeSetId/status。
7. 做一个真实进程 E2E：启动 companion、打开其 Web、用 MCP client 创建三节点工作流、批准、生成 fake 图片、撤销。

**退出条件：**

- `cd canvas-agent && npm test && npm run build` 通过，新增测试覆盖 v2 契约。
- 任意 metadata patch、伪造 asset/origin/result edge、跨项目写和 stale revision 均被拒绝。
- 绑定标签页关闭时写请求明确失败，不修改其他标签页。
- Codex 可通过 MCP 读取当前选择、提交合法 change set、发起一次 fake 生图并一步撤销。
- companion 模式从一条文档命令启动，页面明确显示已连接的 client/project；纯 Web 模式明确显示外部 Agent 不可用。

### Phase 11：导入导出、兼容清理与页面拆分

**目标文件：**

- `web/src/features/projects/application/project-export.ts`
- `web/src/features/projects/application/project-import.ts`
- `web/src/features/projects/infrastructure/migrations/*`
- `web/src/pages/canvas/project.tsx`
- `web/src/components/canvas/canvas-node.tsx`
- 删除或隔离旧 video/audio/group 业务路径

**步骤：**

1. 完成项目包导出/导入、hash 校验、同名策略和未知版本保护。
2. 对 Infinite Canvas v0.15.1 的 `text/image/config` 数据做 fixture migration；video/audio/group 给出明确 unsupported report，不静默丢失。
3. 在三类新节点、Agent 和 generation 全部稳定后，删除已无调用的通用 metadata 和旧生成分支。
4. 按真实 Module Seam 拆分 `project.tsx` 与 `canvas-node.tsx`；页面只负责编排，领域逻辑留在 application/domain。
5. 保留插件 Registry，但核心 Node Catalog 与 plugin payload 分离，插件不能绕过 Command Module 改核心字段。
6. 运行未使用导出、重复样式、硬编码 i18n、旧 node type 和 secret pattern 扫描。

**退出条件：**

- 导出后新浏览器 profile 导入，节点、连接、顺序、viewport、资源和 provenance 一致。
- 不支持类型会得到含节点 ID/类型的报告，原文件不被改写。
- `project.tsx` 与核心 renderer 不再超过项目规定的 1000 行强制线；每个抽出模块职责可用三句话说明。
- `rg` 不再发现生产写路径依赖任意 `CanvasNodeMetadata` 或旧 video/audio generation mode。
- 所有测试、类型检查和 build 通过。

### Phase 12：完整 QA、性能与发布门禁

**目标文件：**

- `web/e2e/*`
- `docs/qa/lumina-web-parity.md`
- `docs/operations/companion.md`
- `docs/architecture/*`
- CI 配置

**步骤：**

1. 跑第 12 节完整测试矩阵，保存命令、commit、浏览器版本和结果。
2. 在五个 viewport、暗/亮主题、中/英文下采集最终截图，与 Lumina 基线逐项走查第 7、8 节矩阵。
3. 用 200 节点混合 fixture 测拖动、平移、缩放、选择和持久化；记录浏览器 Performance trace。
4. 用 fake provider 跑成功、慢响应、部分失败、取消、迟到结果、刷新恢复和失联。
5. 用真实 Codex MCP 跑读、写、审批、生成、冲突和撤销主路径；检查 companion 日志脱敏。
6. 进行存储配额不足、IndexedDB 失败、provider CORS、companion 断线和坏导入包异常走查。
7. 更新架构、数据 schema、Agent 权限、companion 启动、备份恢复和 upstream 同步文档。

**退出条件：**

- 第 13 节 Definition of Done 全部有证据，无“稍后补测”项。
- CI 在干净环境通过 web test/typecheck/build/E2E 和 canvas-agent test/build。
- 最终 parity 文档包含截图、性能数字、剩余差异及其已批准理由。
- 没有 P0/P1 未解决缺陷；任何已接受 P2 都有 issue、owner 和回归测试边界。

## 12. 验证矩阵

### 12.1 自动化层级

| 层级 | 核心验证 |
| --- | --- |
| Domain unit | 节点 schema/defaults、typed ports、顺序、环、有效文本、reference token、尺寸、输出布局 |
| Command unit | 原子性、幂等、revision、allowlist、审批、history、整批撤销 |
| Module integration | text run 竞争、image task batch、取消/迟到、Asset/Project contract、migration |
| UI interaction | IME、输入/结果编辑、按钮状态、菜单、拖放/粘贴、resize、toolbar 跟随 |
| Agent contract | snapshot redaction、明确引用、tool schema、change set inspect/commit、项目隔离 |
| MCP process | stdio -> companion -> browser -> command -> result 的真实进程链路 |
| Playwright E2E | 三节点手工主路径、内置 Agent 主路径、外部 Agent 主路径、刷新恢复、导入导出 |
| Visual regression | 第 7 节全部场景、五 viewport、两主题、两语言、各运行状态 |
| Performance | 200 节点 drag/pan/zoom、图片资源读取、autosave 次数、对象 URL 数量 |
| Security | key/token 脱敏、Origin、跨项目/跨标签页、任意 patch、坏 schema、请求大小限制 |

### 12.2 必须保留的 Lumina 单元测试意图

执行 Agent 不应机械复制测试代码，但必须逐条保留以下业务意图：

- 生成结果作为有效文本，直到显式清除。
- ordered upstream text 与 local input 以空行组合。
- 空连接来源可管理但不进入有效文本。
- rerun 不回灌旧生成结果。
- 图片输入顺序独立且缺失资源可见。
- reference tag 与 provider 图片快照使用同一顺序。
- 单节点一次只允许一个有效 run。
- stop 使迟到结果失效，旧 run 不能覆盖新 run。
- 空响应和失败保留现有结果。
- IME draft 在 composition end/blur 前不提交，画布快捷键被抑制。
- 文字布局覆盖上下文、结果、手工尺寸、min/max。
- reference token 插入/删除/光标移动是原子行为，边删除只清理对应 token。
- 1/2/4 图片输出布局与阅读顺序稳定。
- batch 每个任务独立结算，listener 异常不污染提交状态。
- 图片尺寸对方图、横图、竖图保持可用展示范围。

### 12.3 性能预算

以下为发布门槛，不是实验目标：

- 200 个轻量节点或 100 个图片节点的 fixture 可交互。
- 连续拖动期间不发生项目写盘；结束后 1 次语义提交、至多 1 次防抖项目写入。
- 典型开发机上拖动/平移目标 60fps；若未达成，Performance trace 中不得存在由节点输入解析或持久化造成的连续 `>50ms` long task。
- viewport 微小变化被 epsilon 过滤；连续滚轮缩放不会逐事件写 IndexedDB。
- 屏幕外或低 zoom 图片不解码全尺寸资源；相同 asset 不重复创建未回收对象 URL。
- Agent snapshot 对节点数、文字长度和图片 descriptor 数量设上限，并优先保留显式选择。

## 13. Definition of Done

只有以下项目全部满足，迁移才算完成：

1. 新仓库基线、Lumina 源快照、许可证和 ADR 可追溯。
2. 首屏是可用画布，不是迁移说明或营销页。
3. 创建菜单、连线菜单和 Agent schema 只暴露 `text/image/config` 核心能力。
4. 三类节点数据是 typed union；核心写入不存在任意 metadata patch。
5. `NodeCatalog` 是节点默认值、ports、能力和 Agent 权限的单一真相源。
6. UI、内置 Agent、MCP Agent 都通过 `CanvasCommandModule` 提交语义写入。
7. 文字节点通过第 5.2 节全部不变量和等价 Lumina 测试。
8. 图片节点通过上传、预览、持久化、尺寸、复制、下载和资源生命周期测试。
9. config 节点通过快照、1/2/4 槽位、独立结算、取消、重试、恢复和迟到结果测试。
10. 内置 Agent 可执行经批准的三节点工作流并一步撤销。
11. Codex 可经 MCP companion 执行相同工作流；跨标签页、跨项目和 stale revision 写入被拒绝。
12. API key、companion token、Blob URL、data URL 和内部运行字段不出现在 Agent/导出/日志。
13. 暗/亮、中/英和五 viewport 视觉/布局验收通过，Lumina 核心视觉没有无理由偏差。
14. 项目刷新、导出/导入、未知版本、存储失败和资源缺失均有明确行为。
15. 完整自动化、构建、性能预算和手工异常路径有可复查证据。
16. 旧 video/audio/group 业务入口不再出现在生产 UI 或 Agent 工具中。
17. 架构与 companion 使用文档已更新，下一位 Agent 不需要阅读两个旧代码库才能维护三类核心节点。

## 14. 风险、前置验证与回退点

| 风险 | 最早验证 | 缓解与回退 |
| --- | --- | --- |
| Lumina 源工作区未提交，视觉/行为基线漂移 | Phase 0 | 先冻结源快照；没有快照则停止迁移，不猜测 |
| Infinite Canvas 两个大文件导致改动互相牵连 | Phase 2-3 | 从 Catalog/Command 真正 Seam 渐进抽取；每阶段保持可运行 |
| Typed domain 与插件开放类型冲突 | Phase 2 | 核心 union 与 plugin payload 分层；插件通过 Adapter 接入命令 |
| 浏览器 API CORS 或 key 暴露 | Phase 4 | browser/companion 两 Adapter；不兼容 provider 只启用 companion |
| IndexedDB 多 store 无法跨 store 强事务 | Phase 4 | 项目快照先引用稳定 asset；导入用 staging manifest；启动时 reconcile |
| 大图导致内存和解码抖动 | Phase 6 | preview variant、zoom 选择、对象 URL registry、配额错误测试 |
| 异步任务竞态覆盖新状态 | Phase 7-8 | run/binding token、快照、system command、迟到结果隔离 |
| 视觉移植破坏自研画布命中区 | Phase 5 | 只替换 token/DOM 外壳，保留特征测试；每个视觉提交可独立回退 |
| Agent 任意 patch 破坏 provenance 或任务状态 | Phase 3/9/10 | actor allowlist、typed schema、审批 digest、system-only 字段 |
| 远程 Web 到 localhost 被浏览器拦截 | Phase 10 前 spike | P0 companion 同源托管；远程 loopback 支持另立需求 |
| 上游 Infinite Canvas 更新导致长期 fork 成本 | Phase 0/12 | 固定 upstream tag，保留 NOTICE；功能完成后再按独立 issue 评估升级 |

每个 Phase 的提交都是回退点。进入下一 Phase 前必须保证当前提交可独立构建和打开；不得把跨三个 Phase 才能恢复运行的半成品压入主分支。

## 15. 建议的后续 Agent 启动提示词

```text
请在当前全新仓库中执行《Lumina Web 基于 Infinite Canvas 的迁移开发计划》：

计划文件：docs/plans/2026-08-10-lumina-web-on-infinite-canvas-development-plan.md
Infinite Canvas 基线：v0.15.1 / a2576d559ad765ba83e9563894adfbcd4e63405a
Lumina 源仓库：<填写只读路径或 tag>

先完整阅读计划、根 AGENTS.md、CONTEXT.md 和已有 ADR。严格从当前未完成的最早 Phase 开始，不跨 Phase 实施。业务行为使用测试先行；每完成一个 Phase，运行该 Phase 的全部退出条件，提交代码，并在回复中列出：变更、验证证据、剩余风险、下一 Phase。不得把 Lumina 的 React Flow/Tauri 实现复制为运行时依赖，不得改变计划中的固定决策；如必须偏离，先新增 ADR 并停止等待确认。
```
