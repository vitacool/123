# FrameCut 功能审查：哪些功能「没做好」

- 日期：2026-11-24
- 范围：审查阶段为**只读**静态审查；P1 的修复与验证见 §0.1
- 方式：按 6 个功能域并行读代码（时间轴 / 画面特效 / 导出 / 素材持久化 / 文本字幕 ASR / 音频），关键结论由我逐条回到源码复核
- 局限：本环境里 `vitest` 启动即报 `esbuild spawn EPERM`（沙箱禁止子进程，DIAGNOSIS 里也记过这个环境问题），**因此没有跑测试、也没有开浏览器实机复现**；下面所有结论都是代码证据，行为后果属推断的会单独标注
- 与既有 `DIAGNOSIS-2026-11-23.md` 的关系：那份报告修的是「P0 交互断链 + 导出崩溃分支 + 数据安全」；本文聚焦**功能层面**——功能是否真的可用、是否只做了一半、入口是否通、预览与成片是否一致

---

## 0. 结论（先看这个）

这个项目的**功能覆盖面其实很全**，比 README 的「已知限制」写得还多：多选 + 跨类型框选、片段/属性剪贴板、四参数调色、蒙版、WebGL 抠像、31 种转场、变速曲线、倒放、定格、封面、SRT 导入导出、本地 Whisper、工程文件、宿主 API、导出区间 / 仅音频 / 响度归一化 / ETA / 内存分级——这些都有实际实现，不是壳子。

所以问题不是「缺功能」，而是三类**「功能没做好」**：

1. **只做了一半**：UI/数据模型/持久化都在，但渲染或导出没接上（图片背景、蒙版位置、手动文字）；
2. **两套实现不一致**：预览一套、导出另一套，或「有间隙/无间隙」两条滤镜路径行为不同（背景在有空隙时丢失、抠像预览降级、模糊强度不归一）；
3. **入口不通 / 提示与事实不符**：功能存在但用户在界面上到不了，或被界面文案骗了（叠加片段裁剪、字幕列表、素材重链、保存状态）。

最该先修的是 6 条 P1——它们会让**成片出错**或**白干**，而不是「不够好用」。

---

## 0.1 P1 修复状态（2026-11-24 下午，已落地）

| # | 状态 | 改动 | 回归 |
|---|---|---|---|
| P1-1 有隙丢背景 | ✅ 已修 | gapped 导出路径改用真实背景；补 blur 双分支与蒙版背景色（`core/exportPlan.ts`） | 新增 2 条 `tests/exportPlan.test.ts`（纯色 / 模糊 + gap） |
| P1-2 图片背景 | ✅ 已下线（未实现） | 移除「图片」选项；旧工程 image 归一化为黑场；导出/预览不再出现「预览有、成片黑」 | 更新 `tests/background.test.ts` |
| P1-3 SRT 导入落错轨 | ✅ 已修 | 导入改为建 `kind='caption'` 的「导入字幕」轨，字幕列表 / 导出 SRT / 重新对齐恢复可达 | 新增 1 条 `tests/captionCommands.test.ts` |
| P1-4 分离音频 | ✅ 已修 | 变速片段入口拦截并提示；音量关键帧迁到音频片段、原片段移除（避免双份声音） | 新增 3 条 `tests/clipAudio.test.ts`（关键帧迁移 / 变速拒绝 / store 提示） |
| P1-5 占位片段刷新即丢 | ✅ 已修 | `removeAsset(removeClips:false)` 写入 `missingAssets`；文案改为「刷新后仍保留、可重新链接」 | 扩充 `tests/assetRemoval.test.ts` |
| P1-6 缺失素材无法重链 | ✅ 已修 | 新增重链命令 + store 动作 + 属性面板「重新链接素材…」；主轨/叠加/音频/字幕 link/背景图统一 remap | 新增 `tests/relinkAsset.test.ts`（3 条，含字幕联动不误删） |

**验证**：`tsc -b` 0 错误；全量 `vitest` **1165 passed / 2 skipped**；完整 e2e（Edge）**22 passed**（含真实 FFmpeg 导出的 `import-export`：1.5s / h264 / aac / 34KB，以及主轨旋转、叠加混合、预览导出像素一致性等 5 条 parity）；改动文件 `eslint` 0 error（仅存量 non-null 警告）。

**遗留风险（如实记录）**：gapped 路径的纯色/模糊/蒙版滤镜图只做了单测的字符串断言，没有单独写「带 gap 的真机导出 + 取色」e2e；它的分支结构与无 gap 路径同构，且后者已被 parity e2e 真机验证，但严格来说仍属未逐条实跑。

**P1-2 的取舍（需要知道）**：没有实现「图片背景导出」，而是把入口摘掉并把旧工程按黑场读取——因为它需要额外的 FFmpeg 输入、预览/封面/逐帧烘焙三处图像绘制与持久化改造，属于新功能而非小修。如果确实需要，建议单开一项，按「输入管线 + canvas 背景 + 草稿素材化」三步做。

---

## 0.2 P2 修复状态（进行中，Batch A 已落地）

| # | 状态 | 改动 | 回归 |
|---|---|---|---|
| P2-3 叠加裁剪入口矛盾 | ✅ 已修 | 属性面板不再对叠加片段禁用裁剪，与工具栏/README 一致 | 类型检查 + 完整 e2e |
| P2-15 叠加轨 solo / 音轨音量死 UI | ✅ 已修 | `anySoloActive` 计入叠加轨；音频轨头新增常驻音量滑块（松手才提交，一步撤销）；被 solo 压制的轨道显示抑制态 | 新增 `tests/tracks.test.ts`（叠加轨 solo 压制主轨） |
| P2-16 多轨混音无峰值保护 | ✅ 已修 | `amix` 后接 `alimiter=limit=0.97:level=false`（只限幅、不自动抬响） | 新增限幅断言；真实 ffmpeg 验证滤镜链；快照更新 |
| P2-17 44.1k 素材变速时长/音高错 | ✅ 已修 | `asetrateChain` 先 `aresample=48000` 归一，再改采样率 | `tests/speed.test.ts` 更新 + 全量单测 |
| P2-1 蒙版只能固定居中 | ✅ 已修 | 蒙版面板新增 X/Y/宽/高/旋转（线性蒙版只显示位置与旋转）；渲染侧本来就支持这些参数 | 既有 `tests/mask.test.ts` + 全量单测 |
| P2-10 项目上限只拦“新建” | ✅ 已修 | 导入素材、导入工程、宿主 `loadProject` 都先检查上限并给出可执行提示；`initialVideo` 会话提前警告 | 新增 `tests/projectLimit.test.ts`（宿主 API 达上限拒绝） |
| P2-14 没有保存状态提示 | ✅ 已修 | store 增加 `draftSave` 状态；顶栏显示「未保存 / 保存中 / 已保存 HH:MM / 保存失败」 | 新增 `tests/format.test.ts`（时间格式）+ 全量单测 |
| P2-2 无法手动新建文字 | ❌ **审查误报** | 时间轴顶栏已有「文本」按钮（`addTextAtPlayhead`），会建文本轨并在播放头插入片段。此前只搜了 `addTextTrack`，漏看了真正的入口 | 已在本报告更正 |
| P2-12 字幕工作流断点 | ✅ 已修 | 新增 VTT 导出（`serializeVtt`）；导入先严格 UTF-8、失败回退 GB18030；字幕列表可「+ 新增」；文字属性面板可数值改开始/结束；SRT 加 BOM；导出过滤 `linkHidden` | 新增 `tests/subtitleExport.test.ts`（VTT / GBK）+ `tests/captionAdd.test.ts`（新增 / 锁轨拒绝） |
| P2-7 粘贴目标轨 / 锁轨 / 跨项目 | ✅ 已修 | 先选中目标叠加轨即可跨轨粘贴；原轨锁定且无目标轨时拒绝并提示（不再静默新建轨）；主轨锁定拒绝粘贴；粘贴组保留后续段 `gapBefore`；切项目清空剪贴板 | 新增 2 条 `tests/selection.test.ts` + `tests/clipboardReset.test.ts` |
| P2-13 视频片段没有波形 | ✅ 已修 | 主轨/叠加轨的视频片段在胶片条底部叠一层原声波形；抽了 `samplePeakRange` 纯函数，音频轨也复用同一套采样 | 新增 `tests/audioWaveform.test.ts`（5 条：映射/夹取/非法区间） |
| P2-18 音频交互弱于视频 | ✅ 已修 | 音频拖动复用同一套吸附点（播放头/标记/各轨边缘，12px）；Ctrl/⌘ 切换、Shift 区间多选；属性面板可数值改起点；框选纳入音频/字幕 | 新增 `tests/snap.test.ts`（吸附 + 吸附点集合） |

