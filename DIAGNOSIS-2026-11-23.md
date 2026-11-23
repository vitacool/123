# FrameCut 诊断报告：为什么「最基本的剪辑」会断

- 日期：2026-11-23
- 范围：只读分析。**没有改动任何源码**（`git status` 干净，仅新增本报告与 `.verify/probe/` 下的探针脚本）
- 站点：开发服 `http://127.0.0.1:5173/`，生产构建 `http://127.0.0.1:4173/`
- 方法：真实浏览器（Edge + Playwright）端到端操作 + 四人只读代码审查（时间轴 / 预览 / 导出 / 状态）

---

## 0. 结论（先看这个）

你的主链路（视频导入 → 点播放 → 拖播放头 → 分割 → 删一段 → 导出 MP4）**在自动化里是通的**，我用 320×180/3s、1080p/10s、4K/5s、HEVC、MP3、PNG 全部跑过，零控制台报错。

真正让你「剪不下去」的不是一个惊天大 bug，而是 **5 个 P0 级交互/状态缺陷**，它们集中在「剪辑动作之间的衔接」上，而且都**没有报错、没有任何提示**，表现就是「点了没反应、拖了没变化」：

| # | 现象（用户视角） | 根因一句话 | 状态 |
|---|---|---|---|
| P0-1 | 导入完素材按空格/Delete/Ctrl+B 全没反应；关掉弹窗后快捷键也全废 | 快捷键绑在编辑器根节点，没绑 `window`；焦点一落到 `body` 或 `<input>` 就收不到事件 | **✅ 已修复（Step 1）** |
| P0-2 | 撤销一次分割后，片段不再被选中；之后 Delete、Ctrl+B、左右裁全部静默失灵 | `sync()` 无条件写入 `selectionAfter`，不校验 id 是否还存在 | **✅ 已修复（Step 1）** |
| P0-3 | 两个片段的接缝处怎么拖都裁不动，只会把片段选中 | 18px 的「添加转场」按钮正好压在左右两个 9px 裁剪手柄上，且 z-index 更高 | **✅ 已修复（Step 2）** |
| P0-4 | 图片片段右边缘拖不动（永远 3 秒）；一点播放播放头就卡死 | ①UI 的图片可延长上限漏写 image 分支；②图片素材被塞进 `<video>`，`readyState=0` 让播放时钟永久判「缓冲中」 | **✅ 已修复（Step 2）** |
| P0-5 | 删片段 → 删素材 → 撤销：片段回来了但素材没回来，画面全黑 | 回收逻辑用「删除时看到是否还有引用」推断用户意图，撤销后条件对不上 | **✅ 已修复（Step 3）** |

P0 之外，**导出**还有一批「特定组合下必然错/必然失败」的分支（蒙版×文字、叠加轨图片、无音轨素材、空隙+转场、超长字幕），见第三节——这些是你后面做长片一定会踩的。

修复顺序建议：**先 P0-1/P0-2（半天，纯交互，立即恢复「能用」）→ P0-3/P0-4（半天）→ P0-5（半天）→ 导出分支（2 天）→ 其余（2 天）**。

---

## 1. 先说「不是 bug」的部分（排除误判，避免白改）

以下我实测通过，不要动：

- **导入**：1080p/10s、4K/5s、HEVC 1080p、PNG、MP3，全部 1.4–1.6s 出现在素材库并自动进主轨；HEVC 在本机浏览器可直接解码，没走转码。
- **播放**：点击播放、空格播放、播放到末尾停止再重播、跨分割点连续播放（0 → 3.0s 单调推进）均正常；1080p 播放 3s 视频 `currentTime` 到 2.98s。
- **时间轴**：拖播放头、拖片段左右移动、拖中段裁剪手柄、删除+撤销、选中→属性面板（响应 61ms）均正常。
- **多片段时间轴**：5 段时 UI 仍 60fps（rAF 中位 5.6ms，p95 5.6ms）。
- **布局**：1024×768 / 1280×720 / 1366×768 / 1440×900 / 1920×1080 下，片段可点击、手柄可命中、无遮挡层、时间轴高度 198–232px（够用）。
- **生产构建**：`tsc -b` 0 错误，`vite build` 成功（186 模块/3.86s），`vite preview` 下同样可正常剪辑。
- **文本片段**：创建 + 属性面板正常。
- **导出基础路径**：3s/320×180 = 14s；**1080p/10s = 44s（多线程 FFmpeg）**，产物正常。

> 说明：`pnpm dev` 在我这个受限环境里第一次启动失败（esbuild 子进程 EPERM），换权限后正常；`vite build` 偶发 `remove ...esbuild-xxx: Access is denied`（Windows 临时目录被占用），换 `TEMP` 后成功——**这是环境问题，不是代码 bug**，但值得在 README 里写一句排查方法。

---

## 2. P0 详解（均已实测复现）

### P0-1 快捷键作用域：焦点一离开编辑器根节点，键盘就全废

**实测**：导入后把焦点放到隐藏文件输入框（真实「选择文件」返回后浏览器就是这个状态），再按 `Space`（时间码停在 `00:00:00:00`）、按 `Delete`（片段数仍为 1）——**都不生效**。把焦点 `blur()` 到 `body` 后 `Ctrl+B`、`Delete`、`Space` 同样全部无效。

**代码**：`src/editor/VideoEditor.tsx:340` 的 `handleKeyDown` 挂在根节点 `onKeyDown` 上，`343-348` 对 `input/textarea/select/contenteditable` 直接 `return`。焦点在 `body` 时事件永远到不了根节点；焦点在隐藏 file input 上时被白名单直接跳过。

**为什么用户觉得「编辑器坏了」**：真实流程里最容易命中的两个时机正好都在这里——① 点「导入素材」选完文件回来；② 关掉导出/封面/自动字幕弹窗（弹窗内按钮卸载后焦点回落 `body`）。

**最小修复**（三处，一起改才彻底）：
1. 改成 `window.addEventListener('keydown', …)`，用仓库里已有但没被主流程使用的 `components/keyboardScope.ts#isEditorShortcut` 做守卫（它已经处理了「在输入框内不抢」和「不在编辑器内不抢」）。
2. `<input class="hidden-file-input">` 的 `change` 处理完成后 `input.blur()`（或 `rootRef.current?.focus()`）。
3. 所有弹窗关闭后 `rootRef.current?.focus({ preventScroll: true })`。
**验收**：导入完成不点任何地方，`Space` 能播放；关闭导出弹窗后 `Ctrl+B` 能分割。

---

### P0-2 撤销「分割/定格」后选中丢失，之后所有片段级操作静默失效

**实测**：选中片段 → 拖播放头到 50% → `Ctrl+B`（2 段，`#02` 选中，分割按钮变灰）→ `Ctrl+Z`（回到 1 段，**`selectedBars = []`，面板「未选中片段」**）→ `Delete`（片段数仍 1）→ `Ctrl+B`（仍 1）。**全程无任何提示**。

**代码**：`src/editor/store/internal.ts:139-146`
```ts
let ids = previousIds.filter((id) => idExists(effective, id))
if (selection !== undefined) {
  if (selection === null) ids = []
  else if (!ids.includes(selection)) ids = [selection]   // ← 不校验 idExists
}
```
`src/editor/store/slices/history.ts:41-48` 在 `selectionAfter` 失效时又退回「当前（已失效）的 `selectedClipId`」。

**为什么致命**：分割 / 插入定格 / 粘贴 的 `selectionAfter` 都是**新生成的 id**，撤销后这些 id 在旧快照里不存在 → 选区变空 → 依赖「必须选中片段」的动作（Delete、Ctrl+B、Q/W 裁剪、属性面板）全部变灰或静默返回。

**最小修复**：`sync()` 里对 `selection` 也走一次 `idExists()`，不存在就按 `null` 处理并回落到「过滤后剩余的第一项」；`undo/redo` 的兜底不要用 `get().selectedClipId`。
**验收**：分割→撤销后，左半段处于选中态；直接 `Delete` 能删、`Ctrl+B` 能再分。

---

### P0-3 接缝处裁不动：转场按钮盖住了左右裁剪手柄

**实测**（接缝 x=339，片段高 62px，y 取行中心）：
- `elementFromPoint(x-6/-3/0/+3)` 全部返回 **`svg`（转场标记里的图标）**，`+6` 返回 `button.transition-marker`（`aria-label="添加转场"`）。
- 在接缝处按住向左拖 30px：两个片段宽度仍是 `136 / 136`，**完全没变**；面板反而切到 `#02`（说明触发的是标记的 `onClick → selectClip`）。

**代码**：`Timeline.tsx:2013-2020` 的标记 `width:18px`，`left = x - 9`，垂直居中；`editor.css:1942-1957` 的 `.transition-marker{ z-index:6 }`，而 `.clip-trim-handle{ width:9px; z-index:5 }`（`3339-3347`）。**18px 正好等于「左段右手柄 9px + 右段左手柄 9px」**，且 z-index 更高。

