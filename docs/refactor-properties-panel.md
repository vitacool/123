# 重构方案：视频/叠加片段属性面板改为 4 Tab

> 状态：**已实施并验证**（4 tab + 固定头部、每 section 折叠与「恢复默认值」、切 tab 记住滚动位置；
> `pnpm typecheck` 与 `pnpm test`（30 文件 / 347 测试）全绿，CDP 断言见下表）
>
> 目标文件：`src/editor/components/PropertiesPanel.tsx`（629 行）
>
> 约束：不改 `core/` 数据结构；不改 store 既有 action 签名（可新增 action）；不改组件 DOM class 名（可新增 class）；文案中文。

---

## 1. 现状

视频/叠加片段面板当前把 **11 个 section 纵向平铺**，`变速`、`音频` 要滚动 6 屏才能看到。

面板自身的 section（`PropertiesPanel.tsx`）：

| 行号 | section | 说明 |
| ---: | --- | --- |
| 284 | 时间信息 | 只读（时长 / 源入点 / 源出点） |
| 310 | 定格时长 | 仅 `clip.type === 'freeze'`，`accent-section` |
| 346 | 旋转 | 已有 `.text-button` 重置（调 `resetRotation`） |
| 411 | 画面变换 | 水平/垂直镜像，两个 `.flip-toggle` |
| 448 | 缩放 | 含「适应 / 填充 / 位置复位」+ 水平/垂直偏移 |
| 550 | 画面裁剪 | `beginCrop` 入口按钮 |
| 609 | 危险区 | `panel-danger`，删除片段 |

由子组件自带 `<section>` 的 4 块：`ClipCompositingSection`（合成）、`ClipTransitionSection`（转场）、`ClipSpeedSection`（变速）、`ClipAudioSection`（音频，内部有 2 个 section）。

**可复用资产**
- Tab 写法与样式：`CaptionPanelSwitcher`（29–48 行）+ `.properties-tabs` / `.properties-tab` / `.properties-tab.is-active`（CSS 1322/1328/1339 行）
- `Icon` 已有 `reset`、`chevron`
- `core/commands.ts` 的 `createUpdateAnyClipCommand(clipId, patch, label)`：支持主轨 + 叠加轨任意 patch，**一次命令 = 1 条撤销**
- 只读摘要样式已有 `.summary-duration` / `.summary-dot` / `.summary-meta`（CSS 1266/1272/1279）
- `FREEZE_DEFAULT_DURATION = 3`（`core/constants.ts:8`）

---

## 2. 目标结构

```
<aside className="properties-panel">
  panel-head            （不变：类型 + #序号 + 收起按钮）
  <div className="panel-scroll" ref onScroll>
    .clip-summary        （已有：类型药丸 + 时长 + 起点）
    .summary-chips       （新增：时长 / 源入点 / 源出点，替代原「时间信息」section）
    .properties-tabs     （新增：画面 | 音频 | 变速 | 合成）
    {tab === 'picture'}     定格时长 · 旋转 · 镜像 · 缩放与位置 · 画面裁剪
    {tab === 'audio'}       音频（音量 / 淡入淡出 / 分离音频）
    {tab === 'speed'}       变速 · 转场
    {tab === 'compositing'} 合成（不透明度 / 混合模式）
    panel-danger         （移出 tab，固定底部）
  </div>
  panel-foot
</aside>
```

**「转场」并入「变速」tab**（不独立成第 5 个 tab）：两者都改变时间轴上的时长关系、且都作用于片段尾部；独立成 tab 会让两个轻量 section 各占一个 tab，反而多一次点击。

---

## 3. 实施步骤

### 3.1 store 新增 action（不改既有签名）

`src/editor/store/editorStore.ts`：

```ts
// 接口（放在 setTransition 之后）
/** 把一组属性重置为默认值（一个命令，1 步撤销）。 */
applyClipDefaults: (clipId: string, patch: Partial<Clip>, label: string) => void

// 实现（放在 setTransition 实现之后）
applyClipDefaults: (clipId, patch, label) => {
  const state = get()
  const location = findClipLocation(state.project, clipId)
  if (!location) return
  if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) return
  run(createUpdateAnyClipCommand(clipId, patch, label))
},
```