**Batch C 已完成。** 下一批 Batch D：抠像降级、模糊归一、变速预览、转场、多实例隔离、重链匹配。

### Batch D（2026-11-24 下午）

| # | 状态 | 处理 | 取舍 / 回归 |
|---|---|---|---|
| P2-5 模糊强度不归一 | ✅ 已修 | `blurAmount` 固定按 **1080p 参考高度**换算：预览/截帧/导出按各自高度缩放；540p 减半、4K 翻倍 | `tests/background.test.ts` 新增 3 个高度断言 |
| P2-11 重链只按文件名 | ✅ 已修 | `normalizeAssetName` 剥掉 `-h264/-h265/-hevc` 代理后缀，HEVC 代理也能匹配回原文件（旧工程同样受益） | 新增 `tests/missingAssets.test.ts` 代理名用例 |
| P2-4 抠像预览静默失效 | ✅ 已处理 | WebGL 不可用/上下文丢失时提示一次「预览不可用，导出仍会抠像」，不再静默显示原绿幕 | 取舍：**没做 CPU 逐像素兜底**（每帧全屏 CPU 抠像代价过高） |
| P2-6 变速片段预览静音 | ✅ 已处理 | 保留默认静音（分段/曲线变速无法用单一 `playbackRate` 正确预览，放开会听到错节奏），但在速度面板明确解释原因与“导出有声” | 取舍：未改默认值，改为**说明 + 可手动取消** |
| P2-8 转场只主轨/空隙阻断 | ✅ 部分 | 空隙 + 转场改为**原子操作**（自动闭合，可撤销）；**时间轴转场标记可拖动改时长**（3px 以上算拖动，带跟手气泡，夹到 0.1–2s 与相邻片段上限） | 记录设计边界：叠加轨转场、首段转场仍未做（需改合成链路） |
| P2-9 多实例隔离 | ✅ 已修（保存层） | ① 新增 `persistence="off"`（宿主自管存储，不恢复/不自动保存）；② 同项目跨标签页用 BroadcastChannel 提示；③ **Web Locks `ifAvailable` 独占**：拿不到锁的标签页停止自动保存，顶栏显示「另一页正在编辑 · 不保存」并 toast 说明 | 取舍：不阻止本地编辑（完整只读模式未做）；一个月单测覆盖消息判定与锁状态 |

**当前验证（Round 6 收尾）**：`tsc` 0 错误；全量 `vitest` **1196 passed / 2 skipped**；完整 e2e（Edge）**22 passed**；全仓 `eslint` 0 error（22 条存量 warning）。

---

## 0.3 P3 修复状态（进行中）

| # | 状态 | 处理 | 回归 |
|---|---|---|---|
| P3-9 草稿版本号恒写 1 | ✅ 已修 | `toDraftSnapshot` 写 `DRAFT_SCHEMA_VERSION`（2），未来迁移不再把 v2 当 v1 | 新增 `tests/draftVersion.test.ts` |
| P3-6 最近项目信息不足 | ✅ 已修 | 项目卡片显示总时长、片段数、素材数、缺失数（纯函数从快照算，不读 Blob） | 新增 `tests/projectLibrary.test.ts` 摘要用例 |
| P3-7 缩略图失败无重试 | ✅ 已修 | 素材右键菜单新增「重新生成缩略图」；成功写回素材与主素材 | `tests/assetRemoval.test.ts` 新增 store 更新用例 |
| P3-1 导出画质只有分辨率 | ✅ 已修 | 新增 `tier`（高画质/标准/小体积），按 ±CRF 映射；导出弹窗增加质量档 | `tests/exportPlan.test.ts` 新增 CRF 档位断言 |
| P3-2 片段无键盘微调 | ✅ 已修（微调） | `[`/`]` 逐帧、`{`/`}` 逐秒移动选中片段（可多选批量）；连续按不再弹 toast | 新增 `tests/selection.test.ts` 的 `moveSelectionBy` 用例 |
| P3-5 素材库缺能力 | ✅ 已修 | 右键**重命名 / 移动到文件夹**；重复导入**跳过**；**排序**（导入顺序/名称/时长/大小）；**筛选**（全部/已使用/未使用、文件夹）；文件夹随草稿/工程文件持久化 | `tests/assetFolder.test.ts`、`assetFolderPersist.test.ts`、`assetsDedupe.test.ts`、`assetSort.test.ts`、`assetFilter.test.ts`、重命名/文件夹 store 用例 |
| P3-3 吸附规则不一致 | ✅ 部分 | 拖动片段/裁剪边缘/音频片段时按住 **Alt 临时关闭吸附与主轨磁吸**；磁吸与自动吸附组合仍是设计边界（磁吸负责顺排，自动吸附负责自由定位） | 纯函数吸附测试既有；Alt 行为属手势层 |
| P3-10 文字缺行距/字距/斜体 | ✅ 已修 | `CaptionStyle`/`TextClip` 增加 `lineHeight`/`letterSpacing`/`italic`；预览与导出共用 `drawTextClip`（行距倍数、em 字距、斜体字体）；排版面板可调 | `tests/captionStyle.test.ts` 新增优先级用例 |
| P3-13 波形长素材精度差 | ✅ 已修 | 峰值桶数从固定 600 改为「约 40 桶/秒、上限 12 万」，1 小时素材每桶约 0.09s，短片段不再是一条平线 | `tests/audioWaveform.test.ts` 新增桶数用例 |
| P3-8 紧急快照失败静默 | ✅ 已修 | 写入失败时 `console.warn` + 一次 toast 说明「立即关闭可能丢最后一次编辑」 | 既有 `writeEmergencyDraft` 失败用例覆盖返回语义 |
| P3-12 淡入淡出只有线性 | ✅ 已修 | 新增 `fadeInCurve`/`fadeOutCurve`（linear / exp / log）：预览包络与导出 `afade:curve=` 同一套；视频/音频片段面板均可选；倒放对调、分离音频迁移曲线 | `tests/clipAudio.test.ts`（包络/映射）+ `tests/exportPlan.test.ts`（曲线参数）+ 动画字段表 |
| P3-11 繁简转换写死 | ✅ 已修 | 智能字幕新增「输出字形：简体/繁体/保持原文」；opencc 转换从 worker 硬编码改为显式选项；**ASR 缓存键包含字形变体**，切换不会复用旧结果 | 新增 `tests/scriptConvert.test.ts` + `tests/asr.test.ts` 变体键用例 |
| P3-15 无错误边界 | ✅ 已修（边界） | 新增 `ErrorBoundary`：任一子组件渲染抛错时显示「重新加载」恢复界面并保留错误详情，不再整页白屏 | 新增 `tests/errorBoundary.test.ts`；完整 i18n/文案注入仍未做 |
| P3-14 音频片段能力缺口 | ✅ 已修 | 音频片段新增**变速 0.1–10x（保音高/变调）**；**换素材**；**倒放**（FFmpeg `areverse` 生成整段倒放音频 → 源区间镜像、淡化/曲线对调、音量关键帧镜像）。分割/裁剪/边缘拖动均按倍率换算 | `tests/audio.test.ts` 新增变速、换素材、倒放镜像、导图用例 |
| P3-4 长片时间轴全量渲染 | ✅ 已修 | 主轨/叠加轨/音频/文本轨片段与转场按**视口窗口**（含一屏 overscan）渲染；拖动吸附点在拖拽开始时构建一次，pointermove 不再全量重扫片段/标记 | 新增 `tests/timelineWindow.test.ts`（窗口换算/相交判定） |

