/**
 * ASR 静态资源根（onnxruntime 的 wasm/mjs，以及 silero_vad.onnx）。
 *
 * 为什么需要可配置：worker 里原本把路径写死成站点根 `/onnxruntime/`、`/vad/`。
 * 这在站点根部署时没问题，但嵌到子路径（`/studio/`）或由宿主决定静态目录时就必然
 * 404；而 worker 加载/取模型失败不会抛错给调用方（只有异步 error 事件），表现为
 * 「识别永远卡住」。宿主可通过 `configureAsrAssets('/studio/')` 修正。
 *
 * 默认保持 `'/'`（与 README 的部署说明一致），避免影响既有部署。
 */

let assetBase: string | null = null

/** 覆盖 ASR 资源根；传空值恢复默认 `'/'`。 */
export function configureAsrAssets(baseUrl?: string): void {
  assetBase = baseUrl?.trim() ? baseUrl.trim() : null
}

/** 当前资源根，保证以 `/` 结尾。 */
export function asrAssetBase(): string {
  const base = assetBase ?? '/'
  return base.endsWith('/') ? base : `${base}/`
}