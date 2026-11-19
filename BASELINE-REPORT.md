# FrameCut 改动前基线报告

- 生成时间：2026-11-19T06:00:36.910Z
- 样式表：`src/editor/styles/editor.css`（4733 行）

> 只读采集，**未修改任何源码**。

## 1. 类型检查与单元测试

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ 通过（`tsc -b --pretty false`，0 错误） |
| `pnpm test` | ✅ **30 个测试文件 / 347 个测试全部通过**，0 失败 |

> ⚠️ 预期「143 个测试」与实测不符：当前基线是 **347**。143 是较早的旧数字；此后多轮迭代（变速、转场、画布背景、图片素材、多选剪贴板、叠加轨裁剪等）累积了大量用例。本报告以实际运行结果为准。

## 2. 开发服务器与控制台

| 项 | 结果 |
| --- | --- |
| `pnpm dev` | ✅ Vite 7.3.8 启动成功，`http://localhost:5173/` → HTTP 200 |
| 首屏渲染 | ✅ 完整挂载，DOM 约 119 KB |
| 控制台 | ✅ **无 error、无 uncaught 异常** |

控制台仅 INFO 级输出：`[vite] connecting...` / `[vite] connected.` / React DevTools 提示。

## 3. `editor.css` 的 font-size 取值分布

共 **155** 处 `font-size`，**8** 种取值（按数值升序）：

| 取值 | 次数 | 折算 |
| --- | ---: | ---: |
| `clamp(var(--fc-text-xl), 3vw, var(--fc-text-2xl))` | 1 | — |
| `var(--fc-text-2xl)` | 4 | — |
| `var(--fc-text-lg)` | 3 | — |
| `var(--fc-text-md)` | 3 | — |
| `var(--fc-text-sm)` | 21 | — |
| `var(--fc-text-xl)` | 5 | — |
| `var(--fc-text-xs)` | 116 | — |
| `var(--fc-text-xs) !important` | 2 | — |

### 观察

- **147 处、23 种**取值，字号高度碎片化，主体集中在 7–11px。
- 半像素字号 `7.5 / 8.5 / 9.5 / 10.5` 共 **32 处**，属逐处目测微调，未走设计令牌。
- **2 处 `!important`** 字号覆盖（`7.5px`、`8px`），通常意味着选择器权重冲突。
- 1 处响应式 `clamp(24px, 3vw, 34px)`；其余全部硬编码 `px`，无 `rem`/变量，不利于整体缩放。

## 4. 样式泄漏风险：未以 `.framecut-root` 为前缀的顶级选择器

| 分类 | 数量 |
| --- | ---: |
| 顶级规则中的选择器片段 | 447 |
| `@media` 内选择器片段 | 7 |
| **已加 `.framecut-root` 前缀（合规）** | **452** |
| **未加前缀（泄漏风险）** | **2** |

### 结论

样式表**整体是扁平全局作用域**：第 1 行 `.framecut-root {` 只承载设计令牌（`--fc-*`）与根布局，
其后所有组件规则（`.button`、`.toolbar`、`.toast`、`.modal-backdrop`、`.media-card`、`.preview-stage`…）
都是顶级且**无前缀**。这与「可嵌入库」定位冲突：`pnpm build:lib` 产出的 `dist-lib/framecut-editor.css`
会把这些通用类名注入宿主页面，宿主若也用 `.button` / `.toast` / `.badge` / `.toolbar` 就会互相污染。

`@media` 内的规则同样全局生效（媒体查询不提供作用域隔离），已一并计入风险。

### 完整风险清单（2 条）

| # | 行号 | 选择器 | 上下文 |
| ---: | ---: | --- | --- |
| 1 | 48 | `.framecut-root::before` | 顶层 |
| 2 | 2849 | `.framecut-root:has(.overlay-track)` | 顶层 |

### 合规（已前缀）清单（452 条）