**P3 其余待做**：slip/slide/roll、素材库文件夹/筛选、完整文案注入（i18n）。

**P3 + 音频能力 + 长片虚拟化 + 素材库筛选/文件夹验证**：`tsc` 0 错误；全量 `vitest` **1235 passed / 2 skipped**；完整 e2e（Edge）**22 passed**；全仓 `eslint` 0 error（22 条存量 warning）。

**当前验证（Round 3 收尾，Batch C 完成）**：`tsc` 0 错误；全量 `vitest` **1189 passed / 2 skipped**；完整 e2e（Edge）**22 passed**；本批改动 `eslint` 0 error（仅存量警告）。

**当前验证（Batch B 收尾）**：`tsc` 0 错误；全量 `vitest` **1170 passed / 2 skipped**；完整 e2e（Edge）**22 passed**；Batch B 改动 `eslint` 0 error。

---

## 一、P1：会让成片出错 / 工作丢失 / 核心流程断

### P1-1　时间轴一旦有间隙，画布背景（纯色 / 模糊 / 图片）在导出里全部退回黑场

- **场景**：主轨两段之间留了空隙（左裁/右裁、拖动、或本来就有的 `gapBefore`），画布背景设成浅灰或模糊填充；预览一切正常，导出成片是黑底。
- **现状**：`buildFlatExportPlan` 检测到 gap 后走 gapped 分支（`core/exportPlan.ts:981-987`）。该分支把背景硬换成黑场：`needsComposite ? background : { type: 'black' }`（`exportPlan.ts:1339-1347`），并且**完全没有 blur 分支**（对比无间隙路径的 `exportPlan.ts:1105-1125`）；带蒙版/抠像的片段更直接把垫底写成 `color=c=0x000000`（`exportPlan.ts:1361-1363`）。
- **缺口**：同一个工程，仅仅中间多一个空隙，背景就从「有」变「无」；预览始终显示背景（`Preview.tsx:366-391`），属于典型的「界面生效、成片丢」。
- **建议**：删掉 `1345` 的黑场覆盖，统一传 `background`；把无间隙路径的 blur 双分支抽成共用函数给 gapped 路径复用；补一条「有 gap + 纯色/模糊背景」的滤镜图快照测试。
- **置信度**：已复核（两条路径的分支与颜色取值都读过）。

### P1-2　「图片」画布背景是假功能：预览不画、导出黑场、上传图刷新即丢

- **场景**：背景切到「图片」，从素材库选一张图，或直接上传一张图；画布没变化；导出是黑底；刷新后设置变回黑色。
- **现状**：
  - UI 与数据模型完整：`CanvasBackgroundPanel.tsx:117-158`（素材下拉 + 上传），`background.ts:8,39-45`，草稿还会重映射/修剪背景图 URL（`draft.ts:22-24,86-92,386`）。
  - **渲染侧 0 引用**：全仓 `imageUrl` 只出现在 UI/归一化/草稿存取里，`Preview.tsx` 与 `core/exportPlan.ts` 都没有读取它。预览的背景函数只分「black/color 直接填充」与「其余一律用该片段自身画面 cover + blur」（`Preview.tsx:366-391`）——所以「图片」在预览里等于「模糊自己」。
  - 导出侧只有 `background.type === 'blur'` 三处分支（`exportPlan.ts:1057,1105,1399`），image 会落到 `backgroundFfmpegColor` 的 `0x000000`（`background.ts:82-89`）→ 黑场。
  - 上传路径 `URL.createObjectURL(file)` 没有注册成素材、没有 `saveMediaBlob`（`CanvasBackgroundPanel.tsx:146-157`）→ 刷新后 `pruneBackground` 直接回退黑色（`draft.ts:86-92`），且旧 URL 不 revoke。
- **缺口**：这是一个「选项存在但完全不生效」的功能；用户会以为成片有衬底图。
- **建议**：二选一——①真正实现（导出增加 `-loop 1 -i 图` 输入 + scale/crop 铺满 + overlay 垫底；上传图注册为 image 素材并落盘）；②先把该选项在 UI 上禁用并注明未实现。无论哪条，都补一条「图片背景 → 导出帧中心像素」的 e2e。
- **置信度**：已复核。

### P1-3　导入 SRT / VTT 落到「普通文本轨」，字幕列表、导出 SRT、重新对齐全部够不到

- **场景**：空工程 → 工具栏「导入字幕」→ 选 .srt → 想逐条改文本/时间、想导出 SRT，界面却没有这些入口。
- **现状**：
  - 导入取 `project.textTracks?.[0]?.id ?? createId('textTrack')`（`store/slices/editing.ts:1400`），用 `addTextClipToProject` 逐条加（`core/commands.ts:1396-1406`）。
  - `addTextClipToProject` 在轨道不存在时调 `createTextTrack(project, trackId)`（`core/text.ts:341-353`），**不传 kind**；`createTextTrack` 只有传了才写 `track.kind`（`core/text.ts:250-253`）→ 生成「文本轨 1」，kind 为 undefined。
  - 属性面板只有 `kind === 'caption'` 才渲染 `CaptionPanelSwitcher`（`PropertiesPanel.tsx:393-396`），而 `CaptionListPanel` 是**唯一的字幕列表 + 唯一的「导出 SRT」按钮**（`CaptionListPanel.tsx:154`）。