**为什么最烦人**：剪映用户 80% 的精细调整发生在接缝（对齐节奏、留呼吸口）。这里手感是「抓手柄 → 没反应 / 把片段选中了」，会直接得出「这软件不能裁」的结论。

**最小修复**（推荐组合）：
1. 标记只占顶部一条：`top:2px; height:14px;`，让出中下部的手柄区；或
2. 标记缩到 14px 并把 `pointer-events` 只留给图标本体；并
3. 手柄 `z-index` 提到 7（保证边缘 9px 永远优先），标记点击区留在顶部不冲突。
**验收**：接缝处鼠标指针为 `ew-resize`，按住能裁；标记仍可点开转场面板。

---

### P0-4 图片片段：右边缘拖不动 + 一播放就卡死

**实测**：
- 图片片段（3s）右裁剪手柄存在（9×60px，x=465），向右拖 80px → 片段宽度仍 `274`，`时长 3.00s` 不变。
- 点播放 / 按空格后 3 秒内时间码**一直是 `00:00:00:00`**，`videos:1`（页面里有一个 `<video>`），无报错。

**代码（两个独立缺陷，常一起出现）**：
1. `Timeline.tsx:869-878` 的拖动上限只写了 `freeze` 分支：
```ts
const sourceGrow = freeze ? … : Math.max(0, sourceDuration - clip.sourceEnd)  // image 时 = 0
```
而真正执行的 `core/operations.ts:351-356` 是有 `image → IMAGE_MAX_DURATION` 分支的 → UI 先把自己夹成 0，命令永远发不出去。附带：`minDuration` 用 `MIN_CLIP_DURATION(0.05)`，core 用 `IMAGE_MIN_DURATION(0.2)`，缩短图片时预览与结果不一致。
2. `Preview.tsx:1394-1406` 对**所有** `sourceUrl` 都渲染 `<video src>`（图片也渲染），`581-583` 取它当"主轨视频"，而 `playbackClock.ts:106-114` 把 `readyState < 2` 判为 buffering → 墙钟被永久冻结；`Preview.tsx:1015-1018` 在 `video` 缺失时直接 `return`，连 `commitTime` 都不执行。

**最小修复**：
1. `sourceGrow` 补 `clip.type === 'image' ? Math.max(0, IMAGE_MAX_DURATION - duration) : …`，`minDuration` 同步补 image 分支。
2. 图片片段不要进 `baseVideoUrls`；`tick()` 里 `clip.type === 'image'`（以及 `freeze`、空隙）时给时钟传 `video: null`，并保证这些分支也 `commitTime()` + `draw()`。
**验收**：图片可拖长到 30s；播放图片片段时间码正常推进，画布持续重绘。

---

### P0-5 删素材后撤销：片段回来了，素材永远回不来 → 黑帧

**实测**（先把焦点修好后重测，避免被 P0-1 干扰）：
```
初始: 片段 1 / 素材 1
删片段 → 片段 0 / 素材 1
删素材 → 片段 0 / 素材 0
Ctrl+Z ×2 → 片段 1 / 素材 0 / 片段文字「素材已移除」/ 预览画布非黑像素占比 0
```

**代码**：`slices/assets.ts:126-133` 记录 `removedClips = options.removeClips && referenced`——用的是「删除那一刻是否还有引用」这个**观察值**；`internal.ts:198-217` 又用 `entry.removedClips && projectRefs` 决定撤销后是否把素材插回。删片段（此时 `referenced=false`）→ 删素材（记成 `removedClips=false`）→ 撤销片段删除（`projectRefs` 变 true）→ 条件不成立 → 素材不回；而且这条 entry 会被永久 `nextPending`，blob 也永不回收。

**最小修复**：把「意图」与「观察」解耦 —— `const removedClips = Boolean(options.removeClips)`；`reconcile` 里恢复条件是 `if (projectRefs)`，`removedClips` 只在 `!projectRefs && historyRefs` 时用于「保持从素材库隐藏」。
**验收**：删片段→删素材→撤销两次，素材回到素材库原位置，片段画面恢复；再撤销到最初仍正常。

---

## 3. P1：导出正确性（代码证据，未逐条跑通；触发条件明确）

> 这 8 条共同点：**只在「多素材/多轨/有蒙版/有文字/有转场/有空隙」的组合下触发**。你的 E2E「导入→分割→删一段→导出」走的是最简 concat 分支，所以测试全绿也照样会踩。

| # | 症状 | 关键位置 | 根因 | 状态 |
|---|---|---|---|---|
| E1 | 叠加轨/音频轨放了**无音轨素材**（录屏、`-an` 过的片子、GIF 转 mp4）→ 导出失败，且「重试无声」也必失败 | `exportPlan.ts:1773-1800`；`ffmpegExporter.ts:1144` | 叠加/音频混音是唯一不判 `hasAudio` 的入口；而视频素材**从未探测过 hasAudio**（`assetReader.ts:263-274` 没有该字段）→ 恒当有音轨 | **✅ 已修复（Step 4）**：图片/`hasAudio:false` 无条件跳过；无声重试不再生成任何音频分支 |
| E2 | **蒙版 + 文字/字幕**同时存在 → 成片画面全毁（带蒙版片段几乎消失 + 整屏被一张灰白蒙版盖住） | `exportPlan.ts:1972`（按 媒体→蒙版→文字 编号）vs `ffmpegExporter.ts:1126`（先插文字、后插蒙版 → 实际顺序相反） | 编号公式与注入顺序自相矛盾；单测按「蒙版在前」写，所以测不出 | **✅ 已修复（Step 4）**：抽出 `buildExportInputArgs()` 固定 媒体→蒙版→文字→封面 |
| E3 | 叠加轨上的**图片**（logo/贴纸/画中画）成片只出现一帧 | `exportPlan.ts:1499-1506`（手工 push 的输入**漏了 `kind`**）、`1882-1889`（只有 `kind==='image'` 才加 `-loop 1`） | 叠加图片成了单帧流，`trim` 只取到 1 帧 | **✅ 已修复（Step 4）**：`ensureOverlayInput` 补 `kind` |
| E4 | 关键帧动画 + 无音轨素材 → 「动画片段混音失败」，整次导出失败且**不重试** | `animationRenderer.ts:477`、`animationAudio.ts:43` | `hasAudio === undefined` 被当成「有音轨」→ `-map 1:a` 在无音频流时直接退 1 | **✅ 已修复（Step 4）**：混音失败自动退回静音轨重试一次 |
| E5 | 「仅从素材库移除」+ 该片段有蒙版 → 每次导出必报「蒙版渲染失败」 | `ffmpegExporter.ts:672-673`（缺素材静默跳过）vs `1002-1004`（按数量校验） | 只有蒙版这一路是硬失败，其它路径都降级为背景色 | **✅ 已修复（Step 4）**：`maskedClips(project, availableUrls)` 只收「素材仍在导出源里」的片段 |
| E6 | 时间轴**任意一处空隙** + 任一转场 → **所有转场变成硬切**，且成片比时间轴短（片尾被截） | `exportPlan.ts:975-980` → `1418-1420`（gapped 路径只有 `concat`） | 有空隙就整体切到 gapped 计划，而 xfade 只在 contiguous 计划里实现 | **✅ 已修复（Step 4）**：gapped 路径也按「clip 单元相邻才叠化」生成 xfade |
| E7 | 音频失败后的**无声重试**丢 `maskInputs` → 蒙版静默不生效（整幅画面露出） | `ffmpegExporter.ts:1144`（`buildExportPlan(..., false, { range })`） | 重试重建计划时漏传蒙版索引 | **✅ 已修复（Step 4）**：把 `maskInputs` 提到外层并随重试传入 |
| E8 | 字幕/文字拖到视频结束之后 → 成片在视频末尾就停，尾字幕丢失 | `exportPlan.ts:996`（`getProjectDuration(project.clips)`）vs `timeline.ts:33`（含 text/audio 的总长） | 视频计划只按主轨算长度，文字层用同一个 `totalDuration` 一起被截 | **✅ 已修复（Step 4）**：尾部补齐目标改为 `max(视频, 音频末尾, 字幕末尾)`，沿用黑场补齐 |

**修复顺序建议**：E2（画面全毁，最严重）→ E3/E1/E4（同一根因：`hasAudio` 与 `kind`）→ E6（转场全丢）→ E8 → E5 → E7。
**根治点**：给视频素材补一次音轨探测（`-map 0:a?` 或解析 `-i` 日志的 `Audio:` 行）写入 `SourceInfo.hasAudio`，然后所有混音入口统一 `hasAudio !== true` 跳过。

---