> 已验证可行：`createUpdateAnyClipCommand` 是 `setClipAudio` 正在用的同一条通道。

### 3.2 新增 `src/editor/components/PanelSection.tsx`

统一 section 外壳：可折叠标题 + 重置按钮。折叠状态**受控**（由父级持有），这样切 tab 后不丢失。

```tsx
import { useId, type ReactNode } from 'react'
import { Icon } from './Icon'

interface PanelSectionProps {
  title: string
  hint?: ReactNode
  collapsed: boolean
  onToggle: () => void
  onReset?: () => void
  resetDisabled?: boolean
  tone?: 'default' | 'danger' | 'accent'
  children: ReactNode
}

export function PanelSection({
  title, hint, collapsed, onToggle, onReset, resetDisabled, tone = 'default', children,
}: PanelSectionProps) {
  const bodyId = useId()
  const toneClass =
    tone === 'danger' ? ' panel-danger' : tone === 'accent' ? ' accent-section' : ''
  return (
    <section className={`panel-section${toneClass}`}>
      <div className="section-title">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className={`section-chevron${collapsed ? '' : ' is-open'}`} aria-hidden="true">
            <Icon name="chevron" size={12} />
          </span>
          <span>{title}</span>
        </button>
        <span className="section-title-end">
          {hint !== undefined && <span className="section-hint">{hint}</span>}
          {onReset && (
            <button
              type="button"
              className="icon-button section-reset"
              title={`重置${title}`}
              aria-label={`重置${title}`}
              disabled={resetDisabled}
              onClick={onReset}
            >
              <Icon name="reset" size={13} />
            </button>
          )}
        </span>
      </div>
      {!collapsed && <div id={bodyId}>{children}</div>}
    </section>
  )
}
```

### 3.3 子组件支持 `bare`（父统一包壳方案）

4 个组件（`ClipAudioSection` / `ClipCompositingSection` / `ClipSpeedSection` / `ClipTransitionSection`）各加一个**可选** prop：

```ts
  /** 由父级 PanelSection 提供标题与重置，组件只渲染内容 */
  bare?: boolean
```

并把它们各自的标题块包起来：

```tsx
<section className="panel-section">
  {!bare && (
    <div className="section-title">
      {/* 原有标题 */}
    </div>
  )}
  {/* 原有正文 */}
</section>
```

> **注意**：`bare` 要包住**所有** `section-title` 块，而各组件标题数量并不相同：
>
> | 组件 | `section-title` 数 | `<section>` 数 |
> | --- | ---: | ---: |
> | `ClipAudioSection` | **2**（音量 / 淡入淡出） | 2 |
> | `ClipCompositingSection` | **2**（不透明度 / 混合模式） | 1 |
> | `ClipSpeedSection` | 1 | 1 |
> | `ClipTransitionSection` | 1 | 1 |
>
> **踩过的坑**：批量脚本改多行解构时容易漏逗号，产生
> `({ clip, onChange, onPreview\n  bare,\n}: Props)` 这种 `TS1005`。改完务必 `pnpm typecheck`。

### 3.4 PropertiesPanel 主体重排

在 `round` 定义之后加：

```ts
type PanelTab = 'picture' | 'audio' | 'speed' | 'compositing'

const PANEL_TABS: readonly { id: PanelTab; label: string }[] = [
  { id: 'picture', label: '画面' },
  { id: 'audio', label: '音频' },
  { id: 'speed', label: '变速' },
  { id: 'compositing', label: '合成' },
]

/** 每个 section 的「恢复默认值」补丁：一次命令提交，1 步撤销。 */
const SECTION_DEFAULTS: Record<string, Partial<Clip>> = {
  rotation: { rotation: 0 },
  mirror: { flipH: false, flipV: false },
  transform: { scale: 1, position: { x: 0, y: 0 } },
  crop: { crop: { x: 0, y: 0, w: 1, h: 1 } },
  compositing: { opacity: 1, blendMode: 'normal' },
  speed: { speed: 1, keepPitch: true },
  transition: { transitionOut: undefined },
  audio: { volume: 1, fadeIn: 0, fadeOut: 0 },
}
```