- **后果**：导入的字幕只能一条条点选、在文本属性面板改单条文字；不能列表化编辑、不能导出 SRT、不能「重新对齐」。若工程里恰好已有字幕轨（先跑过智能字幕），则会混进该轨，行为取决于此前状态。
- **建议**：导入改走 `addCaptionTrackWithClips(..., 'caption', '导入字幕')`；已有 caption 轨时给「追加 / 替换 / 新建轨」三选一；`normalizeProject` 里补一次按名/kind 的迁移兜底。
- **置信度**：已复核（导入链路、`createTextTrack`、面板条件三段都读过）。

### P1-4　「分离音频」对变速片段和音量关键帧处理错误（时长错、原声残留、双份声音）

- **场景 A**：10s 素材设 2x（时间轴占 5s）→ 点「分离音频」→ 音频轨上出现一条 10s 的片段，比画面长 5s，内容还对不上。
- **场景 B**：片段做过音量关键帧（开头静音、后段 160%）→ 分离后原片段仍然按关键帧发声，同时音频轨上多一份 → 声音叠两遍。
- **现状**：
  - 命令直接用 `clip.sourceStart/sourceEnd` 和 `segment.start` 造 `AudioClip`（`core/commands.ts:1317-1326`），没有用时间轴时长（`clipTimelineDuration`，`core/clipTime.ts:66-80`）；入口只挡了 freeze，不看 speed/speedSegments/speedCurve（`store/slices/editing.ts:142-160`）。
  - 原片段只写 `volume: 0`（`commands.ts:1329`），**`anim.volume` 原样保留**；导出侧只要有关键帧就用 `volume='<expr>'`（`exportPlan.ts:541-543`），`volume=0` 不生效。
  - 单测唯一用例是 speed=1 的片段（`tests/clipAudio.test.ts:59-73`）。
- **建议**：分离时按 `clipTimelineDuration(clip)` 生成片段，并把 speed/keepPitch 迁移到音频（AudioClip 目前无变速字段）；`anim.volume` 镜像到新音频片段并从原片段移除（可复用 `reverse.ts` 的关键帧镜像思路）；对不支持的情形禁用入口并说明。
- **置信度**：已复核（命令、入口、导出音量分支都读过）。

### P1-5　「仅从素材库移除（片段变空白）」的占位片段，刷新后被静默删除

- **场景**：素材被 15 个片段引用 → 素材库删除 → 选「仅从素材库移除（片段变空白）」，界面承诺「保留时间轴片段，显示为素材已移除」→ 继续剪，刷新页面/切项目再切回 → 这些片段直接消失。
- **现状**：
  - `removeAsset(removeClips:false)` 只把素材从 `assets` 移出、塞进内存 `pendingReclaim`，**不写 `missingAssets`**（`store/slices/assets.ts:135-183`）。
  - 重载时 `keepUrls` 只来自 `snapshot.missingAssets` 与「blob 读不出来」的素材（`services/draftStore.ts:645-657`）；被移除的素材既不在 `snapshot.assets`、也不在缺失列表 → `pruneProjectUrls` 把引用它的片段全部剔除（`core/draft.ts:114-123`）。
  - 附带：`pendingReclaim` 因工程仍引用该 URL 而永不回收（`store/internal.ts:241-257`），所以对话框说的「缓存中的素材文件会被删除」也不成立——blob 变成无人清理的孤儿，继续占配额。
- **建议**：`removeAsset(removeClips:false)` 时把该素材写入 `missingAssets`（复用 `missingAssetFromDraft`），让占位跨刷新/跨项目保留；启动时做一次孤儿 blob 清扫；把对话框文案改成真实行为。
- **置信度**：已复核（removeAsset、restore 的 keepUrls、pruneProjectUrls 三处）。

### P1-6　草稿素材丢失后没有「重新链接」入口，界面提示的恢复方式实际不成立

- **场景**：配额不足/浏览器清理导致 blob 没写进去。第二天打开项目，时间轴显示「素材已移除」，属性面板写着「重新导入同一文件后可恢复编辑」。用户照做，重新导入同一个视频——片段仍然是占位。
- **现状**：
  - 缺失素材对话框只有一个调用点，且被 `projectImport`（导入 .framecut.json）驱动（`VideoEditor.tsx:1492-1541`）；草稿恢复产生的 `missingAssets` 没有任何 UI 消费。
  - 重新导入会生成**新的 asset id 与新 blob URL**（`services/assetReader.ts:233,309-319`），`addAssets` 只按 URL 去重（`store/slices/assets.ts:62-68`），不会改写片段旧的 `sourceUrl`。
  - 全仓唯一能改写片段源的 `replaceClipSourceInProject` 只服务倒放（`core/commands.ts:107,147`）。
- **建议**：把「缺失素材」对话框提升为任意时刻可打开的恢复面板，支持按旧 URL → 新 URL 做全工程 remap（主轨/叠加/音频/字幕 link/背景图），再落盘新 blob；或者让「导入同一文件」自动匹配同名缺失素材并触发重链。在此之前先改掉那句错误提示。
- **置信度**：已复核（对话框条件、重新导入路径、replace 的唯一调用点）。

---

## 二、P2：半成品 / 能力缺失（有绕路）

### P2-1　蒙版只能「固定居中 60%」：位置/大小/旋转没有 UI，也不能关键帧

- **场景**：想做「只保留画面右侧一块」或「圆形聚焦左上角」。
- **现状**：渲染侧 `mask.ts` 完整支持 `x/y/w/h/rotation`，默认 `0.5/0.5/0.6/0.6/0`（`core/mask.ts:21-38`）；但属性面板只暴露**形状 / 羽化 / 圆角（仅矩形）/ 反向**（`PropertiesPanel.tsx:966-1030`），没有位置、尺寸、旋转控件，也没有画布拖拽手柄。`types.ts:100` 注明「阶段 A：静态，不支持关键帧」，`AnimatableProperty` 里没有 mask。
- **后果**：蒙版实际上是「正中 60% 的四种形状」，对叠加轨（唯一的裁形手段）和「局部保留」几乎没用。
- **建议**：先把 x/y/w/h/rotation 的数值输入 + 舞台拖拽接上（渲染已就绪，纯 UI 工作）；再补 mask 关键帧。
- **置信度**：已复核。

### P2-2　无法手动新建文字 / 标题 / 单条字幕

> **复核更正（2026-11-24）**：此条**不成立**。时间轴顶部有「文本」按钮，调用 `addTextAtPlayhead`（`Timeline.tsx:1489`），会在播放头创建文本片段；此前只检索了 `addTextTrack`，漏掉了真正入口。字幕条目的“新增/时间数值编辑”仍属 P2-12。

