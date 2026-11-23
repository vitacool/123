import { webglKeyer } from './webglKeyer'
import { canCleanup, execOnRuntime, type RuntimeHandle } from './ffmpegRuntime'
import { backgroundCssColor, clipBackground } from '../core/background'
import { clipFreezeFrame, clipSpanSourceAt, clipTimelineDuration } from '../core/clipTime'
import { drawClipFrame } from '../core/clipRender'
import { resolveClipOverrides } from '../core/animation'
import { animationFrameCount } from '../core/animationExport'
import { planAnimatedClipAudio } from '../core/animationAudio'
import type { Clip, Project, SourceInfo } from '../core/types'

/** 单个动画片段编码的硬超时（3 分钟）：超时由运行时层直接 terminate。 */
const ANIMATION_ENCODE_TIMEOUT_MS = 180_000

export interface RenderAnimatedClipOptions {
  clip: Clip
  asset: SourceInfo
  /** 片段所在的层：主轨 null；叠加轨为轨道 id（仅用于命名与背景烘焙策略）。 */
  trackId: string | null
  project: Project
  width: number
  height: number
  fps: number
  /** 该片段在本次渲染中的序号（从 0 开始），用于文件名。 */
  index: number
  /** 导出自己持有的运行时句柄（带代次；超时/取消会让代次失效）。 */
  runtime: RuntimeHandle
  /**
   * 可选的源文件池：一次导出内多个动画片段共用同一份源文件（同一源只写一次）。
   * 不传时渲染器自建并在结束时释放（单片段场景）。
   */
  sources?: AnimationSourcePool
  signal: AbortSignal | null
  /**
   * 可选的「下方画面」：叠加轨片段的中间视频不带 alpha，
   * 所以把该时刻位于它下方的片段一起烘进来，合成时才能与预览一致。
   * 仅当这个下方片段本身没有动画时才允许传入（否则会与它的中间视频重复烘焙）。
   */
  underlay?: { clip: Clip; asset: SourceInfo }
  /** 每渲染完一帧回调一次（done, total）。 */
  onFrame?: (done: number, total: number) => void
}

/** 取素材的原始字节（用于把原声裁进中间视频、以及生成倒放素材）。 */
export async function readAssetBytes(asset: SourceInfo): Promise<Uint8Array | null> {
  try {
    if (asset.file) return new Uint8Array(await asset.file.arrayBuffer())
    const response = await fetch(asset.url)
    if (!response.ok) return null
    return new Uint8Array(await (await response.blob()).arrayBuffer())
  } catch {
    return null
  }
}

const throwIfAborted = (signal: AbortSignal | null): void => {
  if (signal?.aborted) {
    const error = new Error('导出已取消')
    error.name = 'AbortError'
    throw error
  }
}

const waitForEvent = (
  target: HTMLVideoElement | HTMLImageElement,
  event: string,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`等待 ${event} 超时`))
    }, timeoutMs)
    const done = () => {
      cleanup()
      resolve()
    }
    const fail = () => {
      cleanup()
      reject(new Error('素材解码失败'))
    }
    const cleanup = () => {
      window.clearTimeout(timer)
      target.removeEventListener(event, done)
      target.removeEventListener('error', fail)
    }
    target.addEventListener(event, done, { once: true })
    target.addEventListener('error', fail, { once: true })
  })

/** 一个已打开、可 seek 的画面源（视频元素或已解码图片）。 */
export interface FrameSourceHandle {
  draw: CanvasImageSource
  width: number
  height: number
  seek: ((time: number) => Promise<void>) | null
  dispose: () => void
}

/**
 * 打开一个可用于逐帧绘制的画面源（视频元素或已解码图片）。
 * 「导出当前帧」（services/frameCapture）复用同一套加载 / seek 逻辑。
 */
export async function openSource(asset: SourceInfo): Promise<FrameSourceHandle> {
  if (asset.kind === 'image') {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = asset.url
    await waitForEvent(image, 'load', 8000)
    return {
      draw: image,
      width: image.naturalWidth || asset.width,
      height: image.naturalHeight || asset.height,
      seek: null,
      dispose: () => {
        image.removeAttribute('src')
      },
    }
  }

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.src = asset.url
  await waitForEvent(video, 'loadeddata', 15000)
  return {
    draw: video,
    width: video.videoWidth || asset.width,
    height: video.videoHeight || asset.height,
    seek: async (time: number) => {
      const target = Math.max(0, time)
      if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 1e-3) return
      // 必须先挂监听、再改 currentTime：反过来会等一个还没开始的 seek，
      // 在没有并发 seek 的情况下永远等不到 seeked（8s 后抛「等待 seeked 超时」）。
      const seeked = waitForEvent(video, 'seeked', 8000)
      video.currentTime = target
      await seeked
    },
    dispose: () => {
      video.pause()
      video.removeAttribute('src')
      try {
        video.load()
      } catch {
        // 忽略：元素即将被 GC。
      }
    },
  }
}