> ⚠️ **定格时长不能用静态补丁**：它编码在 `sourceEnd` 里，重置值应为
> `clip.sourceStart + FREEZE_DEFAULT_DURATION`（`FREEZE_DEFAULT_DURATION = 3`），
> **绝不能用 `{ sourceEnd: 0 }`**，否则会把定格片段时长归零。

组件内状态：

```ts
const applyClipDefaults = useEditorStore((state) => state.applyClipDefaults)

const [tab, setTab] = useState<PanelTab>('picture')
const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({})
const isCollapsed = (id: string) => collapsedMap[id] === true
const toggleSection = (id: string) =>
  setCollapsedMap((current) => ({ ...current, [id]: !current[id] }))

// 切 tab 记住各自滚动位置
const scrollRef = useRef<HTMLDivElement | null>(null)
const scrollByTab = useRef<Partial<Record<PanelTab, number>>>({})
useEffect(() => {
  const el = scrollRef.current
  if (el) el.scrollTop = scrollByTab.current[tab] ?? 0
}, [tab])

const resetSection = (id: string, label: string) => {
  const patch = SECTION_DEFAULTS[id]
  if (!patch) return
  clearPreview()
  applyClipDefaults(clip.id, patch, `重置${label}`)
}
```

DOM 侧：

```tsx
<div
  className="panel-scroll"
  ref={scrollRef}
  onScroll={(event) => {
    scrollByTab.current[tab] = event.currentTarget.scrollTop
  }}
>
```

> `.panel-scroll` 在本文件出现 2 次（视频面板 + 多选面板），**只改视频面板那一个**（紧跟 `片段属性` 的 panel-head 之后）。

「时间信息」section 替换为 chips：

```tsx
<div className="summary-chips">
  <span className="summary-chip">时长 <strong>{duration.toFixed(2)}s</strong></span>
  <span className="summary-chip">
    {clip.type === 'freeze' ? '定格帧' : '源入点'} <strong>{clipFreezeFrame(clip).toFixed(2)}s</strong>
  </span>
  <span className="summary-chip">
    {clip.type === 'freeze' ? '冻结时长' : '源出点'}{' '}
    <strong>{clip.type === 'freeze' ? duration.toFixed(2) : clip.sourceEnd.toFixed(2)}s</strong>
  </span>
</div>
```

Tab 条（复用现有 class，与 `CaptionPanelSwitcher` 同款）：

```tsx
<div className="properties-tabs" role="tablist" aria-label="片段属性分类">
  {PANEL_TABS.map((item) => (
    <button
      key={item.id}
      type="button"
      role="tab"
      aria-selected={tab === item.id}
      className={`properties-tab${tab === item.id ? ' is-active' : ''}`}
      onClick={() => setTab(item.id)}
    >
      {item.label}
    </button>
  ))}
</div>
```

分组：`{tab === 'picture' && (<> … 定格/旋转/镜像/缩放/裁剪 … </>)}`，其余 3 个 tab 用 `PanelSection` 包对应子组件（`bare`），危险区留在 tab 之外。

**5 个内置 section 各改为**：

```tsx
<PanelSection
  title="旋转"
  hint={`${round(clip.rotation, 0)}°`}
  collapsed={isCollapsed('rotation')}
  onToggle={() => toggleSection('rotation')}
  onReset={() => resetSection('rotation', '旋转')}
  resetDisabled={disabled}
>
  {/* 原正文 */}
</PanelSection>
```

> 「旋转」原有的 `.text-button 重置`（调 `resetRotation`）要**删掉**，否则与新的 reset 按钮重复；并且 `resetRotation` 是独立命令，会破坏「一次重置 1 条历史」。

### 3.5 新增 CSS（`src/editor/styles/editor.css`）