- **场景**：想加一个片头标题，或补一条漏掉的字幕。
- **现状**：`addTextTrack` 在 store 与 command 里都有实现（`editorStore.ts:423`、`slices/editing.ts:1212`、`core/text.ts:254`），但**全仓没有任何 UI 调用**（grep 确认）；工具栏只有「智能字幕」「导入字幕」（`Toolbar.tsx:280-293`），顶栏/空态面板也没有入口。字幕列表面板同样没有「新增一条」。
- **后果**：文字轨只能由「导入 SRT/VTT」或「智能字幕」产生；想加标题得先在外面做一个字幕文件。
- **建议**：时间轴加「+ 文本轨」，文本轨上加「在播放头新建文字」，同时接上 `addTextTrack`（顺手消掉死代码）。
- **置信度**：已复核。

### P2-3　叠加片段的「裁剪」入口自相矛盾：工具栏能用，属性面板说「暂不支持」

- **场景**：选中画中画片段，在属性面板想裁剪画面，按钮是灰的，tooltip 写着「叠加片段暂不支持裁剪」。
- **现状**：`beginCrop` 明确支持叠加轨（`slices/editing.ts:1496-1497`），工具栏裁剪按钮对叠加片段可用，README 也写「叠加轨的画面裁剪已打通」（`README.md:944`）；但属性面板 `disabled={disabled || isOverlay}`、标题写死「暂不支持」（`PropertiesPanel.tsx:936-937`）。
- **建议**：去掉 `isOverlay` 禁用与那句错误文案，与工具栏/README 对齐。
- **置信度**：已复核。

### P2-4　抠像：预览强依赖 WebGL，失败时静默「不抠像」；预览与导出还是两套实现

- **场景**：绿幕素材勾了抠像；换一台 WebGL 被禁用的机器，或显卡驱动异常 → 预览显示原绿幕，导出却抠掉了；或边缘半透明带宽度在不同片段上不一致。
- **现状**：预览唯一入口注入 `webglKeyer`（`Preview.tsx:443`），`clipRender.ts:185-196` 只在返回非 null 时替换画面，`webglKeyer.ts:421-423` 异常直接 `return null` → 静默显示原画面。导出静止片段走 FFmpeg `chromakey/despill`，带动画/蒙版的片段走 canvas + 同一个 WebGL keyer（`animationRenderer.ts:373`）→ 同一时间轴两种实现；FFmpeg 在 yuv420p 半分辨率色度平面取 3×3，GLSL 在 RGB 全分辨率取 3×3（`webglKeyer.ts:77,406`），边缘宽度不同。
- **建议**：WebGL 不可用时降级到 `chromaKey.ts` 已有的 CPU 单像素实现（而非跳过）+ 一次 toast；补「canvas 路径 vs ffmpeg 路径同帧对比」的回归。
- **置信度**：代码审查确证（分支缺失与调用点）；视觉差异幅度为推断。

### P2-5　模糊背景强度不随导出分辨率归一：预览「糊得刚好」，成片几乎看不出

- **场景**：模糊强度 24px，拖滑块时预览正合适；导出 1080p/4K 后发现几乎没糊。
- **现状**：预览把 `blurAmount` 当 CSS 像素直接 `ctx.filter = blur(Npx)`（`Preview.tsx:386-388`，画布尺寸是显示尺寸×DPR≤2）；导出 `sigma = clamp(blurAmount/2, 1, 50)`（`exportPlan.ts:486-495`）作用在全分辨率上。相对强度差约 2–3 倍，且随导出分辨率（480p–4K）继续变化，4K 更弱。
- **建议**：把 `blurAmount` 定义成「占画面高度比例」，预览按预览高、导出按输出高换算（并计入 DPR）。
- **置信度**：机制代码确证；倍数推断。

### P2-6　变速片段在预览里默认被静音，导出却有稳定音高的声音

- **场景**：给一段口播做 1.5x 变速，预览完全没声音（以为音频坏了），导出后声音正常。
- **现状**：`previewMuteSegmentedSpeed` 默认 `?? true`（`Preview.tsx:206-210`），有变速的片段预览直接静音；理由是浏览器预览只能按 `playbackRate` 播放会变调，而导出用 `atempo` 保音高（`editorStore.ts:365-366`）。属性面板有开关（`PropertiesPanel.tsx:1291-1292`）。
- **缺口**：默认值让「听感校验」失效——用户没法在预览里确认变速后的语速/节奏是否合适。属有意的取舍，但默认值值得改。
- **建议**：默认改为「开声音 + 预览变调」，并在第一次遇到时提示可切换；或预览也走 `preservesPitch=true` 的音频路径。
- **置信度**：已复核。

### P2-7　粘贴：目标轨不可选；锁定轨不报错而是**新建一条轨**；跨项目剪贴板不校验素材

- **场景**：在叠加轨 A 复制两个片段，想粘到叠加轨 B——只能回到 A；目标轨锁定时按 Ctrl+V，界面悄悄多出一条「叠加轨 N」并把片段放进去；切换项目后仍能粘贴上一项目的片段。
- **现状**：粘贴锚点硬编码播放头 `planPaste(...playhead)`（`core/clipboard.ts:159`）；分组键是复制时的 `item.trackId`，锁定/不存在的轨置 `trackId=null`（`clipboard.ts:176-177`），随后新建轨道（`clipboard.ts:250-282`）；克隆时强制 `gapBefore: 0`（`clipboard.ts:296`）；`hydrateDraft` 重置了 `selectedIds` 但没有清 clipboard（`slices/persistence.ts:35-76`）。
- **建议**：粘贴前用当前选中/悬停轨作目标轨；锁定轨显式 toast 拒绝（与拖拽 `editing.ts:736-745` 一致）；换项目时清空剪贴板或校验 assetId；保留 `gapBefore`。
- **置信度**：已复核。

### P2-8　转场：只作用于主轨、遇空隙直接拒绝、首尾片段不能加、叠加轨不支持、时间轴不能拖时长

- **场景**：两段之间有 0.3s 空隙想直接加转场；或想给画中画片段之间加转场；或想直接在时间轴上拖转场长度。
- **现状**：`resolveTransitionDuration` 遇 `gapBefore>0` 返回 0（`core/transition.ts:118-131`）；设置入口直接 toast「先移除空隙才能加转场」（`slices/editing.ts:356-359`）；只按 `project.clips` 找相邻（`editing.ts:330-379`），面板明写「转场只作用于主轨片段」（`PropertiesPanel.tsx:1525-1526`）；没有 `transitionIn`，末段因缺 next 被拒（`editing.ts:352-355`）；时间轴上的转场标记只能点击开面板（`Timeline.tsx:2054-2075`）。
- **建议**：「空隙+转场」做成一次原子操作（自动吸收空隙）；补首段「从黑场」；叠加轨复用同一套 resolve/合成；时间轴支持拖时长。
- **置信度**：已复核（resolve、入口、面板文案）。

### P2-9　多标签页 / 宿主嵌入没有存储隔离：静默互相覆盖，删掉的项目会「复活」