/**
 * 每个分块编码的帧数：与动画字幕的 TEXT_ANIMATION_CHUNK_FRAMES 对齐（30 帧 ≈ 1s@30fps）。
 * 分块的目的不是画质，而是**限制 MEMFS 里同时存在的 PNG 数**——1080p 下 10 秒动画
 * 的全部帧一次写进去会撑爆 wasm 堆。
 */
export const ANIMATION_CHUNK_FRAMES = 30

/** 一个待编码的分块：从第 start 帧起、共 count 帧。 */
export interface AnimationChunkPlan {
  start: number
  count: number
}

/**
 * 把总帧数切成连续的块：块之间不重叠、不跳帧，最后一块可以是残块。
 * 所有块的 `count` 之和必须等于 `totalFrames`（否则导出会丢帧或多帧）。
 */
export function planAnimationChunks(
  totalFrames: number,
  chunkFrames: number = ANIMATION_CHUNK_FRAMES,
): AnimationChunkPlan[] {
  const total = Math.max(0, Math.floor(totalFrames))
  const size = Math.max(1, Math.floor(chunkFrames))
  const chunks: AnimationChunkPlan[] = []
  for (let start = 0; start < total; start += size) {
    chunks.push({ start, count: Math.min(size, total - start) })
  }
  return chunks
}

const sourceFileExtension = (name: string): string => {
  const match = /[.](mp4|mov|webm|mkv|m4a|mp3|wav|aac|ogg)$/i.exec(name ?? '')
  return `.${match ? match[1].toLowerCase() : 'm4a'}`
}

interface PooledSource {
  generation: number
  file: string
  refs: number
}

/**
 * 一次导出准备流程内的「源文件池」：同一个源素材只往 MEMFS 写**一份**，
 * 多个动画片段复用；流程结束（dispose）时统一删除。
 *
 * 为什么不按「引用计数归零就删」：导出是**顺序**渲染片段的，两个片段的
 * acquire/release 不会重叠，计数会立刻回到 0 —— 那样每个片段仍会各写一份。
 * 所以池子的生命周期由调用方（prepareAnimatedProject）持有。
 *
 * 条目按**实例代次**隔离：运行时重启后旧 worker 的文件系统已销毁，必须重新写。
 */
export interface AnimationSourcePool {
  /** 取该源的 MEMFS 文件名（首次调用时写入）；拿不到字节返回 null。 */
  acquire(runtime: RuntimeHandle, asset: SourceInfo): Promise<string | null>
  /** 归还一次引用（文件保留到 dispose）。 */
  release(asset: SourceInfo): void
  /** 删除池里还留着的全部源文件。 */
  dispose(runtime: RuntimeHandle): Promise<void>
  /** 当前池里写入过的文件名（测试用）。 */
  readonly files: string[]
}

let animationSourceCounter = 0

export function createAnimationSourcePool(): AnimationSourcePool {
  const entries = new Map<string, PooledSource>()
  const keyOf = (runtime: RuntimeHandle, asset: SourceInfo): string =>
    `${runtime.generation}|${asset.url}`
  // release 需要知道是哪个条目：按 (generation, url) 找，找不到就忽略。
  const lastRuntimeGeneration: { value: number } = { value: 0 }

  return {
    async acquire(runtime, asset) {
      lastRuntimeGeneration.value = runtime.generation
      const key = keyOf(runtime, asset)
      const existing = entries.get(key)
      if (existing) {
        existing.refs += 1
        return existing.file
      }
      const bytes = await readAssetBytes(asset)
      if (!bytes || bytes.byteLength === 0) return null
      animationSourceCounter += 1
      const file = `anim-src-${animationSourceCounter}${sourceFileExtension(asset.name ?? '')}`
      try {
        await runtime.ffmpeg.writeFile(file, bytes)
      } catch {
        return null
      }
      entries.set(key, { generation: runtime.generation, file, refs: 1 })
      return file
    },
    release(asset) {
      const key = `${lastRuntimeGeneration.value}|${asset.url}`
      const entry = entries.get(key)
      if (!entry) return
      entry.refs = Math.max(0, entry.refs - 1)
    },
    async dispose(runtime) {
      const pooled = [...entries.values()]
      entries.clear()
      if (!canCleanup(runtime.generation)) return
      for (const entry of pooled) {
        await runtime.ffmpeg.deleteFile(entry.file).catch(() => undefined)
      }
    },
    get files() {
      return [...entries.values()].map((entry) => entry.file)
    },
  }
}