```css
/* 只读摘要 chips（替代「时间信息」section） */
.summary-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 6px 0 2px;
}

.summary-chip {
  padding: 2px 6px;
  border: 1px solid var(--fc-line);
  border-radius: var(--fc-radius-sm);
  background: var(--fc-panel-deep);
  color: var(--fc-muted);
  font-size: var(--fc-text-xs);
  font-variant-numeric: tabular-nums;
}

.summary-chip strong {
  color: var(--fc-ink-soft);
  font-weight: 600;
}

/* section 标题：可折叠 + 重置 */
.section-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.section-chevron {
  display: inline-flex;
  transition: transform 0.16s ease;
}

.section-chevron.is-open {
  transform: rotate(180deg);
}

.section-title-end {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.section-reset {
  width: 20px;
  height: 20px;
  border-radius: var(--fc-radius-sm);
  color: var(--fc-muted);
}

.section-reset:hover:not(:disabled) {
  color: var(--fc-accent-deep);
}
```

> `.section-title` 目前是 `display:flex; align-items:center; justify-content:space-between`（CSS **1466** 行），
> 改后仍成立：左侧 `.section-toggle`、右侧 `.section-title-end`。

### 3.6 验收自查

| 验收项 | 检查方式 |
| --- | --- |
| 点「变速」tab 一次直达 | CDP：点 tab 后断言 `.properties-tab.is-active` 文本为「变速」且 `.panel-scroll.scrollTop === 0` |
| 每个 section 重置只 1 条撤销 | 对某片段点重置 → `ctrl+z` 一次应完全回到重置前（DOM 上 `.section-hint` 数值复原） |
| 字幕面板「样式/字幕」二 tab 不受影响 | `CaptionPanelSwitcher` 未改动，选中字幕片段后仍显示两个 tab |
| 折叠可用 | 点标题 → 该 section 正文消失，`aria-expanded="false"` |
| 切 tab 记住滚动 | 在「画面」滚到底 → 切「变速」→ 切回「画面」，`scrollTop` 复原 |
| 布局无回归 | `pnpm typecheck && pnpm test`；CDP 断言 `document.documentElement.scrollHeight === clientHeight`、`.properties-panel` 宽仍为 306 |

---

## 4. 已踩过的坑（务必注意）

1. **CSS 批量前缀化会破坏布局**（本仓库历史问题，与本任务无关但会干扰验证）：若在 `editor.css` 里做批量改动，改完必须用 CDP 断言
   `documentElement.scrollHeight === clientHeight` 与 `.topbar` 的 `display === 'grid'`。
   已知 `.framecut-host`（root 的祖先）、`.hidden-file-input`（root 的兄弟）**不能**加 `.framecut-root` 前缀。
2. **多行解构加参数易漏逗号** → `TS1005`，改完立刻 `pnpm typecheck`。
3. **`setRotation` / `resetRotation` 这类既有 action 各自是独立命令**，不能用来做「一次重置多条属性」；必须走 `applyClipDefaults`。
4. **`ClipAudioSection`（2 标题 / 2 section）与 `ClipCompositingSection`（2 标题 / 1 section）都要包两处标题**，只包第一处会留下多余的小标题。
5. **定格时长重置必须算 `sourceStart + FREEZE_DEFAULT_DURATION`**，不能归零。

---

## 5. 涉及文件清单

| 文件 | 改动 |
| --- | --- |
| `src/editor/components/PanelSection.tsx` | **新增**：section 外壳（折叠 + 重置） |
| `src/editor/components/PropertiesPanel.tsx` | tab 结构、chips、5 个内置 section 换壳、滚动记忆 |
| `src/editor/components/ClipAudioSection.tsx` | `bare` 可选 prop（2 处标题） |
| `src/editor/components/ClipCompositingSection.tsx` | `bare` 可选 prop |
| `src/editor/components/ClipSpeedSection.tsx` | `bare` 可选 prop |
| `src/editor/components/ClipTransitionSection.tsx` | `bare` 可选 prop |
| `src/editor/store/editorStore.ts` | 新增 `applyClipDefaults`（不改既有签名） |
| `src/editor/styles/editor.css` | 新增 6 个 class（见 3.5） |

> 不改动 `core/` 任何文件；`CaptionPanelSwitcher` 与字幕面板保持原样。