- **场景**：两个标签页都打开同一项目各改各的；或宿主页面放两个 `<VideoEditor>`；或 A 删项目 P，B 里还开着 P。
- **现状**：全仓没有 `BroadcastChannel`/`storage` 事件/`navigator.locks`。保存序号与队列是每标签页内存态（`draftStore.ts:198-199,226-261`），删除保护 `deletedProjectIds` 也只在内存（`draftStore.ts:201-213`）→ B 的 700ms 防抖保存把 A 刚删的记录写回来；A 删除时已回收「没人引用」的 blob（`draftStore.ts:455-462`），复活的记录打开时素材全缺。宿主模式（`projects={false}`）仍会自动恢复「最近更新的草稿」并继续自动保存（`VideoEditor.tsx:866-897`），两个实例会抢同一条记录。
- **建议**：加项目级编辑锁/心跳（BroadcastChannel + Web Locks），第二实例只读并提示；删除广播；新增 `persistence:'off'` 与 `storageNamespace`，宿主默认不自动恢复草稿。
- **置信度**：已复核（自动恢复路径、上限/保存逻辑）；多标签页后果为推断。

### P2-10　项目数上限只拦住「新建项目」，导入视频/导入工程仍会进入「存不进草稿库」的项目

- **场景**：已有 20 个项目，点「导入视频」或导入一个 `.framecut.json`，剪半天，每次保存都被拒（只一条去重警告），刷新后内容不在。
- **现状**：只有 `newProject` 在创建前查 `countProjectRecords`（`VideoEditor.tsx:1216-1219`），项目列表也只禁用「新建」（`ProjectLibrary.tsx:94-107`）；`addAssets` 给空会话分配新 projectId（`slices/assets.ts:77-84`）与 `applyProjectToStore → adoptProject(createId('project'))`（`api.ts:164-187`）都没有上限检查；后续保存被 `beforeSave` 拒绝（`VideoEditor.tsx:1054-1064`）。
- **建议**：收敛成 `ensureCanCreateProject()`，在 `addAssets`、`applyProjectToStore`、宿主 `loadProject` 统一调用；达到上限时先让用户删一个旧项目。
- **置信度**：已复核。

### P2-11　工程文件重链只按文件名匹配；HEVC 代理改名后批量重链必然失败，且不校验素材身份

- **场景**：导出 `.framecut.json` 换机导入。工程里 HEVC 素材显示名是代理名「旅行-h264.mp4」，用户「一次多选」选回原始 `旅行.mov` 等文件 → 全部匹配不上；或单行选择时把完全不相干的视频接上，`sourceEnd` 超出新文件时长 → 黑帧。
- **现状**：匹配规则只有「去扩展名小写比对 + 同名顺序分配」，单行选择甚至允许名字完全不同（`core/missingAssets.ts:73-105`）；配对后直接 `readAssetFile`，不校验 kind/时长/尺寸（`VideoEditor.tsx:1398-1416`）；代理名由 `videoTranscoder.ts:17-20,98` 加 `-h264` 生成并作为 `asset.name`（`assetReader.ts:311`）持久化。导入前也不先尝试 `loadMediaBlob(asset.id)` 复用本机已有 blob（`VideoEditor.tsx:1459-1475`）。
- **建议**：`DraftAsset` 增加 `sourceName/size/contentHash`，按 hash/大小优先匹配；不匹配要求确认；配对后校验时长/分辨率并提示；导入前先复用本机 blob。
- **置信度**：代码审查确证。

### P2-12　字幕工作流的其余断点：时间不能数值编辑、不能新增条、只有 SRT 导出、GBK 乱码、隐藏字幕混入

- **场景**：想把手改的字幕精确到 00:00:12.30–14.10；想补一条漏句；交付方要 .vtt；Windows 播放器打开中文乱码；裁过片后导出的 SRT 条数与画面对不上。
- **现状**：
  - 列表只能改文本/拆分/合并/删除/查找替换/跳转/导出 SRT；起止时间只是只读显示（`CaptionListPanel.tsx:186-193`），没有数值输入或 ±1 帧微调；没有「新增字幕条」。
  - 只序列化 SRT（`core/text.ts:600-616`），无 VTT；不写 BOM、用 `\n` 连接（`text.ts:613-615`），而导入端会剥 BOM（`text.ts:525`）。
  - 导入用 `file.text()` 恒按 UTF-8 解码（`VideoEditor.tsx:1191`），GBK/GB18030 文件会整篇乱码（不是报错，更糟）。
  - 导出取 `track.clips` 全量（`CaptionListPanel.tsx:35,96`），但渲染侧过滤了 `linkHidden`（`textOverlay.ts:100`、`textAnimation.ts:100,126`）→ 隐形的字幕也会进 SRT。
  - 导入的字幕没有 `link`/`words`（`text.ts:548-566`），「字幕跟随」勾选框对它们空转；「重新对齐」只认 ASR 词表，会直接报错（`slices/editing.ts:1300-1304`）。
- **建议**：行内 start/end 数值 + 帧级 nudge；工具栏「新增字幕条（播放头）」；补 VTT、BOM/CRLF 选项；导出前过滤 `linkHidden`；导入时给「整体偏移 / 绑定到片段」；编码探测或明确提示「请另存为 UTF-8」。
- **置信度**：代码审查确证（`VideoEditor.tsx:1191` 已复核）。

### P2-13　视频片段没有音频波形，主轨原声完全不可见

- **场景**：想在对白停顿处下刀、或找音乐节拍对齐，但素材还在主轨（未分离）。
- **现状**：主轨/叠加轨只画胶片条（`Timeline.tsx:1788,1988` 用 `ClipFilmstrip`，内容只有帧瓦片）；`AudioWaveform` 只被音频泳道使用（`AudioTracks.tsx:13,339`）。
- **建议**：给带 `hasAudio` 的视频片段叠一层可开关的波形（与胶片条共用 canvas 或半透明覆盖）。
- **置信度**：已复核。

### P2-14　没有任何「保存状态」提示：用户不知道是否已落盘

- **场景**：改完最后一处，关页面/刷新，不确定存没存。
- **现状**：全仓没有「已保存 / 保存中 / 未保存」UI（`TopBar.tsx` 与 `VideoEditor.tsx` 均无；grep 只命中注释），只有在保存失败时才 toast。草稿是 700ms 防抖 + 页面隐藏 flush（`VideoEditor.tsx:1035-1101`）。
- **建议**：顶栏常驻「保存于 HH:MM / 保存中… / 保存失败（点击重试）」；配合 P2-9 的冲突提示。
- **置信度**：已复核。

### P2-15　音频轨道级能力有一半是「死 UI」：叠加轨独奏无效、音轨音量入口被 CSS 隐藏