## 4. P1：预览一致性（代码证据）

| # | 症状 | 位置 | 根因 | 状态 |
|---|---|---|---|---|
| V1 | 两段**不同素材**之间加转场：转场中「进入的画面」是静止的，转场结束瞬间跳帧、右段开头丢声 | `Preview.tsx:989-991`（重叠区只返回左段）、`914-939`（右段被 `prepareNext` 暂停在 0） | 重叠区只驱动左段 video，右段再没人按 `time - right.start` 推进/seek | **✅ 已修复（Step 5）**：新增 `syncEnteringSegment()`，重叠期按 `time - right.start` 驱动进入段（代码级，未做运行时验证） |
| V2 | 「像素化」转场画面基本全黑 / 只剩左上角放大碎片 | `transitionRender.ts:246-271`（离屏只有 1/block 大小，但几何按整幅算） | 缩放矩阵没跟着离屏尺寸走 | **✅ 已修复（Step 5）**：先在全尺寸离屏画，再缩到小块；单测已验证 ops 顺序 |
| V3 | 定格片段 / 空隙各卡约 1.5 秒 | `Preview.tsx:990-998`、`1042-1043`（只 `pause()` 没清 `activeElement`）+ `playbackClock.ts:99-105`（paused 有 1.5s 宽限） | 时钟把「我们主动暂停」误判为「缓冲/被阻止」 | **✅ 已修复（Step 5）**：新增 `suppressVideoClock`，空隙/定格/图片不再跟视频时钟；实测空隙内时间码单调推进 |
| V4 | 叠加轨点「隐藏」后**声音也没了**，但导出成片有声音 | `Preview.tsx:844-846`、`857-861` 用 `isOverlayVideoVisible` 门控声音；`tracks.ts:223` 里 hidden 只关画面 | 音量门控绑错变量 → 预览与导出不一致，用户会据此做错决定 | **✅ 已修复（Step 5）**：声音只看 `isOverlayAudioActive`，隐藏只影响绘制（代码级，未做运行时验证） |
| V5 | 字幕样式「悬停预览」永不刷新（松手才变） | `Preview.tsx:511-539` 用渲染期变量 `captionStylePreview`，而 `draw` 的依赖是 `[store]`（647） | `useCallback` 闭包永久冻结首帧值 | **✅ 已修复（Step 5）**：draw 内 `store.getState()` 现取 + 按该值变化重绘 |
| V6 | 空格暂停时画面往回跳最多 0.1s（逐帧精修对不准） | `Preview.tsx:942-949`（10Hz 同步）、`969-971`（`!isPlaying` 直接 return） | 暂停没有一次强制 `commitTime(time, force)` | **✅ 已修复（Step 5）**：`lastTickTime` + 暂停强制提交；实测暂停后稳定不回退 |

---

## 5. P2：数据安全与手感（会慢慢磨掉信任）

1. **刷新/关闭丢最后一次编辑**：保存只在 700ms 防抖计时器里，`VideoEditor.tsx:998-1002` 卸载时反而 `clearTimeout`；没有 `pagehide`/`visibilitychange` flush（`persistence.ts:115` 的 `flushProjectSave` 只被「切项目/新建」调用）。→ **✅ 已修复（Step 6）**：pagehide/visibilitychange + **localStorage 同步紧急快照**（实测通过，见第 10 节）
2. **只导入音频的会话没有 projectId**：`slices/assets.ts:61-79` 纯音频分支不分配 `projectId`，`VideoEditor.tsx:966-969` 直接 `if (!id) return` → 刷新后音频素材与 blob 全丢（界面还提示「再导入视频即可开始剪辑」）。→ **✅ 已修复（Step 6）**
3. **项目数到 20 后新项目静默不保存**：`projectLibrary.ts` 的 `PROJECT_LIMIT`，`beforeSave` 返回 false 只弹提示；用户继续剪，刷新即全丢。→ **✅ 已修复（Step 6）**：上限时**不允许新建**空项目（直接打开「最近项目」让用户删一个），保存被拒的警告只弹一次
4. **封面一加，音频/字幕轨整体左移 64px**：`AudioTracks.tsx:15,309`、`TextTracks.tsx:13,201` 硬编码 `PAD=12`，而 `Timeline.tsx:276` 的 `pad` 会因封面块变成 76。→ **✅ 已修复（Step 6）**：`pad` 作为 prop 传下去
5. **`pad` 没进 `useCallback` 依赖**：`Timeline.tsx:364-375/415`，加/删封面后点击定位、拖播放头会偏 64px，缩放一次才自愈。→ **✅ 已修复（Step 6）**
6. **音频/字幕片段单击即位移**：`AudioTracks.tsx:159`、`TextTracks.tsx:69` 用 `0.002 秒` 阈值（约 0.2px），视频用 5px 像素阈值。→ **✅ 已修复（Step 6）**：统一 5px
7. **低缩放时短片段整条都是手柄**：`Timeline.tsx:1911` `width = max(4, …)` + 手柄 9px×2 → 宽度 <18px 时拖不动（只能先放大）。→ **✅ 已修复（Step 6）**：宽度 < 26px 不渲染手柄（`MIN_HANDLE_WIDTH`）
8. **轨道左侧握把是死按钮**：`TrackControls.tsx:96-101` 调用 `onDragStart?.()`，但 `TrackGutter.tsx` 三处都没传。→ **✅ 已修复（Step 6）**：移除死控件，排序只保留 ↑/↓（也支持 Alt+↑/↓）
9. **锁轨后 Ctrl+X 仍能删**：`selection.ts:145-158` 的 `cutSelection` 没过滤锁定轨，`commands.ts:1166-1187` 的批量删除也不判锁；顺带 `toggleTrackFlag('locked')` 只清 `selectedClipId` 不清 `selectedIds`（状态打架）。→ **✅ 已修复（Step 6）**：批量删除按轨过滤，全部被过滤时返回原对象
10. **空改动也占一步撤销并清空 redo**：`operations.ts:698-719` 的 `updateClipInProject` 命中就换新引用，滑块拖回原值也进历史。→ **✅ 已修复（Step 6）**：patch 逐字段比较，全相同返回 null
11. **导出区间被不可撤销地夹取**：`internal.ts:147-149` + `exportRange.ts:36-40`，删尾部片段后 I/O 区间被夹短甚至清空，撤销工程也拿不回来。→ **✅ 已修复（Step 6）**：新增 `exportRangeRaw`（不夹取的原始值），`sync()` 从它重新推导

---

## 6. 性能与工程约束（决定「能不能剪长片」）

- **导出吞吐**：多线程 FFmpeg 下 1080p 约 **4.4× 实时**（10s → 44s）；3s/320×180 → 14s。按此外推：**5 分钟 1080p ≈ 20–25 分钟**，无 SAB 的单线程还要更慢（导出弹窗已提示）。这不是 bug，但会让人以为「卡死了」——建议：显示 ETA（按已编码帧率估算剩余时间）+ 完成预估。
- **内存**：导出期间同一视频在内存里可能存 3 份（MEMFS 输入、`Uint8Array` 副本、Blob），4K + 多字幕状态 + 长片有 OOM 风险（`Cannot enlarge memory arrays`）。
- **构建**：`vite build` 偶发 `remove …esbuild-xxx: Access is denied`（Windows 临时目录被占用/杀软扫描）；换 `TEMP` 到工程内即可。建议写进 README。

---

## 7. 分步修复计划（建议按此顺序，每步都可独立验收）

> 进度：**Step 1–7 全部完成**（P0 / 导出 / 预览 / 数据安全 / 回归 e2e）。详见第 10 节。

### Step 1｜半天｜恢复「键盘能用」（P0-1 + P0-2）✅ 已完成
- 快捷键迁到 `window` + `isEditorShortcut` 守卫；隐藏 input `blur`；弹窗关闭后 `rootRef.focus()`。
- `sync()` 校验 `selection` id；`undo/redo` 兜底改用「过滤后剩余第一项」。
- **验收**：导入后不点任何地方按 `Space` 能播；分割→撤销后 `Delete`/`Ctrl+B` 生效。

### Step 2｜半天｜恢复「能裁」（P0-3 + P0-4）✅ 已完成
- 转场标记移到顶部窄条（或缩到 14px + 只让图标收事件），手柄 z-index 提到标记之上。
- 图片：`sourceGrow`/`minDuration` 补 image 分支；图片不进 `<video>` 列表；`tick()` 对 image/freeze/gap 传 `video:null` 并 `commitTime()`+`draw()`。
- **验收**：接缝处可裁；图片可拖长；图片片段播放时间码推进。

### Step 3｜半天｜恢复「撤销不毁作品」（P0-5）✅ 已完成
- `removedClips` 改为记录用户意图；`reconcile` 恢复条件改 `projectRefs`；清理永久 `pendingReclaim`。
- **验收**：删片段→删素材→撤销两次，素材回库、画面恢复。