| 行号 | 选择器 |
| ---: | --- |
| 1 | `.framecut-root` |
| 60 | `.framecut-root .framecut-host` |
| 66 | `.framecut-root .hidden-file-input` |
| 70 | `.framecut-root button` |
| 71 | `.framecut-root input` |
| 72 | `.framecut-root select` |
| 73 | `.framecut-root textarea` |
| 77 | `.framecut-root button:focus-visible` |
| 78 | `.framecut-root input:focus-visible` |
| 79 | `.framecut-root select:focus-visible` |
| 80 | `.framecut-root textarea:focus-visible` |
| 81 | `.framecut-root [tabindex]:focus-visible` |
| 86 | `.framecut-root button:disabled` |
| 87 | `.framecut-root input:disabled` |
| 88 | `.framecut-root select:disabled` |
| 89 | `.framecut-root textarea:disabled` |
| 93 | `.framecut-root kbd` |
| 111 | `.framecut-root .framecut-root .button` |
| 137 | `.framecut-root .button:hover:not(:disabled)` |
| 142 | `.framecut-root .button.primary` |
| 149 | `.framecut-root .button.primary:hover:not(:disabled)` |
| 156 | `.framecut-root .button.ghost` |
| 161 | `.framecut-root .button.ghost:hover:not(:disabled)` |
| 165 | `.framecut-root .button.mini` |
| 175 | `.framecut-root .button.large` |
| 182 | `.framecut-root .button:disabled` |
| 187 | `.framecut-root .button-meta` |
| 198 | `.framecut-root .icon-button` |
| 216 | `.framecut-root .icon-button:hover:not(:disabled)` |
| 222 | `.framecut-root .icon-button:disabled` |
| 226 | `.framecut-root .text-button` |
| 239 | `.framecut-root .text-button:hover:not(:disabled)` |
| 243 | `.framecut-root .text-button:disabled` |
| 247 | `.framecut-root .text-button.danger` |
| 251 | `.framecut-root .text-button.danger:hover` |
| 255 | `.framecut-root .commit-number` |
| 261 | `.framecut-root .commit-number input` |
| 275 | `.framecut-root .commit-number input::-webkit-outer-spin-button` |
| 276 | `.framecut-root .commit-number input::-webkit-inner-spin-button` |
| 281 | `.framecut-root .commit-number input:hover:not(:disabled)` |
| 285 | `.framecut-root .commit-number input:focus` |
| 291 | `.framecut-root .commit-number input:disabled` |
| 295 | `.framecut-root .commit-number-unit` |
| 304 | `.framecut-root .framecut-root .commit-number-grip` |
| 319 | `.framecut-root .commit-number-grip:hover` |
| 324 | `.framecut-root .framecut-root .commit-number.is-limit input` |
| 329 | `.framecut-root .commit-number-hint` |
| 347 | `.framecut-root input[type="range"]` |
| 358 | `.framecut-root input[type="range"]::-webkit-slider-runnable-track` |
| 364 | `.framecut-root input[type="range"]::-webkit-slider-thumb` |
| 376 | `.framecut-root input[type="range"]::-moz-range-track` |
| 382 | `.framecut-root input[type="range"]::-moz-range-thumb` |
| 390 | `.framecut-root input[type="range"]:disabled` |
| 394 | `.framecut-root .framecut-root .topbar` |
| 410 | `.framecut-root .topbar-start` |
| 417 | `.framecut-root .close-editor` |
| 421 | `.framecut-root .topbar-divider` |
| 428 | `.framecut-root .brand` |
| 435 | `.framecut-root .brand-mark` |
| 444 | `.framecut-root .brand-mark span` |
| 452 | `.framecut-root .brand-mark span:nth-child(1)` |
| 457 | `.framecut-root .brand-mark span:nth-child(2)` |
| 461 | `.framecut-root .brand-mark span:nth-child(3)` |
| 466 | `.framecut-root .brand-word` |
| 474 | `.framecut-root .brand-sub` |
| 483 | `.framecut-root .project-name` |
| 493 | `.framecut-root .topbar-center` |
| 500 | `.framecut-root .ratio-control` |
| 506 | `.framecut-root .ratio-control.is-disabled` |
| 510 | `.framecut-root .ratio-caption` |
| 517 | `.framecut-root .ratio-select` |
| 523 | `.framecut-root .ratio-select select` |
| 537 | `.framecut-root .ratio-select select:hover:not(:disabled)` |
| 541 | `.framecut-root .ratio-select svg` |
| 548 | `.framecut-root .topbar-end` |
| 555 | `.framecut-root .local-badge` |
| 567 | `.framecut-root .export-button` |
| 572 | `.framecut-root .framecut-root .media-library` |
| 586 | `.framecut-root .media-library-head` |
| 593 | `.framecut-root .media-library-head > div` |
| 599 | `.framecut-root .media-library-kicker` |
| 604 | `.framecut-root .media-library-count` |
| 609 | `.framecut-root .media-library-list` |
| 619 | `.framecut-root .media-library-empty` |
| 633 | `.framecut-root .media-library-empty small` |
| 638 | `.framecut-root .media-library-empty-icon` |
| 648 | `.framecut-root .media-card` |
| 662 | `.framecut-root .media-card:hover` |
| 667 | `.framecut-root .media-card:active` |
| 671 | `.framecut-root .media-card-thumb` |
| 684 | `.framecut-root .media-card-duration` |
| 696 | `.framecut-root .media-card-copy` |
| 703 | `.framecut-root .media-card-copy strong` |
| 711 | `.framecut-root .media-card-copy small` |
| 716 | `.framecut-root .media-library-foot` |
| 723 | `.framecut-root .workspace` |
| 730 | `.framecut-root .preview-pane` |
| 739 | `.framecut-root .framecut-root .preview-pane.is-fullscreen` |
| 748 | `.framecut-root .preview-pane.is-fullscreen .preview-stage` |
| 754 | `.framecut-root .preview-pane.is-fullscreen .preview-transport` |
| 760 | `.framecut-root .preview-pane.is-fullscreen .transport-hint` |
| 761 | `.framecut-root .preview-pane.is-fullscreen .transport-meta` |
| 765 | `.framecut-root .preview-stage` |
| 784 | `.framecut-root .preview-stage::before` |
| 797 | `.framecut-root .preview-halo` |
| 810 | `.framecut-root .preview-frame` |
| 836 | `.framecut-root .preview-canvas` |
| 843 | `.framecut-root .preview-canvas.is-draggable` |
| 847 | `.framecut-root .preview-canvas.is-dragging` |
| 851 | `.framecut-root .preview-video-source` |
| 861 | `.framecut-root .preview-audio-source` |
| 869 | `.framecut-root .preview-badges` |
| 880 | `.framecut-root .badge` |
| 897 | `.framecut-root .badge-live` |
| 903 | `.framecut-root .badge-soft` |
| 907 | `.framecut-root .badge-freeze` |
| 915 | `.framecut-root .live-dot` |
| 924 | `.framecut-root .preview-frame-note` |
| 936 | `.framecut-root .preview-empty` |
| 951 | `.framecut-root .empty-icon` |
| 965 | `.framecut-root .empty-kicker` |
| 975 | `.framecut-root .preview-empty h3` |
| 985 | `.framecut-root .empty-copy` |
| 993 | `.framecut-root .empty-foot` |
| 1001 | `.framecut-root .loading-orbit` |
| 1010 | `.framecut-root .loading-orbit::after` |
| 1031 | `.framecut-root .preview-transport` |
| 1040 | `.framecut-root .transport-main` |
| 1046 | `.framecut-root .transport-play` |
| 1064 | `.framecut-root .transport-play:hover:not(:disabled)` |
| 1069 | `.framecut-root .transport-play:disabled` |
| 1073 | `.framecut-root .transport-button` |
| 1087 | `.framecut-root .transport-button:hover:not(:disabled)` |
| 1093 | `.framecut-root .transport-button:disabled` |
| 1097 | `.framecut-root .transport-time` |
| 1104 | `.framecut-root .timecode` |
| 1112 | `.framecut-root .timecode.muted` |
| 1116 | `.framecut-root .timecode-sep` |
| 1122 | `.framecut-root .transport-meta` |
| 1130 | `.framecut-root .transport-hint` |
| 1136 | `.framecut-root .transport-divider` |
| 1142 | `.framecut-root .transport-fps` |
| 1148 | `.framecut-root .framecut-root .properties-panel` |
| 1174 | `.framecut-root .panel-head` |
| 1183 | `.framecut-root .panel-eyebrow` |
| 1193 | `.framecut-root .panel-head h2` |
| 1204 | `.framecut-root .panel-index` |
| 1212 | `.framecut-root .panel-scroll` |
| 1220 | `.framecut-root .panel-scroll::-webkit-scrollbar` |
| 1224 | `.framecut-root .panel-scroll::-webkit-scrollbar-thumb` |
| 1229 | `.framecut-root .clip-summary` |
| 1239 | `.framecut-root .type-pill` |
| 1251 | `.framecut-root .type-pill.video` |
| 1256 | `.framecut-root .type-pill.freeze` |
| 1261 | `.framecut-root .type-pill.audio` |
| 1266 | `.framecut-root .summary-duration` |
| 1272 | `.framecut-root .summary-dot` |
| 1279 | `.framecut-root .summary-meta` |
| 1285 | `.framecut-root .panel-section` |
| 1290 | `.framecut-root .panel-section.accent-section` |
| 1294 | `.framecut-root .caption-apply-all` |
| 1301 | `.framecut-root .caption-apply-all-check` |
| 1310 | `.framecut-root .caption-apply-all-check input` |
| 1316 | `.framecut-root .caption-style-presets` |
| 1322 | `.framecut-root .properties-tabs` |
| 1328 | `.framecut-root .properties-tab` |
| 1339 | `.framecut-root .properties-tab.is-active` |
| 1347 | `.framecut-root .caption-list-panel` |
| 1354 | `.framecut-root .caption-list-toolbar` |
| 1361 | `.framecut-root .caption-list-toolbar input` |
| 1373 | `.framecut-root .caption-follow-check` |
| 1384 | `.framecut-root .caption-follow-check input` |
| 1391 | `.framecut-root .caption-list` |
| 1396 | `.framecut-root .caption-row` |
| 1404 | `.framecut-root .caption-row.is-active` |
| 1408 | `.framecut-root .caption-row.is-selected` |
| 1412 | `.framecut-root .caption-row-time` |
| 1425 | `.framecut-root .caption-row-time:hover` |
| 1429 | `.framecut-root .caption-row-text` |
| 1441 | `.framecut-root .caption-row-text:focus` |
| 1447 | `.framecut-root .caption-row-delete` |
| 1457 | `.framecut-root .caption-row:hover .caption-row-delete` |
| 1458 | `.framecut-root .caption-row.is-selected .caption-row-delete` |
| 1462 | `.framecut-root .caption-row-delete:hover` |
| 1466 | `.framecut-root .section-title` |
| 1478 | `.framecut-root .section-hint` |
| 1486 | `.framecut-root .property-list` |
| 1493 | `.framecut-root .property-list > div` |
| 1501 | `.framecut-root .property-list > div:last-child` |
| 1505 | `.framecut-root .property-list dt` |
| 1510 | `.framecut-root .property-list dd` |
| 1518 | `.framecut-root .control-with-field` |
| 1524 | `.framecut-root .commit-slider` |
| 1532 | `.framecut-root .commit-slider.is-disabled` |
| 1536 | `.framecut-root .commit-value` |
| 1545 | `.framecut-root .commit-value.is-live` |
| 1549 | `.framecut-root .control-note` |
| 1556 | `.framecut-root .inline-actions` |
| 1563 | `.framecut-root .inline-actions .button` |
| 1567 | `.framecut-root .framecut-root .speed-presets` |
| 1575 | `.framecut-root .speed-preset` |
| 1589 | `.framecut-root .speed-preset:hover` |
| 1593 | `.framecut-root .speed-preset.is-active` |
| 1599 | `.framecut-root .framecut-root .toggle-row` |
| 1611 | `.framecut-root .toggle-row input[type='checkbox']` |
| 1616 | `.framecut-root .framecut-root .clip-speed-badge` |
| 1629 | `.framecut-root .clip-speed-badge.is-fast` |
| 1635 | `.framecut-root .clip-speed-badge.is-slow` |
| 1641 | `.framecut-root .framecut-root .background-choices` |
| 1649 | `.framecut-root .background-choice` |
| 1662 | `.framecut-root .background-choice:hover` |
| 1666 | `.framecut-root .background-choice.is-active` |
| 1672 | `.framecut-root .color-field` |
| 1680 | `.framecut-root .color-field input[type='color']` |
| 1690 | `.framecut-root .framecut-root .transition-marker` |
| 1710 | `.framecut-root .transition-marker:hover` |
| 1715 | `.framecut-root .transition-marker.is-active` |
| 1721 | `.framecut-root .framecut-root .select-field` |
| 1727 | `.framecut-root .select-field select` |
| 1737 | `.framecut-root .button.ghost-mini` |
| 1743 | `.framecut-root .flip-row` |
| 1749 | `.framecut-root .flip-toggle` |
| 1765 | `.framecut-root .flip-toggle span:nth-child(2)` |
| 1771 | `.framecut-root .flip-toggle.is-active` |
| 1777 | `.framecut-root .flip-toggle:hover:not(:disabled)` |
| 1781 | `.framecut-root .flip-toggle:disabled` |
| 1785 | `.framecut-root .toggle-state` |
| 1792 | `.framecut-root .flip-toggle.is-active .toggle-state` |
| 1796 | `.framecut-root .position-grid` |
| 1803 | `.framecut-root .position-grid > label` |
| 1812 | `.framecut-root .position-grid .commit-number input` |
| 1816 | `.framecut-root .button.crop-entry` |
| 1827 | `.framecut-root .button.crop-entry:hover:not(:disabled)` |
| 1832 | `.framecut-root .crop-entry-arrow` |
| 1839 | `.framecut-root .panel-danger` |
| 1843 | `.framecut-root .button.delete-clip` |
| 1854 | `.framecut-root .button.delete-clip:hover:not(:disabled)` |
| 1859 | `.framecut-root .button.delete-clip kbd` |
| 1866 | `.framecut-root .panel-foot` |
| 1877 | `.framecut-root .framecut-root .toolbar` |
| 1894 | `.framecut-root .toolbar-group` |
| 1900 | `.framecut-root .framecut-root .toolbar-hint` |
| 1914 | `.framecut-root .toolbar-hint.is-empty` |
| 1918 | `.framecut-root .framecut-root .clip-bar:focus-visible` |
| 1920 | `.framecut-root .audio-clip:focus-visible` |
| 1921 | `.framecut-root .text-clip:focus-visible` |
| 1927 | `.framecut-root .framecut-root .properties-panel.is-empty` |
| 1932 | `.framecut-root .no-selection-lead` |
| 1939 | `.framecut-root .no-selection-hints` |
| 1948 | `.framecut-root .no-selection-hints li` |
| 1954 | `.framecut-root .no-selection-icon` |
| 1967 | `.framecut-root .no-selection-copy` |
| 1974 | `.framecut-root .no-selection-copy strong` |
| 1980 | `.framecut-root .no-selection-copy small` |
| 1986 | `.framecut-root .no-selection-shortcuts-toggle` |
| 2000 | `.framecut-root .no-selection-chevron` |
| 2005 | `.framecut-root .no-selection-chevron.is-open` |
| 2009 | `.framecut-root .no-selection-shortcuts` |
| 2018 | `.framecut-root .no-selection-shortcuts li` |
| 2026 | `.framecut-root .no-selection-shortcuts kbd` |
| 2039 | `.framecut-root .framecut-root .background-dialog` |
| 2047 | `.framecut-root .background-dialog-body` |
| 2053 | `.framecut-root .background-dialog-body .properties-panel` |
| 2061 | `.framecut-root .background-dialog-body .panel-head` |
| 2065 | `.framecut-root .toolbar-separator` |
| 2072 | `.framecut-root .tool-button` |
| 2090 | `.framecut-root .tool-button:hover:not(:disabled)` |
| 2096 | `.framecut-root .tool-button.is-active` |
| 2102 | `.framecut-root .tool-button:disabled` |
| 2107 | `.framecut-root .tool-label` |
| 2114 | `.framecut-root .tool-tooltip` |
| 2142 | `.framecut-root .tool-tooltip::after` |
| 2153 | `.framecut-root .tool-tooltip kbd` |
| 2159 | `.framecut-root .tool-button:hover .tool-tooltip` |
| 2160 | `.framecut-root .tool-button:focus-visible .tool-tooltip` |
| 2166 | `.framecut-root .toolbar-end` |
| 2173 | `.framecut-root .toolbar-tip` |
| 2180 | `.framecut-root .toolbar-tip kbd` |
| 2186 | `.framecut-root .framecut-root .timeline-shell` |
| 2202 | `.framecut-root .timeline-header` |
| 2213 | `.framecut-root .timeline-heading` |
| 2220 | `.framecut-root .timeline-kicker` |
| 2227 | `.framecut-root .timeline-summary` |
| 2237 | `.framecut-root .timeline-summary-dot` |
| 2244 | `.framecut-root .timeline-zoom` |
| 2251 | `.framecut-root .zoom-caption` |
| 2258 | `.framecut-root .zoom-button` |
| 2272 | `.framecut-root .zoom-button:hover:not(:disabled)` |
| 2278 | `.framecut-root .zoom-button:disabled` |
| 2282 | `.framecut-root .zoom-range` |
| 2287 | `.framecut-root .zoom-range::-webkit-slider-runnable-track` |
| 2291 | `.framecut-root .zoom-range::-webkit-slider-thumb` |
| 2298 | `.framecut-root .zoom-tip` |
| 2306 | `.framecut-root .timeline-body` |
| 2313 | `.framecut-root .track-gutter` |
| 2321 | `.framecut-root .framecut-root .overlay-track-head` |
| 2323 | `.framecut-root .base-track-head` |
| 2324 | `.framecut-root .audio-track-head` |
| 2328 | `.framecut-root .track-gutter-spacer` |
| 2334 | `.framecut-root .track-controls-row` |
| 2343 | `.framecut-root .track-controls-name` |
| 2355 | `.framecut-root .track-controls-buttons` |
| 2361 | `.framecut-root .track-control` |
| 2377 | `.framecut-root .track-control:hover:not(:disabled)` |
| 2383 | `.framecut-root .track-control.is-off` |
| 2388 | `.framecut-root .track-control.is-locked` |
| 2393 | `.framecut-root .track-control.is-suppressed` |
| 2398 | `.framecut-root .track-control.track-solo.is-on` |
| 2403 | `.framecut-root .track-control:disabled` |
| 2408 | `.framecut-root .track-remove` |
| 2422 | `.framecut-root .track-remove:hover` |
| 2427 | `.framecut-root .timeline-scroll` |
| 2439 | `.framecut-root .timeline-scroll::-webkit-scrollbar` |
| 2443 | `.framecut-root .timeline-scroll::-webkit-scrollbar-track` |
| 2447 | `.framecut-root .timeline-scroll::-webkit-scrollbar-thumb` |
| 2454 | `.framecut-root .timeline-content` |
| 2463 | `.framecut-root .timeline-ruler` |
| 2471 | `.framecut-root .ruler-tick` |
| 2479 | `.framecut-root .ruler-tick::before` |
| 2489 | `.framecut-root .ruler-label` |
| 2503 | `.framecut-root .ruler-tick.is-first .ruler-label` |
| 2507 | `.framecut-root .marker-lane` |
| 2514 | `.framecut-root .overlay-tracks` |
| 2519 | `.framecut-root .overlay-track` |
| 2523 | `.framecut-root .overlay-track.is-drop-target .overlay-clip-lane` |
| 2524 | `.framecut-root .clip-lane.is-drop-target` |
| 2531 | `.framecut-root .overlay-track-head` |
| 2532 | `.framecut-root .base-track-head` |
| 2546 | `.framecut-root .overlay-track-name` |
| 2553 | `.framecut-root .overlay-track-remove` |
| 2567 | `.framecut-root .overlay-track-remove:hover` |
| 2572 | `.framecut-root .overlay-track-head` |
| 2576 | `.framecut-root .overlay-track-head .overlay-track-name` |
| 2580 | `.framecut-root .track-control` |
| 2595 | `.framecut-root .track-control:hover` |
| 2600 | `.framecut-root .track-control.is-off` |
| 2605 | `.framecut-root .overlay-track.is-hidden .overlay-clip-lane` |
| 2609 | `.framecut-root .audio-tracks` |
| 2613 | `.framecut-root .audio-track` |
| 2617 | `.framecut-root .audio-track-head` |
| 2628 | `.framecut-root .audio-track-name` |
| 2638 | `.framecut-root .audio-track-volume` |
| 2644 | `.framecut-root .framecut-root .audio-track-head .commit-slider` |
| 2651 | `.framecut-root .audio-track-head .commit-slider input[type='range']` |
| 2655 | `.framecut-root .audio-clip-lane` |
| 2662 | `.framecut-root .audio-clip` |
| 2673 | `.framecut-root .audio-clip.is-selected` |
| 2678 | `.framecut-root .audio-clip-name` |
| 2692 | `.framecut-root .audio-waveform` |
| 2699 | `.framecut-root .audio-clip-duration` |
| 2710 | `.framecut-root .audio-track-empty` |
| 2720 | `.framecut-root .audio-track.is-hidden .audio-clip-lane` |
| 2724 | `.framecut-root .audio-clip .clip-trim-handle` |
| 2728 | `.framecut-root .audio-clip:hover .clip-trim-handle` |
| 2729 | `.framecut-root .audio-clip.is-selected .clip-trim-handle` |
| 2733 | `.framecut-root .overlay-clip-lane` |
| 2740 | `.framecut-root .overlay-clip-lane .clip-bar` |
| 2745 | `.framecut-root .clip-bar.is-overlay` |
| 2750 | `.framecut-root .clip-bar.is-overlay .clip-kind` |
| 2754 | `.framecut-root .overlay-track-empty` |
| 2765 | `.framecut-root .base-track-head` |
| 2771 | `.framecut-root .overlay-add` |
| 2776 | `.framecut-root .timeline-switches` |
| 2786 | `.framecut-root .timeline-switch` |
| 2798 | `.framecut-root .timeline-switch:hover` |
| 2803 | `.framecut-root .timeline-switch.is-on` |
| 2809 | `.framecut-root .timeline-preview-axis` |
| 2825 | `.framecut-root .timeline-preview-axis::before` |
| 2836 | `.framecut-root .timeline-preview-axis > span` |
| 2853 | `.framecut-root .timeline-resize-handle` |
| 2867 | `.framecut-root .timeline-resize-handle::before` |
| 2876 | `.framecut-root .timeline-resize-handle:hover::before` |
| 2877 | `.framecut-root .timeline-resize-handle:active::before` |
| 2881 | `.framecut-root .marker-flag` |
| 2902 | `.framecut-root .marker-flag:hover` |
| 2903 | `.framecut-root .marker-flag.is-open` |
| 2909 | `.framecut-root .marker-flag svg` |
| 2913 | `.framecut-root .marker-note-dot` |
| 2924 | `.framecut-root .clip-lane` |
| 2934 | `.framecut-root .timeline-gap` |
| 2956 | `.framecut-root .timeline-gap-label` |
| 2964 | `.framecut-root .clip-bar` |
| 4380 | `.framecut-root .properties-panel` |
| 4385 | `.framecut-root .tool-button` |
| 4389 | `.framecut-root .local-badge` |
| 4390 | `.framecut-root .project-name` |
| 4394 | `.framecut-root .topbar` |
| 4398 | `.framecut-root .topbar-center` |
| 4404 | `.framecut-root .properties-panel` |
| 4409 | `.framecut-root .framecut-root .toolbar-hint` |
| 4414 | `.framecut-root .brand-sub` |
| 4418 | `.framecut-root .tool-label` |
| 4422 | `.framecut-root .tool-button` |
| 4428 | `.framecut-root .toolbar-tip` |
| 4429 | `.framecut-root .transport-hint` |
| 4430 | `.framecut-root .zoom-tip` |
| 4431 | `.framecut-root .zoom-caption` |
| 4435 | `.framecut-root .preview-pane` |
| 4439 | `.framecut-root .toolbar` |
| 4443 | `.framecut-root .timeline-header` |
| 4447 | `.framecut-root` |
| 4454 | `.framecut-root` |
| 4459 | `.framecut-root .topbar` |
| 4465 | `.framecut-root .topbar-start` |
| 4469 | `.framecut-root .brand-word` |
| 4473 | `.framecut-root .topbar-divider` |
| 4474 | `.framecut-root .ratio-caption` |
| 4475 | `.framecut-root .topbar-center` |
| 4480 | `.framecut-root .close-editor` |
| 4484 | `.framecut-root .workspace` |
| 4488 | `.framecut-root .properties-panel` |
| 4496 | `.framecut-root .panel-head` |
| 4501 | `.framecut-root .panel-head h2` |
| 4505 | `.framecut-root .panel-section` |
| 4510 | `.framecut-root .preview-pane` |
| 4516 | `.framecut-root .preview-stage` |
| 4520 | `.framecut-root .preview-transport` |
| 4524 | `.framecut-root .transport-divider` |
| 4525 | `.framecut-root .transport-fps` |
| 4526 | `.framecut-root .transport-meta` |
| 4530 | `.framecut-root .toolbar` |
| 4537 | `.framecut-root .toolbar::-webkit-scrollbar` |
| 4541 | `.framecut-root .tool-button` |
| 4545 | `.framecut-root .toolbar-separator` |
| 4549 | `.framecut-root .timeline-summary` |
| 4553 | `.framecut-root .timeline-header` |
| 4557 | `.framecut-root .zoom-range` |
| 4561 | `.framecut-root .quality-grid` |
| 4565 | `.framecut-root .export-summary` |
| 4569 | `.framecut-root .done-stats` |
| 4573 | `.framecut-root .done-stats > div:nth-child(3)` |
| 4578 | `.framecut-root .done-stats > div:nth-child(4)` |
| 4582 | `.framecut-root .modal-backdrop` |
| 4586 | `.framecut-root .export-head` |
| 4587 | `.framecut-root .export-body` |
| 4592 | `.framecut-root .export-dialog` |
| 4597 | `.framecut-root .export-actions` |
| 4603 | `.framecut-root .topbar-end .local-badge` |
| 4604 | `.framecut-root .export-button` |
| 4608 | `.framecut-root .export-button` |
| 4613 | `.framecut-root .brand-word` |
| 4617 | `.framecut-root .brand-mark` |
| 4621 | `.framecut-root .empty-copy` |
| 4622 | `.framecut-root .empty-foot` |
| 4626 | `.framecut-root .preview-empty` |
| 4630 | `.framecut-root .preview-empty h3` |
| 4634 | `.framecut-root .badge:nth-child(n + 3)` |
| 4638 | `.framecut-root .crop-help` |
| 4642 | `.framecut-root .crop-actions` |
| 4648 | `.framecut-root *` |
| 4649 | `.framecut-root *::before` |
| 4650 | `.framecut-root *::after` |