- **场景**：点叠加轨的 S 想只听旁白——没反应；想给整条音乐轨降 20%——不选中片段就没有入口。
- **现状**：
  - `anySoloActive` 只统计主轨与 audioTracks，**不看 overlayTracks**（`core/tracks.ts:49-58`）；但 UI 允许点叠加轨的 S/静音（`TrackControls.tsx:53,181-187`）→ 叠加轨独奏实际无效。
  - 带音量滑块的 `AudioTrackHead` 仍在渲染（`AudioTracks.tsx:39-94,300`），但 CSS 里 `.audio-track-head { display:none !important }`（`styles/editor.css:5003-5009`）→ 永远不可见；真正的轨头 `TrackControls` 没有音量（`TrackGutter.tsx:60-79` 也没传）；只剩「选中某条音频片段」后的属性面板能调（`AudioPropertiesPanel.tsx:196-220`）。
- **建议**：`anySoloActive` 把 enabled+solo 的叠加轨计入；把轨道 gain 移到 `TrackControls`，删掉被隐藏的死组件。
- **置信度**：已复核（anySoloActive、CSS、TrackGutter 三处）。

### P2-16　多轨混音没有峰值保护：100% + 100% 就会削波

- **场景**：主轨原声 100% + 音乐 100%（或音乐轨 200%），导出后爆音/失真。
- **现状**：`amix=...:normalize=0` 之后只有 `apad/atrim`，没有 `alimiter`（`exportPlan.ts:1931-1933`）；响度标准化是可选项且默认 `off`（`exportPlan.ts:948-955`）；片段/轨道音量都允许 0–200%（`ClipAudioSection.tsx:52-66`、`AudioPropertiesPanel.tsx:205-219`）。全仓没有 `alimiter/dynaudnorm/acompressor`。
- **建议**：`amix` 后固定接 `alimiter=limit=0.97`（或分支预衰减 -6dB），多轨叠加时给提示。
- **置信度**：代码审查确证。

### P2-17　`keepPitch=false` 的变速把采样率写死 48000：44.1k 素材时长/音高都错

- **场景**：导入 44.1kHz 的手机视频/mp3，设 2x 并取消「保持音调」→ 导出音频比画面短约 8%，结尾被补静音，音高也偏高；预览却正常。
- **现状**：`asetrate=${Math.round(sampleRate * target)}` 且 `sampleRate` 默认 48000（`core/speed.ts:58-62`），调用点都不传真实采样率（`exportPlan.ts:573,610`、`animationAudio.ts:54`）；预览走 `playbackRate + preservesPitch=false`（`Preview.tsx:161-180`），比例精确。单测把 `asetrate=96000` 写死（`tests/speed.test.ts:115,118`）。
- **建议**：asetrate 前插 `aresample=48000`，或把探测到的源采样率传进 `speedAudioFilters`；补 44.1k 时长一致性测试。
- **置信度**：代码审查确证。

### P2-18　音频片段交互明显弱于视频：拖动无吸附、无起点数值、不能多选

- **场景**：把音乐卡到镜头切点；批量移动两条音频；把起点从 8.14s 精确改到 8.00s。
- **现状**：拖动只做像素换算（`AudioTracks.tsx:159,171`），裁剪只 clamp 像素（`:194-230`），不吃时间轴的吸附引擎（`Timeline.tsx:709-735`）；起点只读（`AudioPropertiesPanel.tsx:67`），无帧步进；泳道点击直接单选（`AudioTracks.tsx:239,262,331`），框选只收 overlay 与主轨（`Timeline.tsx:1067,1071`）。
- **建议**：复用 `evaluateSnap`；属性面板加起点数值/帧步进；泳道支持 Ctrl/Shift 并纳入框选。
- **置信度**：代码审查确证。

---

## 三、P3：体验 / 产品化（不影响正确性，但影响「专业度」）

1. **导出画质只由分辨率决定 CRF**，没有码率/质量档、GOP、像素格式、色彩空间选项（`ExportQuality` 只有 resolution/fps/loudness；`qualityCrf(resolution)`，`exportPlan.ts:850` 等）；格式只有 MP4/M4A/MP3，无 WebM/GIF/帧序列（README 已声明）。
2. **剪辑动作不完整**：片段没有键盘微调（`moveSelectionBy` 是死代码，`slices/selection.ts:188-214` 无调用点）；没有 slip/slide/roll；关键帧不能复制到别的片段（属性剪贴板 `VisualAttrs` 不含 `anim`，`attributeClipboard.ts:12-31`）；归一化关键帧时间导致「修剪后动画节奏被拉伸」。
3. **选择与吸附的规则不一致**：框选只收主轨与叠加轨（`Timeline.tsx:1064-1072`），Ctrl+A 却含音频/字幕（`slices/selection.ts:133-135`）；主轨磁吸开启时不再吸附标记/播放头（`Timeline.tsx:711-736`）；没有「按住 Alt 临时关吸附」。
4. **长片可用性**（代码结构判断，未实测）：主轨与转场/关键帧标记全量 `map` 渲染、无虚拟化（`Timeline.tsx:1946,2054`）；每次 `pointermove` 重建全部吸附点（`:673-691`）；缩放的滑杆以播放头为锚（`:802-813`）。
5. **素材库能力偏基础**：无重命名、排序、文件夹、去重、替换、URL/粘贴导入（`MediaLibrary.tsx:211-336`）；重复导入必然产生两份 blob（`addAssets` 只按 URL 去重，`slices/assets.ts:62-68`），把用户推向配额上限。
6. **最近项目列表信息不足**：只有缩略图/名字/时间，无片段数、总时长、素材数、缺失标记；无「复制项目」「导出工程文件」（`projectFile.ts` 的能力没接到列表）。
7. **缩略图失败后没有重试入口**：`captureThumbnail` 失败即 `undefined`（`assetReader.ts:168-220`），素材卡永远回退胶片图标。
8. **紧急快照失败静默**：`writeEmergencyDraft` 在 localStorage 满/不可用时只 `return false`（`draftStore.ts:298-312`），调用方忽略返回值；防抖窗口内关页面可能丢最后一次编辑且无提示。
9. **草稿版本号写死 1，而 schema 是 2**：`toDraftSnapshot` 写 `version: 1`（`draftStore.ts:727-728`），`DRAFT_SCHEMA_VERSION = 2`（`draft.ts:519`）→ 未来按版本迁移会把 v2 当 v1。
10. **文字样式能力被写死**：无行距/字间距/斜体；字体只有 6 项系统字体（`TextPropertiesPanel.tsx:222-227`）；行高硬编码 `fontSize*1.26`（`textRender.ts:94`）；没有入场/出场预设，只能手 K 四个属性；逐字符断行会从中间截断英文单词（`textRender.ts:6-25`）。
11. **`opencc-js` 是隐式单向行为**：识别结果无条件 `Converter({from:'tw',to:'cn'})`（`workers/whisperWorker.ts:2,19,213`），界面没有繁简开关，也没有简→繁或对导入 SRT 的转换入口。
12. **淡入淡出只有线性**，且 fade 超过片段时长时预览与导出口径不一致（音频轨分支用未夹取的 fade，`exportPlan.ts:1809-1816` vs `clipAudio.ts:46-59`）。
13. **波形实现粗糙**：整文件 `decodeAudioData` + 固定 600 桶（`services/audioWaveform.ts:8,44-66`），1 小时素材 ≈ 6s/桶，10s 片段几乎是平线；失败静默留白（`AudioWaveform.tsx:33-40`）。
14. **音频片段无变速/倒放/换素材，轨不可重命名，音轨数量无上限**：`AudioClip` 没有 speed/keepPitch（`types.ts:247-263`）；`core/audio.ts:49-64` 支持 name 但 UI 不传；`addAudioTrack` 无上限（`slices/editing.ts:1100-1105`），每加一条多一路 `amix`。
15. **无 i18n/文案注入、无 ErrorBoundary**：所有 UI 文案是硬编码中文，宿主无法本地化或定制；组件抛错会整块白屏。对一个「可嵌入宿主平台」的组件来说，这两条是产品化缺口。