### Step 4｜2 天｜导出正确性（E1–E8）
按 E2 → E3/E1/E4 → E6 → E8 → E5 → E7 顺序；核心是**统一输入编号/注入顺序**与**真实探测 `hasAudio`**。
- **验收**：见第 8 节矩阵的 4 个导出用例。

### Step 5｜1 天｜预览与导出一致（V1–V6）
- 转场双段驱动；像素化按离屏尺寸缩放；freeze/gap 清 `activeElement`；叠加轨声音只看 `isOverlayAudioActive`；`captionStylePreview` 改 `store.getState()` 现取；暂停强制提交一次时间。
- **验收**：加转场后预览与导出抽帧对比一致（已有 `previewExportParity` 工具可复用）。

### Step 6｜1 天｜数据安全与手感（P2 1–11）
优先：`pagehide` flush、纯音频 `projectId`、封面 `pad`、音频/字幕 5px 阈值。

### Step 7｜1 天｜回归防线
把第 8 节矩阵补成 Playwright 用例（我写的探针可直接改）。

---

## 8. 回归测试矩阵（现在缺的正是这些）

| 用例 | 现状 | 建议断言 |
|---|---|---|
| 导入后直接 `Space` 播放 | 无 | 时间码 1s 内推进 |
| 分割→撤销→`Delete` | 无 | 片段数 1→2→1→0 |
| 接缝处拖 30px 裁剪 | 无 | 左右片段宽度都变化 |
| 图片片段拖右边缘到 6s | 无 | 片段时长 6.00s |
| 图片片段播放 2s | 无 | 时间码推进 & 画布非黑 |
| 删片段→删素材→撤销×2 | 无 | 素材卡片数回到 1，画布非黑 |
| 蒙版+文字导出 | 无 | 抽帧与预览同区域均值色差 < 阈值 |
| 叠加轨图片导出 | 无 | 第 2s 抽帧含该图片（非单帧） |
| 无音轨素材进叠加轨导出 | 无 | 导出成功（不靠"重试无声"） |
| 空隙+转场导出 | 无 | 成片含转场 + 总时长 = 时间轴总长 |
| 字幕超出视频末尾导出 | 无 | 成片时长 = `getProjectEnd` |

---

## 9. 手工复现清单（在你自己的浏览器里 3 分钟验证 P0）

1. 打开 `http://127.0.0.1:5173/`，点「导入素材」选一个本地视频。
2. **不点任何其他地方**，直接按 `Space` → 若播放头不动，命中 **P0-1**。
3. 点片段选中，拖动播放头到中间，`Ctrl+B` 分割，再 `Ctrl+Z` → 看片段是否还有高亮；直接按 `Delete` → 若没删，命中 **P0-2**。
4. 在分割出来的接缝处按住向右/左拖 → 若只是把片段选中，命中 **P0-3**。
5. 导入一张图片，拖它右边缘 → 若宽度不变，命中 **P0-4**；点播放 → 若时间码卡住，同样命中 P0-4。
6. 删掉片段 → 删掉素材库里那个素材 → `Ctrl+Z` 两次 → 若片段回来但显示「素材已移除」且画面黑，命中 **P0-5**。

---

## 10. 修复记录

### Step 1（已落地）：P0-1 快捷键作用域 + P0-2 撤销后选中失效

**改动文件**

| 文件 | 改动 |
|---|---|
| `src/editor/VideoEditor.tsx` | 快捷键从根节点 `onKeyDown` 改为 `window` 上的 `keydown`；作用域判定改用 `.framecut-host`（隐藏 file input 是 root 的兄弟节点）；隐藏 file input 不算「输入控件」；latest-ref 保存最新处理器；三个 file input 在 `change` 后 `blur()` |
| `src/editor/store/internal.ts` | `sync()` 写入 `selection` 前先 `idExists()` 校验，幽灵 id 直接忽略 |
| `src/editor/store/slices/history.ts` | 新增 `restoredSelection()`：id 有效 → 用它；命令显式 `null` → 清空；缺省或 id 已失效 → 按播放头就近回落 |
| `src/editor/store/slices/selection.ts` | `selectClip()` 对不存在的 id 直接返回，不再写幽灵选中 |
| `src/editor/core/selection.ts` | 新增纯函数 `selectionFallbackId(project, time)`：主轨 → 叠加轨 → 音频/字幕区间 → 第一个可选项 |
| `tests/store.test.ts` | +3 条：撤销分割/定格后选区有效且 Delete 生效；幽灵 id 不写入选区 |
| `tests/selection.test.ts` | +5 条：`selectionFallbackId` 的边界、跨轨回落、空工程返回 null |

**验证**

- `tsc -b`：0 错误；`eslint src tests`：0 error（14 条既有 warning）；`vitest`：**1061 passed / 2 skipped**（新增 8 条）。
- 真实浏览器（Edge + Playwright）探针：
  - **撤销分割**：2 段 → `Ctrl+Z` → 1 段且**该段被选中**（此前 `selectedBars = []`）→ 紧接着 `Delete` 真的删掉（片段 1 → 0）。
  - **焦点在 body**（弹窗关闭/点空白后的真实状态）：`Ctrl+B` 能分割（1→2）、`Delete` 能删除（2→1）、`Space` 能播放（时间码推进到 `00:00:00:27`），且焦点自动回收到根节点。
  - **焦点在隐藏 file input**（系统文件框返回后的状态）：`Space` 播放成功、`Delete` 删除成功。
  - **手感回归（重要）**：素材搜索框输入 `a b c` 空格保留、不触发播放；改名框输入 `my cut` + `Ctrl+B` 不分割；导出弹窗打开时 `Delete`/`Ctrl+B` 被正确屏蔽。
  - 主链路（导入→播放→分割→裁剪→拖动→删除→撤销）与干净页面运行均无失败请求、无报错。

**已知未做**：没有把快捷键搬进「可用 `keyboardScope.isEditorShortcut` 统一守卫」的版本（当前是等价的手写守卫）；等 Step 5 做预览/弹窗联动时可一起收敛。

### Step 2（已落地）：P0-3 接缝裁剪 + P0-4 图片片段

**改动文件**

| 文件 | 改动 |
|---|---|
| `src/editor/styles/editor.css` | `.transition-marker` 从「居中 18×18」改为「顶部 14×14」；`.clip-trim-handle` 从 `top:0` 改为 `top:14px`。两者垂直分离，不再互相抢命中 |
| `src/editor/components/Timeline.tsx` | 转场标记 `left: x - 9` → `x - 7`（宽度随 14px）；图片片段的拖动上下限补 `IMAGE_MIN_DURATION` / `IMAGE_MAX_DURATION`，`sourceGrow` 补 image 分支（与 `core/operations.ts` 对齐） |
| `src/editor/components/Preview.tsx` | `baseVideoUrls` 跳过 image 片段与 image 源（不再为图片渲染 `<video>`）；`tick()` 增加 image 分支：清空 `activeElement`、暂停旧元素、照常 `commitTime` + `draw` + 同步叠加/音频 |

**验证（真实浏览器）**

- 接缝命中：`elementFromPoint` 在接缝 −6px 命中「左段右手柄」、+3px 命中「右段左手柄」（修前 ±6px 全被 `transition-marker` 的 svg 吃掉）。
- 接缝裁剪：接缝处按住向左拖 30px → 左段 136px → **106px**，右段不变。
- 转场标记仍可点：`clicked: true`，不会被手柄挤掉。
- 图片拉长：右边缘拖 90px → 宽度 274 → **364**，时长 3.00s → **3.98s**（修前完全不动）。
- 图片播放：从 0 播放，时间码 `00:00:00:00 → 00:00:02:13` 连续推进，`<video>` 数量 **0**，无「浏览器阻止了视频播放」误报，画布非黑像素占比 **1**。
- 回归：全量单测 **1061 passed / 2 skipped**；视频播放/分割/撤销/删除链路仍正常，无失败请求。

### Step 3（已落地）：P0-5 删除素材后撤销变黑帧

**改动文件**

| 文件 | 改动 |
|---|---|
| `src/editor/store/editorStore.ts` | `PendingReclaimEntry` 拆成两个字段：`removedClips`（**用户意图**）+ 新增 `referencedAtDelete`（**删除那一刻的观察值**），并把「为什么不能用观察值推断意图」写进注释 |
| `src/editor/store/slices/assets.ts` | `removedClips` 记录 `options.removeClips` 而非 `options.removeClips && referenced`；删除命令的触发条件另用 `clipsRemovedNow`；`cleanupUnusedAssets` 补 `referencedAtDelete: false` |
| `src/editor/store/internal.ts` | `reconcilePendingAssets` 恢复条件改为 `projectRefs && (removedClips || !referencedAtDelete)`；「仍被引用 → 继续等」分支独立出来，语义更直白 |
| `tests/assetReclaim.test.ts` | +1 条：先删片段、再删素材（删除时已无引用）、撤销片段删除 → 素材必须回库且源有效 |