/**
 * 把一个带动画的片段逐帧渲染成 PNG 序列，**分块编码**成一个中间 MP4。
 *
 * 内存策略（关键）：每 ANIMATION_CHUNK_FRAMES 帧写一批 PNG → 立刻编码成一个
 * 小 mp4 → 马上删掉这批 PNG。这样 MEMFS 里同时存在的 PNG 最多一个块的量，
 * 而不是整段的所有帧。最后把各块 concat（`-c copy`，不重编码）再混入音轨。
 *
 * 帧语义：第 k 块编码第 [k*CHUNK, k*CHUNK+count) 帧，`-frames:v count` 保证一段正好
 * count 帧；所有块拼起来严格等于动画总帧数（不缺、不重）。
 */
export async function renderAnimatedClipToFile(
  options: RenderAnimatedClipOptions,
): Promise<File> {
  const {
    clip,
    asset,
    project,
    width,
    height,
    fps,
    index,
    runtime,
    signal,
    onFrame,
    underlay,
    sources,
  } = options
  // 调用方（prepareAnimatedProject）会在整个准备流程里复用同一个池：同一源只写一次。
  const sourcePool = sources ?? createAnimationSourcePool()
  // 文件读写仍打在**这个句柄**的实例上；exec 一律走运行时队列（见 execOnRuntime）。
  const ffmpeg = runtime.ffmpeg
  const duration = clipTimelineDuration(clip)
  const total = animationFrameCount(clip, fps)
  const canvasW = Math.max(2, Math.round(width / 2) * 2)
  const canvasH = Math.max(2, Math.round(height / 2) * 2)
  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建动画渲染画布。')

  const background = clipBackground(clip, project)
  const backgroundFill = backgroundCssColor(background)
  const outputName = `anim_${index}.mp4`
  const videoName = `anim_${index}_video.mp4`
  const listName = `anim_${index}_list.txt`
  const source = await openSource(asset)
  const underlaySource = underlay ? await openSource(underlay.asset) : null
  /** 本次创建的分块 mp4（最后 concat 用，收尾统一删）。 */
  const chunkFiles: string[] = []
  /** 当前这一批还没编码的 PNG（中断时也要删）。 */
  let pendingPngs: string[] = []
  let audioSourceFile: string | null = null

  const drawFrame = async (frame: number): Promise<Uint8Array> => {
    const localTime = Math.min(duration, frame / fps)
    // 该帧对应的源时间（变速/裁剪已包含在 clipSpanSourceAt 里）。
    if (source.seek) {
      const sourceTime =
        clip.type === 'freeze' ? clipFreezeFrame(clip) : clipSpanSourceAt(clip, localTime)
      await source.seek(sourceTime)
    }
    // 中间视频不带 alpha：先把「该时刻的画面底」铺上（有下方片段就画它，
    // 否则铺画布背景色），再画本片段。这样合成时覆盖整幅画面也不会丢失内容。
    //
    // 为什么不用带 alpha 的中间格式：本项目的 FFmpeg.wasm 核心没有 VP8/VP9 编码器，
    // 而可用的透明编码体积过大（实测 1080p/2s：qtrle ≈32MB、FFV1 ≈14MB、ProRes 4444
    // ≈35MB、APNG 编码耗时 22s），不适合既要写进 MEMFS 又要分块拼接。因此保持
    // H.264/yuv420p，把背景（或下方画面）烘进每一帧——蒙版/抠像外区域显示的是这层
    // 背景，**不会变黑**。蒙版/抠像本身已经画进帧里，烘焙后必须清掉对应字段（见
    // bakeAnimatedClip）。
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    ctx.clearRect(0, 0, canvasW, canvasH)
    ctx.fillStyle = backgroundFill
    ctx.fillRect(0, 0, canvasW, canvasH)
    ctx.restore()

    if (underlay && underlaySource) {
      if (underlaySource.seek) {
        await underlaySource.seek(clipSpanSourceAt(underlay.clip, localTime))
      }
      drawClipFrame({
        ctx,
        clip: underlay.clip,
        localTime,
        asset: underlay.asset,
        canvasW,
        canvasH,
        source: underlaySource.draw,
        sourceWidth: underlaySource.width,
        sourceHeight: underlaySource.height,
      })
    }

    drawClipFrame({
      ctx,
      clip,
      localTime,
      asset,
      canvasW,
      canvasH,
      source: source.draw,
      sourceWidth: source.width,
      sourceHeight: source.height,
      overrides: resolveClipOverrides(clip, localTime, duration),
      keyFrame: webglKeyer,
      createCanvas: (w, h) => {
        const offscreen = document.createElement('canvas')
        offscreen.width = Math.max(1, Math.round(w))
        offscreen.height = Math.max(1, Math.round(h))
        const inner = offscreen.getContext('2d')
        return inner ? { canvas: offscreen, ctx: inner } : null
      },
    })

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), 'image/png'),
    )
    if (!blob) throw new Error('动画帧渲染失败。')
    return new Uint8Array(await blob.arrayBuffer())
  }

  try {
    const chunks = planAnimationChunks(total, ANIMATION_CHUNK_FRAMES)
    let rendered = 0
    for (const chunk of chunks) {
      throwIfAborted(signal)
      const prefix = `anim_${index}_${String(chunk.start).padStart(5, '0')}_`
      const pngs: string[] = []
      for (let offset = 0; offset < chunk.count; offset += 1) {
        throwIfAborted(signal)
        const png = `${prefix}${String(offset).padStart(5, '0')}.png`
        pendingPngs = pngs
        await ffmpeg.writeFile(png, await drawFrame(chunk.start + offset))
        pngs.push(png)
        pendingPngs = pngs
        rendered += 1
        onFrame?.(rendered, total)
      }
      const chunkFile = `anim_${index}_${String(chunk.start).padStart(5, '0')}.mp4`
      const code = await execOnRuntime(
        runtime,
        [
          '-hide_banner',
          '-y',
          '-framerate',
          String(fps),
          '-start_number',
          '0',
          '-i',
          `${prefix}%05d.png`,
          '-frames:v',
          String(chunk.count),
          '-r',
          String(fps),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '18',
          '-pix_fmt',
          'yuv420p',
          chunkFile,
        ],
        { signal, timeoutMs: ANIMATION_ENCODE_TIMEOUT_MS },
      )
      if (code !== 0) throw new Error(`动画片段编码失败（退出码 ${code}）。`)
      chunkFiles.push(chunkFile)
      // 关键：这一块的 PNG 用完立刻删，MEMFS 里同时存在的 PNG 不超过一块。
      if (canCleanup(runtime.generation)) {
        for (const png of pngs) {
          await ffmpeg.deleteFile(png).catch(() => undefined)
        }
      }
      pendingPngs = []
    }

    throwIfAborted(signal)

    // 多块 → concat（`-c copy`，不重编码）；单块直接用。
    let videoFile = chunkFiles[0]
    if (chunkFiles.length > 1) {
      await ffmpeg.writeFile(listName, chunkFiles.map((file) => `file '${file}'`).join('\n'))
      const code = await execOnRuntime(
        runtime,
        [
          '-hide_banner',
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listName,
          '-c',
          'copy',
          videoName,
        ],
        { signal, timeoutMs: ANIMATION_ENCODE_TIMEOUT_MS },
      )
      if (code !== 0) throw new Error(`动画片段分块拼接失败（退出码 ${code}）。`)
      videoFile = videoName
    }

    // 中间视频必须带一条音轨：滤镜图会按「有音频」引用该输入，缺轨会让整次导出失败。
    // 源文件按「同一源只写一份」共享（引用计数），这里只取引用。
    const still = clip.type === 'freeze' || clip.type === 'image'
    if (!still) audioSourceFile = await sourcePool.acquire(runtime, asset)
    const audio = planAnimatedClipAudio(clip, audioSourceFile, asset.hasAudio)

    // 混音：视频流直接 copy（不重编码），音轨按时间轴时长变速后 mux 进来。
    // 映射/编码参数直接复用 planAnimatedClipAudio().mapArgs（含 -filter_complex 与 -shortest），
    // 只补一个 -c:v copy——避免两处各写一份参数后逐渐漂移。
    const muxArgs = [
      '-hide_banner',
      '-y',
      '-i',
      videoFile,
      ...audio.inputArgs,
      ...audio.mapArgs,
      '-c:v',
      'copy',
      outputName,
    ]
    const muxCode = await execOnRuntime(runtime, muxArgs, {
      signal,
      timeoutMs: ANIMATION_ENCODE_TIMEOUT_MS,
    })
    if (muxCode !== 0) throw new Error(`动画片段混音失败（退出码 ${muxCode}）。`)

    const data = await ffmpeg.readFile(outputName)
    if (typeof data === 'string') throw new Error('动画片段编码返回了文本数据。')
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    return new File([copy.buffer], outputName, { type: 'video/mp4' })
  } finally {
    source.dispose()
    underlaySource?.dispose()
    // 当前这一批还没编码的 PNG（中断/失败时）先删；然后再删分块与中间产物。
    const leftovers = [...pendingPngs]
    pendingPngs = []
    if (canCleanup(runtime.generation)) {
      for (const png of leftovers) await ffmpeg.deleteFile(png).catch(() => undefined)
      for (const file of [...chunkFiles, videoName, listName, outputName]) {
        try {
          await ffmpeg.deleteFile(file)
        } catch {
          // 尽力清理；文件可能已被删除。
        }
      }
    }
    // 共享源文件按引用计数释放：最后一个使用者负责删除。
    if (audioSourceFile) sourcePool.release(asset)
    // 自建的池：本次渲染结束后就该删除它写的源文件。
    if (!sources) await sourcePool.dispose(runtime)
  }
}