---

## 四、文档 / 界面文案与实现不一致（会直接误导用户）

| # | 位置 | 文案 | 实际 |
|---|---|---|---|
| D1 | `README.md:940` | 「叠加轨暂无独立音频，因此静音/S 置灰」 | 叠加轨**有**独立音频，参与预览混音与导出 `amix`；静音/S 可用（`TrackControls.tsx:52-53`、`exportPlan.ts:1828`）。✅ 已修：README 已改为「文本轨没有独立音频」 |
| D2 | `README.md:939` | 「主轨本身暂无独立静音/隐藏 UI」 | 主轨有静音/隐藏且生效（`core/tracks.ts:62-96`、`TrackControls`）。✅ 已修：README 已改为「主轨与其他轨一样有五键」 |
| D3 | `ClipCompositingSection.tsx:93` | 「主轨片段仅受不透明度影响」 | 主轨混合模式同样生效（`exportPlan.ts:1082,1113,1137`）。✅ 已修：文案改为「主轨与画布背景合成」 |
| D4 | `PropertiesPanel.tsx:937` | 「叠加片段暂不支持裁剪」 | `beginCrop` 支持叠加轨，工具栏可用，README 也写已打通 |
| D5 | `PropertiesPanel.tsx:570-578` | 「重新导入同一文件后可恢复编辑」 | 重新导入生成新 URL，不会改写片段源（见 P1-6） |
| D6 | `MediaLibrary.tsx:362-366` | 「缓存中的素材文件会被删除」 | 实际因工程仍引用而永不回收，变成孤儿 blob（见 P1-5） |
| D7 | `README.md:954` | 「验证覆盖 Chromium（Edge 152）；Safari/Firefox 未验证」 | 仍是事实，且新增的 `chrome` 通道也只覆盖 Chromium 系 |

---

## 五、README 已承认的限制（仍算功能缺点，按影响排序）

1. 只用 `libx264 + aac` 输出 MP4，无 WebM/ProRes/GIF、无码率/质量档。
2. 单画布比例；切换比例只改一个字段（`operations.ts:1216-1218`），不自动重构图，也不提示已有构图会变。
3. HEVC 导入要转 H.264 代理（慢、轻微画质损失），且代理名会污染「重链匹配」。
4. 智能字幕首次需下载 Whisper small（约 480MB）/ medium（约 1.5GB）；只按素材识别，不按片段。
5. 标记不烧录进成片；定格片段静音；非破坏裁剪留下的空隙是黑场静音。
6. >500MB 素材只警告；远程素材需 CORS；多线程核心可能先等约 12s 再回退单线程。
7. 仅 Chromium 系验证；Firefox/Safari 的 `pointerId=0`、module worker、音频行为仍是盲区。
8. 多源导出滤镜图只有单测覆盖，浏览器内多输入成片未做 e2e。

---

## 六、建议的修复顺序（按「成片正确性 / 用户信任 / 成本」排）

**第一批（1–2 天，直接消除 P1）**
1. 有间隙时背景丢失：删掉 gapped 路径的黑场覆盖，复用 blur 分支；加滤镜图快照测试。
2. 图片背景：先按「未实现」禁用 UI（半天），再决定是否真做 `-loop 1` 输入 + overlay。
3. SRT 导入轨道 kind：改走 `addCaptionTrackWithClips` + 迁移兜底，一次解锁列表编辑/导出 SRT/重新对齐。
4. 分离音频：用 `clipTimelineDuration` 生成、迁移 `anim.volume`；补变速/关键帧两条单测。
5. 移除素材占位：写 `missingAssets` + 启动孤儿清扫 + 改文案。
6. 丢失素材重链：把缺失对话框提升为常驻面板，按旧 URL 全工程 remap；先改掉错误提示。

**第二批（2–3 天，半成品补齐）**
7. 蒙版位置/尺寸/旋转 UI（渲染已就绪）。
8. 手动新建文字/标题/单条字幕（接 `addTextTrack`）。
9. 叠加裁剪入口对齐（去掉 `isOverlay` 禁用）。
10. 保存状态提示 + 素材缺失面板（信任成本最低、收益最高）。
11. 音频：叠加轨 solo 计入、`alimiter`、asetrate 归一 48k、轨道 gain 移到 TrackControls。

**第三批（体验）**
12. 字幕时间数值编辑 / VTT / BOM / `linkHidden` 过滤。
13. 粘贴目标轨、锁定轨拒绝、跨项目剪贴板校验。
14. 视频片段波形、关键帧复制、片段键盘微调、slip/slide/roll。
15. i18n/locale 注入 + ErrorBoundary（如果要做「可嵌入宿主产品」）。

---

## 七、本次没做的事（避免误读结论）

- **没跑测试**：`vitest` 在本沙箱启动即 `esbuild spawn EPERM`（子进程被禁止），`tsc`/`eslint` 同理未执行；现有 1000+ 单测与 22 条 e2e 的通过状态未复验。
- **没开浏览器**：没有实机点击验证；涉及「观感/听感」的结论（模糊强度差、抠像边缘宽度、solo 听感）是机制推断，已在条目里标注。
- **没改代码**：本报告只读；`git status` 里原有的未提交改动（ASR/WebGL keyer 等）未被触碰。
- 未覆盖：`devProfiler.tsx`、测试代码质量、构建配置、CI 配置。

---

## 附：证据索引（主要文件）

- 画面/背景：`src/editor/core/{background,exportPlan,clipRender,mask,chromaKey,color,blend}.ts`、`components/{Preview,CanvasBackgroundPanel,PropertiesPanel}.tsx`
- 字幕：`src/editor/core/{text,captionLink,captionMapping}.ts`、`store/slices/editing.ts`、`components/{CaptionListPanel,TextPropertiesPanel,Toolbar}.tsx`
- 素材/持久化：`src/editor/store/slices/assets.ts`、`services/{draftStore,assetReader,videoTranscoder}.ts`、`core/{draft,missingAssets,projectLibrary}.ts`、`components/{MediaLibrary,ProjectLibrary,MissingAssetsDialog}.tsx`
- 音频：`src/editor/core/{clipAudio,audio,tracks,speed}.ts`、`core/exportPlan.ts` 音频段、`components/{AudioTracks,AudioPropertiesPanel,ClipAudioSection}.tsx`、`workers`/`services/audioWaveform.ts`
- 时间轴：`src/editor/core/{clipboard,operations,commands,transition,keyframeEdit}.ts`、`components/Timeline.tsx`