**语义边界（刻意保留）**

- 删除时片段还在引用 + 用户选「仅从素材库移除」→ **不恢复**（这是用户明确表达「片段留着、素材别在库里」，原有单测仍在守）。
- 删除时本来就没引用（清理闲置素材）→ 之后任何引用只可能来自撤销 → **恢复**。
- 用户选「删除素材及关联片段」→ 撤销带回片段时 **恢复**（原有行为）。

**验证**

- 单测：`assetReclaim` 10 条全绿（含新增用例）；全量 **1061 passed / 2 skipped**。
- 真实浏览器（修前 vs 修后，同一操作序列「删片段 → 删素材 → 撤销两次」）：

| 指标 | 修前 | 修后 |
|---|---|---|
| 素材卡片数 | 0 | **1** |
| 片段文字 | 「素材已移除」 | **「01 视频 3.0s」** |
| 预览画面非黑像素占比 | **0**（全黑） | **0.88** |

### Step 4（进行中，已完成 E1 / E2 / E3 / E7）

**改动文件**

| 文件 | 改动 |
|---|---|
| `src/editor/services/ffmpegExporter.ts` | 新增 `buildExportInputArgs()`：把「媒体 → 蒙版 → 文字 → 封面」的注入顺序固定成纯函数，两处调用点（首轮 / 无声重试）都改用它；`maskInputsByClip` 提到外层，重试时一并传回 `buildExportPlan`（E7） |
| `src/editor/core/exportPlan.ts` | `ensureOverlayInput` 补 `kind`（E3）；`applyAudioTracks(..., silent)` 新增 silent 分支——无声重试**一条音频分支都不建**（E1）；音频轨/叠加轨两处循环把「图片 / `hasAudio:false` 跳过」从「仅音频导出模式」改为无条件（E1） |
| `tests/maskExport.test.ts` | +2 条：`buildExportInputArgs` 的组合顺序、以及「先文字后蒙版」旧写法的反向对照 |
| `tests/exportPlan.test.ts` | +3 条：无声导出连音频轨一起关掉、叠加图片 `kind=image` 且 args 带 `-loop`、叠加图片不生成 `[n:a]` |

**语义说明（E1）**

`sourceHasAudio === false` 现在等价于「本轮不要任何声音」，连音频轨/叠加轨都不参与混音。这正是「无声重试」应有的语义；此前它只关掉主轨，重试仍会为无音轨素材生成 `[n:a]`，第二次同样退 1，用户看到的是「导出永远失败」。

**验证**

- 单测：新增 5 条全绿，全量 **1067 passed / 2 skipped**；`tsc` 0 错误、`eslint` 0 error。
- 真实浏览器（蒙版矩形 + 文本片段 + 480p 导出）：导出 **14s 成功**，抽 0.5s 帧统计 `YAVG=84.2 / YLOW=16 / YHIGH=205`——亮度跨度大说明是**真实画面**；若输入编号仍错位，整屏会被最后一张蒙版 PNG 盖住，亮度会接近均匀。控制台 0 错。
- 反向对照单测把「先文字后蒙版」的旧写法钉住：它确实会让 `text.txt` 排在 `m1.png` 之前，与 `exportInputLayout` 的编号矛盾。

**Step 4 剩余**：E5（缺素材 + 蒙版硬失败）。E4 / E6 / E8 已于本轮完成，见下。

### Step 4（续）：E4 / E6 / E8

| 条目 | 改动 | 说明 |
|---|---|---|
| **E4** | `animationRenderer.ts` 把 mux 参数抽成 `buildMuxArgs(plan)`，首次混音失败且不是静音计划时，自动用 `planAnimatedClipAudio(clip, null, false)` **退回静音轨重试一次** | 动画烘焙发生在导出层「无声重试」之前，所以它一旦失败就是整次导出失败。源本来没有音轨时静音就是正确结果，不需要报错 |
| **E6** | `exportPlan.ts` 的 `buildGappedExportPlan` 增加 `transitionAtUnit()`：只有「clip 单元紧跟 clip 单元」才可能有叠化，gap 单元处恒为硬切；有转场时用累加器 + `xfade`，否则保持原来的单条 `concat` | 修前：时间轴只要有一处空隙，所有转场都变硬切（预览有渐变、成片全是切） |
| **E8** | `applyAudioTracks` 的尾部补齐目标从 `max(视频, 音频末尾)` 改为 `max(视频, 音频末尾, 字幕末尾)`；并补上「没有任何音频分支时也要补黑场」的分支 | 沿用既有的**黑场补齐**而不是克隆末帧——预览在视频结束处也是黑场，两边观感一致。曾尝试克隆末帧，被 `audio.test.ts` 的既有断言挡下，说明黑场才是项目既有语义 |

**新增回归测试（4 条）**

- `字幕超出视频末尾时的成片总长`：`totalDuration` 覆盖字幕末尾、`tpad=stop_mode=add` 补 3s、`-t` 用工程总长。
- `空隙与转场共存`：gapped 路径仍生成 `xfade=transition=fade`，且 gap 处仍是 `concat`。
- 其余两条在 Step 4 前半段已列（输入顺序 / 叠加图片 kind）。

**验证**：全量 **1069 passed / 2 skipped**；`tsc` / `eslint` 0 错误；真实浏览器「蒙版矩形 + 文本 + 480p 导出」14s 成功，抽帧 `YAVG=84.2 / YLOW=16 / YHIGH=205`，控制台 0 错。

**Step 4 仅剩**：E5（「仅从素材库移除」+ 蒙版 → 硬报「蒙版渲染失败」）。

### Step 4（收尾）：E5

`maskedClips(project, availableUrls?)` 增加可选过滤：只收集「素材仍在导出源里」的带蒙版片段。导出侧传入 `new Set(sources.map(s => s.url))`，于是缺失素材的蒙版不会被收进来 → 数量校验不再失败，该片段像其它路径一样降级为画布背景。

保留原语义：不传 `availableUrls` 时行为不变（单测/预览等调用点无需改动）。

**新增回归测试**：`maskedClips 排除素材已不在导出源里的片段`（不传 → 收集；传空集合 → 不收集；包含它 → 收集）。

### Step 5（已完成 V3 / V4 / V5 / V6，V1 / V2 待做）

| 条目 | 改动 |
|---|---|
| **V3** 定格/空隙卡 1.5s | `Preview.tsx` 新增循环内 `suppressVideoClock` 标志位：空隙、定格、图片片段都不再把「我们主动 pause 的 video」喂给时钟，时钟退回墙钟。**刻意没有每帧清 `activeElement`** —— 那会让 `switching` 每帧成立、时钟反复重锚，播放头反而完全不动（本轮踩过这个坑，注释已写明） |
| **V4** 叠加轨隐藏就静音 | 声音门控改为只看 `isOverlayAudioActive + 当前时刻有片段`，不再绑 `isOverlayVideoVisible`；驱动条件改为「画面隐藏**且**音频未启用」才停，因此隐藏画面时元素继续播放出声，绘制侧仍按 visible 跳过 |
| **V5** 字幕样式悬停不刷新 | `draw` 内改为 `store.getState().captionStylePreview` 现取；新增「按该值变化重绘」的 effect（同时消除未使用变量告警） |
| **V6** 暂停回退 ≤0.1s | 循环内记录 `lastTickTime`；`!isPlaying` 的退出路径改为先 `commitTime(now, lastTickTime, true)` 再 return |

**验证**

- 单测：全量 **1070 passed / 2 skipped**；`tsc` 0 错误。
- 真实浏览器：
  - **V3**：把片段右移造出 153px 空隙，从 0 播放，时间码 `0:00 → 0:12 → 0:24 → 1:00 … 2:29` 每 200ms 单调推进，**没有 1.5s 冻结**。
  - **V6**：暂停后 `2:29 → 3:02` 并稳定在 `3:02`（等待 400ms 不再变化），**不再回退**到 10Hz 采样点。
  - **V4**：本环境两次导入同一素材都落在主轨，没能造出「叠加轨 + 隐藏」的 UI 现场，因此**只做了代码级修正**（并有 `tracks.ts` 的语义单测兜底），未做运行时验证——如实标注。

**Step 5 剩余**：V1（转场重叠区右段不推进，需双段驱动）、V2（像素化转场按离屏尺寸缩放）。

### Step 5（收尾）：V1 / V2

| 条目 | 改动 |
|---|---|
| **V2** 像素化转场画面全黑 | `transitionRender.ts` 的 `pixelize()` 改为两步：先在**全尺寸**离屏画布上 `drawLeft/drawRight`（几何本来按整幅算），再用 `imageSmoothingEnabled=false` 缩到 1/block 的小画布，最后放大回主画布。修前直接画进小块画布，画面被整体推出画布外（或只剩左上角一块） |
| **V1** 转场中「进入的画面」静止 | `Preview.tsx` 新增 `syncEnteringSegment()`：`segmentsAt()` 命中 ≥2 段时，取最后一段（进入段），按 `time - entering.start` 限流 seek（200ms/0.15s 阈值）并让它 `play()`；音量保持 0，切换后由常规路径接管，避免两声叠加。与左段共用同一 `<video>`（同源相邻片段）时直接跳过，否则会把主音轨静音 |

**验证**

- **V2**：新增单测断言像素化会创建 `1920x1080` 全尺寸离屏 + 一个小块离屏 + 主画布 `drawImage`；实现侧已用临时调试用例确认实际 ops 顺序为「createCanvas:66x37 → createCanvas:1920x1080 → 全尺寸上 drawLeft → off66x37 drawImage → main drawImage」。
- **V1**：**仅代码级修正，未做运行时验证**。原因如实记录：本环境多次尝试一次导入两个不同素材，编辑器都只保留 1 个主轨片段（第二个文件没有形成第二段/叠加轨），因此造不出「不同素材 + 接缝 + 转场」的 UI 现场。逻辑上已加双层保护（同源共用元素时跳过、进入段音量置 0）。
- 全量：**1071 passed / 2 skipped**；`tsc` 0 错误；`eslint` 退出码 0。

**至此 Step 5 全部条目（V1–V6）均已落地，其中 V4 / V1 属代码级修正，V2 / V3 / V5 / V6 有运行时或单测证据。**

### Step 6（已落地 8 条，剩 3 条）

| 条目 | 改动 |
|---|---|
| **P2-1 刷新丢最后一次编辑** | `VideoEditor.tsx` 注册 `pagehide` + `visibilitychange(hidden)`，并在卸载时 flush。**关键发现**：只调 `flushProjectSave()` 不够——IDB 写事务在页面卸载时会被中止（用探针确认 pagehide/visibilitychange 都触发了，但记录没落盘）。所以补了一层 **localStorage 同步紧急快照**（`draftStore.writeEmergencyDraft`），下次启动时 `loadProjectRecord/loadProjectRecords` 若发现快照比 IDB 记录新就优先用它，正常落盘后自动清除。 |
| **P2-2 纯音频会话没有 projectId** | `slices/assets.ts` 的空会话「只有音频」分支同样分配 `projectId`（并跟随首个素材命名），草稿才会落盘 |
| **P2-4 封面导致音频/字幕轨偏移 64px** | `AudioTracks` / `TextTracks` 新增 `pad` prop（默认仍是 12），`Timeline` 传入真实 `pad`（有封面时 76） |
| **P2-5 `pad` 没进 `useCallback` 依赖** | `seekFromClientX` / `movePlayheadTo` 的依赖数组补 `pad`，加/删封面后点击定位不再偏 64px |
| **P2-6 音频/字幕单击就位移** | 阈值从 `0.002s` 改成 **5px**（乘 `pps` 换算），与视频片段一致 |
| **P2-8 轨道握把是死按钮** | 删除 `track-drag-handle`（`TrackGutter` 从未传 `onDragStart`），排序只保留 ↑/↓ 与 Alt+↑/↓ |
| **P2-9 锁轨后 Ctrl+X 仍能删** | `createDeleteManyCommand` 按轨过滤锁定片段，全部被过滤时返回**原对象**（不进历史、不清 redo） |
| **P2-10 空改动占一步撤销** | `updateClipInProject` 增加 `patchChangesClip()`：patch 逐字段（对象做浅比较）与现值全相同 → 返回 null，调用方 `?? project` 后引用不变 |

**新增测试（6 条）**

- `draftEmergency.test.ts`（新文件 3 条）：紧急快照可回放、比 IDB 旧时不覆盖、localStorage 抛错时安全降级
- `assetRemoval.test.ts` +2：纯音频首次导入分配 `projectId`；`createDeleteManyCommand` 跳过锁定轨且全锁时返回原对象
- `operations.test.ts` +3：空 patch 返回 null / 真改动返回新对象 / 片段不存在仍返回 null

**验证**

- 全量 **1079 passed / 2 skipped**；`tsc` 0 错误；`eslint` 退出码 0（14 条既有 warning）。
- **运行时实测（P2-1）**：导入 → 等自动保存 → 分割成 2 段 → **120ms 后立刻刷新** → 从「最近项目」打开 → **仍是 2 段（PASS）**。修复前同样的操作只剩 1 段。
- 写这条修复时被自己的测试抓到一个真实缺陷：`typeof localStorage` 在「访问即抛错」的隐私模式下也会抛，已改为 `safeStorage()` 统一兜住（第 3 条测试就是在守这个）。

**Step 6 剩余**：P2-3（项目数到 20 后新项目静默不保存）、P2-7（低缩放时窄片段整条都是手柄）、P2-11（导出区间被不可撤销地夹取）。

### Step 6（收尾）：P2-3 / P2-7 / P2-11

| 条目 | 改动 |
|---|---|
| **P2-3 项目上限静默失败** | `newProject` 先查 `countProjectRecords()`：已满则**不开新会话**，提示并直接打开「最近项目」让用户删一个；`beforeSave` 里的警告改为**每会话只弹一次**（以前每 700ms 弹一次，而内容一直没落盘） |
| **P2-7 窄片段整条是手柄** | 新增 `MIN_HANDLE_WIDTH = 26`：主轨与叠加轨片段宽度不足该值时，左右手柄 `display:none`，整条片段恢复成可拖动/可换轨（以前宽度 < 18px 时按下去永远进入裁剪） |
| **P2-11 导出区间不可撤销夹取** | 新增会话态 `exportRangeRaw`（用户点出的原始入/出点，**不夹取**）；`setExportInPoint/OutPoint/RangeEdge` 同时写 raw 与夹取结果，`clearExportRange` 清两者；`sync()` 改为从 `exportRangeRaw ?? exportRange` 重新推导 —— 工程变短被夹小、撤销恢复后区间会自动回来。三个 reset 路径（`clearSource` / `clearProject` / `hydrateDraft`）都同步维护该字段 |

**新增测试（2 条，均在 `store.test.ts`）**

- 设 I/O 2–10s → 删光片段（区间被夹成 null，raw 仍在）→ 撤销 → 区间恢复 2–10s
- `clearExportRange` 同时清空 raw（不会在别处复活）

**验证**

- 全量 **1081 passed / 2 skipped**；`tsc` 0 错误；`eslint` 退出码 0。
- 端到端冒烟：导入 → 空格播放 → 分割 → 撤销（仍选中）→ 删除 → 撤销 → 导出 **14s 完成**，控制台 0 错。
- **P2-7 运行时实测**：缩到最小缩放并切出 7px 片段 → 两个手柄 `display:none`（`handlesHidden: true`）、中心命中 `div.clip-bar`（不是手柄）、拖动生效（left 13 → 53）；相邻 61px 片段仍保留手柄。

**至此 Step 6 的 11 条全部完成。**

### Step 7（已落地）：把回归矩阵变成可执行的 e2e

**新增 `e2e/regression-matrix.spec.ts`（9 条）**，每条对应报告里的编号，且**都不依赖 FFmpeg 导出**（秒级）：

| 用例 | 守护的修复 |
|---|---|
| P0-1 导入后不点任何地方，空格就能播放 | 快捷键作用域（window + `.framecut-host`） |
| P0-1b 焦点停在隐藏 file input 时，空格/Delete 仍有效 | 文件选择框返回后的焦点场景 |
| P0-2 分割→撤销后仍选中，紧接着 Delete 能删掉 | `restoredSelection` + `sync` 校验 id |
| P0-3 接缝处可以裁剪 | 转场标记让位给裁剪手柄 |
| P0-4 图片可拉长 + 播放推进 + 画布有内容 | image 时长上限 + 图片不再占用 `<video>` 时钟 |
| P0-5 删片段→删素材→撤销：素材回库、画面不黑 | `removedClips` / `referencedAtDelete` 拆解 |
| P2-1 编辑后立刻刷新不丢改动 | localStorage 紧急快照 |
| P2-7 窄片段隐藏手柄、仍可拖动 | `MIN_HANDLE_WIDTH` |
| P2-11 工程变短夹取后撤销，区间恢复 | `exportRangeRaw` |

**配套改动**

- `playwright.config.ts`：新增 `edge` project（`channel: 'msedge'`）。本机没有下载 Playwright 浏览器，用**系统 Edge** 也能跑回归：`pnpm exec playwright test --project=edge`。原 chromium / firefox 配置未动。
- `scripts/make-test-fixture.mjs`：除 `clip.mp4` 外再生成 `still.png`（图片用例需要真实 PNG），并修正「只缺一个文件也要补齐」的早退逻辑。

**验证**

- `playwright test --project=edge e2e/regression-matrix.spec.ts` → **9 passed（38–41s）**。
- 既有快速用例回归（同样跑在 edge 上）：`draft-restore` / `replay` / `editing-drag` → **5 passed（22.6s）**，说明 pagehide/紧急快照的改动没有破坏原有草稿恢复语义。
- `tsc -b`（含 `tsconfig.e2e.json`）0 错误；`eslint` 0 错误；单测 **1081 passed / 2 skipped**。

**注意**：`--project=edge` 只是让本地/无浏览器环境也能跑；CI 的完整回归仍建议用 chromium + firefox（需 `pnpm exec playwright install`）。

### Step 7（续）：在系统 Edge 上跑完整 e2e 套件

本机**没有下载 Playwright 浏览器**，且实测 `playwright install chromium` 在 10 分钟内下载量为 **0 字节**（网络不可用），已终止并清理了空目录。因此改用 `--project=edge`（系统 Edge）跑完整套件：

| 套件 | 结果 |
|---|---|
| **完整 e2e（全部 spec）** | **22 passed / 2.2 分钟** |
| 其中：新增回归矩阵 | 9 passed（38–41s） |
| 其中：`import-export`（真实 FFmpeg 导出） | 1 passed（23.8s，输出 1.5s / h264 / **aac** / 34KB） |
| 其中：`animation-mask-parity` | 2 passed（蒙版保留区 预览 `50,102,203` vs 导出 `57,104,191`；背景区 `200,30,30` vs `188,40,40`） |
| 其中：`overlay-blend` / `main-rotation` / `preview-export` | 3 passed（画中画内外差值 5、混合模式差值 2.3；基线对照差值 79） |
| 其中：`draft-restore` / `replay` / `editing-drag` | 5 passed |
| 其中：`project-import-persist` / `project-import-skip` | 2 passed |

**这组数字的意义**：`import-export` 证明主导出链路（含音轨）仍正常；三组 parity 用「预览 vs 导出同区域像素差」直接验证了我在 Step 4 改动的导出输入顺序（E2）、叠加合成（E3/E6）没有把画面搞坏——差值都在 2–5 的量级，而未受影响项目的基线对照是 79。这是比"能导出"更强的证据。

---

## 11. 第二轮排查（审查里未验证的"可疑项"）

第一轮修完后，把四份审查里标为「可疑，需运行时验证」的条目逐条验证。**大部分不成立**（如实记录，避免后人重复排查）：

| 可疑项 | 结论 |
|---|---|
| 双击片段被 `preventDefault` 吃掉（部分浏览器） | **不成立**：实测单击只选中（`00:00:00:00`）、双击定位到 `00:00:01:23` |
| 锁定轨上的音频片段被当成空白点击 → 跳播放头 | **不成立**：实测点击音频片段播放头不跳（`08:14 → 08:14`）、片段保持选中 |
| 音频片段双击能否定位 | 与视频片段不一致（双击不定位），属产品取舍，**未改** |

**确认为真实 bug 并已修复（2 条）**

### N1｜删别的项目会误删当前会话「尚未落盘」的新素材 blob（数据丢失）

- 位置：`services/draftStore.ts#deleteDraftProject`
- 场景：在项目 A 里刚导入素材（还在 700ms 防抖窗口内、草稿没落盘）→ 去「最近项目」删掉项目 B
- 根因：该函数只按**已落盘的快照**判定 blob 引用（`loadProjectRecords()`），而 A 的新素材不在里面 → 被判孤儿删掉。当前会话看起来正常，**刷新后素材全丢**（片段变占位）
- 修法：给 `deleteDraftProject(id, { stillReferenced })` 加与 `deleteMediaBlobIfUnreferenced` 一致的保护；调用点在**删的不是当前项目**时传入当前会话的素材 id（删自己时素材本就该回收）
- 证据：新增 `tests/draftProjectDelete.test.ts` 复现——修前 `removed = ['a-new','b-old']`（把当前会话的新 blob 删了），修后只回收 `b-old`

### N2｜片段解码失败时画面永久停在上一段，且无任何提示

- 位置：`components/Preview.tsx`（保留最后一帧的分支 + `<video>` 渲染）
- 根因：切换片段时"保留上一帧"是为了避免黑闪（合理），但如果源**永久解不出来**（文件损坏 / blob 已失效 / 编码不支持），就会一直停住；`<video>` 没有 `error` 监听，用户看到的是"播放卡住了"
- 修法：`<video>` 增加 `onError` / `onLoadedData`，按 url 记录错误集合；`draw()` 里命中错误集合时**清屏 + 提示一次**（"「X」无法解码，画面显示为背景色"），不再保留旧帧
- 证据：浏览器实测——把 `<video>` 的 src 改成不存在的 blob URL 后，画布非黑像素占比从 **0.879 → 0**（清屏），并弹出提示；修前会继续显示旧画面
- 注：`draw` 内查素材名改用 `store.getState()`（不能用外部 `assetForClip`），否则会新增一条 `exhaustive-deps` 违规（仓库的 suppressions 按"文件+规则+数量"配额，超一条就全线变红）

**验证**：全量单测 **1083 passed / 2 skipped**；`tsc` 0 错误；`eslint` 0 错误；完整 e2e **22 passed**。

### N3｜FFmpeg 核心加载无超时 → 永久卡在「正在加载 0%」

- 位置：`services/ffmpegRuntime.ts#loadCore`
- 根因：`@ffmpeg/ffmpeg` 的 `load()` 靠 worker 回消息才 settle。如果 **class worker 脚本本身**加载失败（资源 404 / 宿主没托管 dist-lib 的 worker / CSP 禁 module worker），`load()` 永远不 resolve —— 界面卡在「正在加载 FFmpeg…（0%）」，取消后重试同样卡死，用户只能刷新
- 修法：加载加 45s 超时（`LOAD_TIMEOUT_MS`，测试可调小）；超时后 `terminate()` 掉卡住的 worker 并抛可读错误「可能是核心资源 404 或 Worker 被拦截，请刷新页面后重试」；`acquireRuntime` 既有的失败清理会让下一次导出可重试
- 验证边界（如实记录）：单测 2 条（load 永久挂起 → 限定时间内 reject + terminate + 可重试；且不会被误判成「多线程加载失败并降级」）。**运行时只验证了「核心 js 404 会给可读错误」**（1s 内报错）——那条路径本来就会正常 reject，与本修复不等价；真正的 worker 层静默挂起难以在本环境构造

### N4｜MP3 编码器探测绕过队列、无超时、失败永久缓存

- 位置：`services/ffmpegRuntime.ts#isMp3EncoderAvailable`
- 三个问题：① 直接 `handle.ffmpeg.exec(...)`，绕开串行队列，可能与导出并发；② 没有超时，exec 挂起时 Promise 永不 settle → 导出弹窗 `checkingMp3` 永远为 true → 格式按钮全部禁用，只能关窗重开；③ 失败把 `false` 写进缓存，环境恢复后也再探测不了
- 修法：改用 `enqueue` + `execNow`（同一队列）+ `probeTimeoutMs` 超时；超时/加载失败**不写缓存**
- 验证：单测 3 条（两种正常结果、挂起时超时返回 false 且下次可重试、与其它 exec 严格串行）；真实导出 e2e 回归通过（1.5s / 含 aac）

### N5｜关键帧带吞掉片段底部的手势

- 位置：`components/ClipKeyframeBand.tsx`
- 两个问题：① 根节点无条件 `stopPropagation` → 片段底部 8px 既拖不动也选不中；② `beginDrag` 里 `stopPropagation` 排在「有没有关键帧」判断**之后**，按在菱形上但 t 有偏差时会放行冒泡 → 想拖关键帧却把整个片段拖走
- 修法：根节点不再拦截（点自己的 handler 已 stopPropagation）；`beginDrag` 把 stopPropagation 提到判断之前
- 验证（运行时）：带子空白处拖动 `left 13px → 58px`（片段移动）；关键帧点上拖动 `58px → 58px`（片段不动）

**本轮验证**：全量单测 **1088 passed / 2 skipped**（+5）；`tsc` 0 错误；`eslint` 0 错误；真实导出 e2e 通过。

### N6｜换轨命中用全局查询 → 同页两个编辑器会串台

- 位置：`components/Timeline.tsx` 的片段拖动 `handleMove`
- 根因：`document.querySelector('.clip-lane')` / `document.querySelectorAll('[data-overlay-track-id]')` 都是**全局查询**。同一文件里落点识别（`handleAssetDrop` 那条路径）特意注释过「不用 document.querySelector」，这里没跟上 —— 宿主页面嵌两个 `<VideoEditor>` 时，拖 A 的片段会命中 B 的泳道，片段被丢进另一个实例的轨道
- 修法：改为从当前时间轴的 `contentRef.current` 内查询
- 验证：主轨片段拖进叠加轨 `main 1→0 / overlay 0→1`（实例内查询仍能正确命中）。**注**：真正的「双实例」现场没构造（demo 只挂一个编辑器），隔离性由代码作用域保证

### N7｜`window` 的 pointerup 收尾不校验 pointerId → 多指误提交

- 位置：`Timeline.tsx`（边缘裁剪 / 片段拖动）、`AudioTracks.tsx`、`TextTracks.tsx` 共 7 处 `window.pointerup` 的 `finish`
- 根因：`finish` 是无参函数，任何指针抬起都会提交当前拖拽。鼠标单指无感，但**触屏/手写笔第二根手指抬起**会把进行中的裁剪/拖动提前提交
- 修法：`finish(event)` 接收事件 + 复用既有的 `matchesPointer(current, event)`（注意不能写 `if (!drag.pointerId)` —— Firefox 鼠标 pointerId 可能是 0）
- 验证（运行时）：边缘裁剪 274→224、片段拖动 13→73（守卫没破坏正常拖拽）；拖动中伪造 `pointerId=99` 的 pointerup → 位置不变（未提前提交），真实抬起才提交（73→13）

**本轮验证**：全量单测 **1088 passed / 2 skipped**；`tsc` / `eslint` 0 错误；完整 e2e **22 passed**。

### N8｜blob 读不到时整份草稿打不开（比预想更严重）

- 位置：`services/draftStore.ts#restoreDraft`
- 场景：本地素材的 blob 读不出来（配额不足导致当时没写进去、或被浏览器清理）
- 根因：`if (!blob) continue` —— 素材既不进 `assets`、也不进 `missingAssets`，随后 `pruneProjectUrls` 用 `available` 把引用它的片段全部剔除
- **负向对照实测揭示了更严重的后果**：不只是「片段消失」，而是 `assets.length === 0 && getProjectEnd(project) <= 0` 成立 → **整份草稿被判定为不可恢复、直接返回 null**（用户打开项目什么都没有）
- 修法：这类素材改记为 `missingAssets`（复用 `missingAssetFromDraft`），`keepUrls` 因此包含其 url，片段以「素材已移除」占位保留 —— 与导入工程时跳过素材的处理一致
- 验证：新增 2 条单测（blob 缺失 → 片段保留 + missingAssets 记录；blob 正常 → 不进 missingAssets）；负向对照下第一条失败（`expected null not to be null`）。相关 e2e 3 条通过

### N9｜磁吸夹紧对所有命令生效 → 撤销/重做基准漂移

- 位置：`store/internal.ts#run`
- 根因：`run()` 对**每条命令**都套 `clampMainTrackStart`。链条：开磁吸 → 首段有间隙 → 某命令贴齐 → 撤销回到带间隙的底稿（`sync()` 按注释故意不夹）→ 再改个不透明度 → **又被夹回 0**，撤销/重做从此以不同底稿计算
- 修法：新增 `mainTrackLayoutChanged(before, after)` —— 只有片段顺序或 `gapBefore` 真的变了才夹。属性/颜色/速度类命令不再抹掉空隙；拖动/删除/裁剪/排序仍然贴齐
- 验证：2 条单测（非布局命令不夹 / 布局命令仍然贴齐）；负向对照下「改旋转」把间隙从 2 夹到 0，用例失败

**本轮验证**：全量单测 **1092 passed / 2 skipped**（+4）；`tsc` / `eslint` 0 错误；完整 e2e **22 passed**。

### N10（体验补强）｜导出进度显示剩余时间估计（ETA）

- 背景：FFmpeg.wasm 合成 1080p 约 4–5 倍实时（1080p 10s 素材实测 42s；按此外推 5 分钟片子 20 分钟以上）。只有百分比时，用户很容易以为卡死，然后取消掉一个其实在正常推进的任务
- 实现：新增纯函数 `core/exportEta.ts`，用最近 20s 窗口的实际速率外推；信息不足返回 null（宁可不显示也不给假数字）；`ExportDialog` 按 0.5%/1s 密度采样、rendering 阶段每秒重算，显示「约 X 分 Y 秒后完成」
- **实测发现并修掉一个精度问题**：`onProgress` 在读素材/写 VFS 阶段也会被调用（传 0），这些样本混进窗口后速率被严重低估 —— 第一版 16% 时显示「还要 1 分 47 秒」，实际只剩 25s（高估 4 倍）。改为只在 `stage === 'rendering'` 采样（用 ref 读实时阶段，因为 `onProgress` 闭包里的 stage 永远是旧值）
- 修复后实测（同一 42s 导出）：15s 时「约 21 秒」（实际剩 27s，误差 6s）、17s 时「约 23 秒」（实际剩 25s，误差 2s）
- 新增 9 条单测（样本不足 / 停滞 / 稳定外推 / 变速 / 过低速率 / 100% / 非法值 / formatEta 四种写法）

### N11（体验补强）｜内存风险分级补上「输出分辨率」维度

- 现状：原有预检只看「参与导出的素材总量 > 1.5GB」，**不看输出分辨率**。同样 1.4GB 素材，4K 的滤镜链与帧缓冲约要吃 4 倍于 1080p 的内存
- 为什么重要：FFmpeg.wasm 超内存是**硬失败**（`Cannot enlarge memory arrays`），且通常发生在进度 80–90% —— 用户等了十几分钟才失败，这是最伤人的失败方式
- 实现：新增纯函数 `core/memoryRisk.ts`。压力 = 素材体积 × 分辨率权重（480p:1 / 720p:2.25 / 1080p:5 / 4K:20）+ 动画帧额外驻留，分 ok / warn / risk 三级。**刻意不在界面展示"预计占用 X GB"** —— 那个数字不可能准，反而误导
- 建议按收益排序：先降画质（4K→1080P 约降到 1/4）→ 减少关键帧动画 → 分段导出 → 关闭其它标签页。risk 用强调色与普通警告区分
- 验证：6 条单测（小素材不报警 / 同素材量 4K 比 1080p 升级 / 建议排序 / 动画帧单独触发 risk / warn 中间地带 / 非法输入）。UI 实测：`ok` 状态不显示警告；临时把阈值调低后确认 `is-risk` 样式与建议列表正确渲染（文案含分辨率、2 条建议），随后还原阈值并复验

### N12｜导出自检绕队列、用错句柄、超时会误伤后台任务

- 位置：`services/ffmpegRuntime.ts#probeWithTimeout` / `probeRuntimeForExport` / `probeRuntimeForAudio`
- 三处问题：
  1. **绕队列**：`probeWithTimeout` 直接 `ffmpeg.exec(...)`，会与正在跑的导出/倒放/ASR **并发**抢同一个 worker —— 两个 exec 同时进同一个实例，轻则结果错乱，重则双双卡死
  2. **用错句柄**：两个 probe 自己 `acquireRuntime()`。若期间运行时被别的任务重启过，拿到的是另一个代次：自检结果对不上真正要用的实例，要探测的输入文件在新实例的 MEMFS 里可能根本不存在
  3. **超时误伤**：超时必然 `terminateRuntime()`（wasm exec 无法中断，只能销毁 worker），与别人并发时会把别的任务一起杀掉
- 修法：`probeWithTimeout` 全程在 `enqueue` 内执行，**超时计时从「拿到执行权」开始**（前面合法的长任务不会把自检误判成超时）；两个 probe 增加可选 `handle` 参数，导出流程传入自己的 `loaded`；因为不再并发，超时的 `terminate` 不会打断任何正在跑的任务
- 验证：3 条单测（串行不并发 / 传句柄时不重新 acquire / 超时后运行时重建且后续任务能继续）；**负向对照**：把 `enqueue` 去掉后「自检与其它 exec 串行」失败。真实导出 e2e 通过（1.5s / 含 aac）

---

## 附录：证据文件

- 探针脚本（只读测试，不是产品代码）：`.verify/probe/*.mjs`
- 运行结果 JSON：`interactions.json`、`playback-cases.json`、`seam-image.json`、`selection-hotkey2.json`、`focus-and-gap.json`、`asset-export.json`、`media-import.json`、`layout-matrix.json`、`perf-many-clips.json`
- 截图：`.verify/probe/*.png`（含 `p11-seam.png`、`p11-image-trim.png`、`p13-asset-undo2.png`、`p9-after-undo-split.png`）
- 测试素材：`.verify/probe/media/`（1080p/4K/HEVC/MP3/PNG/2 分钟 1080p，均由 ffmpeg-static 生成，可删除）