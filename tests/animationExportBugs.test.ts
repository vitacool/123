import { describe, expect, it } from 'vitest'
import {
  bakeAnimatedClip,
  hasAnyAnimation,
} from '../src/editor/core/animationExport'
import { hasAnyTextAnimation } from '../src/editor/core/textAnimation'
import { planAnimatedClipAudio } from '../src/editor/core/animationAudio'
import { MASK_DEFAULTS } from '../src/editor/core/mask'
import {
  applyTextOverlayGraph,
  buildExportPlan,
  exportInputLayout,
} from '../src/editor/core/exportPlan'
import { clipTimelineDuration } from '../src/editor/core/clipTime'
import { segmentPlan } from '../src/editor/core/speed'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import type { Clip, Project, SourceInfo, TextClip, TextTrack } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:anim-src',
  name: 'src.mp4',
  size: 1024,
  duration: 30,
  width: 1920,
  height: 1080,
  kind: 'video',
  hasAudio: true,
}

const video = (id: string, extra: Partial<Clip> = {}): Clip =>
  createClip(SOURCE.url, 0, 10, { ...extra }, id)

const projectOf = (clips: Clip[], extra: Partial<Project> = {}): Project => ({
  ...createInitialProject({ url: SOURCE.url, duration: 30 }, clips[0]?.id ?? 'main'),
  aspectRatio: '16:9',
  exportQuality: { resolution: '480p', fps: 30 },
  clips,
  ...extra,
})

const textClip = (id: string, extra: Partial<TextClip> = {}): TextClip =>
  ({
    id,
    text: '动画字幕',
    start: 0,
    end: 4,
    x: 0.5,
    y: 0.8,
    fontSize: 0.08,
    color: '#ffffff',
    background: 'transparent',
    align: 'center',
    bold: false,
    italic: false,
    ...extra,
  }) as TextClip

const textTrack = (clips: TextClip[]): TextTrack => ({
  id: 'tt',
  name: '文本 1',
  muted: false,
  hidden: false,
  enabled: true,
  clips,
})

const SEGMENTS = [
  { at: 0, speed: 1 },
  { at: 0.5, speed: 4 },
]
const CURVE = [
  { at: 0, speed: 1 },
  { at: 0.5, speed: 4 },
  { at: 1, speed: 1 },
]

// ---------------------------------------------------------------------------
// 问题 A：烘焙后的中间视频已含变速，不能保留 speedSegments / speedCurve
// ---------------------------------------------------------------------------
describe('问题 A：bakeAnimatedClip 必须清掉变速字段', () => {
  it('分段 / 曲线都被清空，烘焙时长 = 原片段的时间轴时长', () => {
    const original = video('a1', { sourceStart: 2, sourceEnd: 8, speedSegments: SEGMENTS })
    const duration = clipTimelineDuration(original)
    // 源 2–8 上「前 3s 1x + 后 3s 4x」→ 3 + 0.75 = 3.75s（不是 6s）
    expect(duration).toBeCloseTo(3.75, 9)

    const baked = bakeAnimatedClip(original, 'blob:anim-0', duration)
    expect(baked.speed).toBe(1)
    expect(baked.speedSegments).toBeUndefined()
    expect(baked.speedCurve).toBeUndefined()
    // 烘焙成 1x 的普通片段后，时长必须仍是 3.75s（若留着分段，会被二次变速成 1.875s）
    expect(clipTimelineDuration(baked)).toBeCloseTo(duration, 9)
    expect(segmentPlan(baked)).toBeNull()

    const curved = video('a2', { sourceStart: 0, sourceEnd: 10, speedCurve: CURVE })
    const bakedCurved = bakeAnimatedClip(curved, 'blob:anim-1', clipTimelineDuration(curved))
    expect(bakedCurved.speedCurve).toBeUndefined()
    expect(bakedCurved.speedSegments).toBeUndefined()
    expect(clipTimelineDuration(bakedCurved)).toBeCloseTo(clipTimelineDuration(curved), 9)
  })

  it('烘焙后的工程在 exportPlan 里不会再应用变速滤镜', () => {
    const original = video('a3', {
      sourceStart: 0,
      sourceEnd: 10,
      speedSegments: SEGMENTS,
      anim: { 'position.x': [{ t: 0, value: 0, ease: 'linear' }] },
    })
    const duration = clipTimelineDuration(original)
    const baked = bakeAnimatedClip(original, 'blob:anim-2', duration)
    const plan = buildExportPlan(projectOf([baked]), [{ ...SOURCE, url: 'blob:anim-2' }], true)
    // 1x 烘焙片段 → 无 atempo / 无分段 setpts 表达式
    expect(plan.graph).not.toContain('atempo=')
    expect(plan.graph).not.toContain('if(lt(T,')
    expect(plan.totalDuration).toBeCloseTo(duration, 3)
  })
})

// ---------------------------------------------------------------------------
// 问题 B：文字层输入序号必须是「媒体 + 蒙版」，不能用 plan.inputs.length
// ---------------------------------------------------------------------------
describe('问题 B：文字层输入序号要算上蒙版输入', () => {
  it('exportInputLayout：文字层 = 媒体 + 蒙版，封面 = 文字层之后', () => {
    expect(exportInputLayout(2, 1, false)).toEqual({
      mediaInputs: 2,
      maskInputs: 1,
      textInputBase: 3,
      coverInputIndex: 3,
    })
    expect(exportInputLayout(2, 1, true).coverInputIndex).toBe(4)
    // 没有蒙版时两者相等（这正是原来的 bug 只在「有蒙版」时暴露的原因）
    expect(exportInputLayout(2, 0, false).textInputBase).toBe(2)
  })

  it('applyTextOverlayGraph 用传入序号取图：有蒙版时是 [3:v]，而不是 [2:v]（那是蒙版）', () => {
    const masked = video('m1', { sourceEnd: 4, mask: { ...MASK_DEFAULTS } })
    const project = projectOf([masked])
    const plan = buildExportPlan(project, [SOURCE], true, { maskInputs: new Map([['m1', 1]]) })
    // 1 个媒体输入 + 1 个蒙版输入 → 蒙版标签是 [1:v]
    expect(plan.graph).toContain('[1:v]format=rgba,scale=')
    const layout = exportInputLayout(1, 1, false)
    expect(layout.textInputBase).toBe(2)

    const withText = buildExportPlan(project, [SOURCE], true, { maskInputs: new Map([['m1', 1]]) })
    applyTextOverlayGraph(withText, layout.textInputBase)
    // 文字层读 [2:v]（媒体 1 + 蒙版 1）；如果误用 plan.inputs.length（=1）就会读成 [1:v] 蒙版
    expect(withText.graph).toContain('[2:v]format=rgba,fps=30')
    expect(withText.graph).not.toContain('[1:v]format=rgba,fps=30')
    expect(plan.inputs.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 问题 C：中间视频的音轨按「源区间截取 + 变速」，定格/图片静音
// ---------------------------------------------------------------------------
describe('问题 C：动画片段音轨按源区间截取并变速', () => {
  it('2x 片段：截整个源区间 + atempo 链，映射到 [anim_a]', () => {
    const clip = video('c1', { sourceStart: 2, sourceEnd: 6, speed: 2 })
    const audio = planAnimatedClipAudio(clip, 'src.mp4')
    // 截的是源区间 4s（而不是时间轴 2s），变速交给滤镜
    expect(audio.inputArgs).toEqual(['-ss', '2', '-t', '4', '-i', 'src.mp4'])
    expect(audio.filter).toContain('atempo=2')
    expect(audio.mapArgs).toContain('[anim_a]')
    expect(audio.mapArgs).toContain('-filter_complex')
    // 4s 源 / 2x = 2s，正好等于画面用的 clipTimelineDuration
    expect(clipTimelineDuration(clip)).toBeCloseTo(2, 9)
  })

  it('keepPitch=false 用 asetrate 链；1x 时不需要滤镜', () => {
    const low = video('c2', { sourceStart: 0, sourceEnd: 4, speed: 0.5, keepPitch: false })
    expect(planAnimatedClipAudio(low, 'src.mp4').filter).toContain('asetrate=')
    const plain = video('c3', { sourceStart: 0, sourceEnd: 4 })
    const audio = planAnimatedClipAudio(plain, 'src.mp4')
    expect(audio.filter).toBeNull()
    expect(audio.mapArgs).toEqual([
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
    ])
  })

  it('分段变速：逐段 atrim（相对输入起点）+ 变速 + concat', () => {
    // 源 2–8：边界在 at=0.5 → 源 5s；相对输入起点 2s 后是 3s
    const clip = video('c4', { sourceStart: 2, sourceEnd: 8, speedSegments: SEGMENTS })
    const filter = planAnimatedClipAudio(clip, 'src.mp4').filter!
    expect(filter).toContain('[1:a]atrim=start=0:end=3')
    expect(filter).toContain('[1:a]atrim=start=3:end=6')
    // 4x 会被 atempoChain 拆成两级（单级 atempo 只支持 0.5–2）
    expect(filter).toContain('atempo=2,atempo=2')
    expect(filter).toContain('concat=n=2:v=0:a=1')
    expect(filter).toContain('[anim_a]')
    // 时长 3 + 3/4 = 3.75s，与画面一致
    expect(clipTimelineDuration(clip)).toBeCloseTo(3.75, 9)
  })

  it('定格片段：静音源，不带素材原声', () => {
    const freeze = createClip(SOURCE.url, 0, 3, { type: 'freeze', freezeFrameTime: 1 }, 'f1')
    const audio = planAnimatedClipAudio(freeze, 'src.mp4')
    expect(audio.silent).toBe(true)
    expect(audio.inputArgs).toEqual(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'])
    expect(audio.filter).toBeNull()
    expect(audio.mapArgs).toContain('1:a')
    // 素材本身没有音轨时也必须走静音（否则 -map 1:a 找不到音频流）
    const silentSource = video('c5', { sourceStart: 0, sourceEnd: 3, speed: 2 })
    expect(planAnimatedClipAudio(silentSource, 'src.mp4', false).silent).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 组合：分段变速 + 蒙版 + 动画字幕
// ---------------------------------------------------------------------------
describe('组合：分段变速 + 蒙版 + 动画字幕', () => {
  it('输入序号与总时长都对', () => {
    const main = video('combo-main', {
      sourceStart: 0,
      sourceEnd: 10,
      speedSegments: SEGMENTS,
      mask: { ...MASK_DEFAULTS },
      anim: { 'position.x': [{ t: 0, value: 0, ease: 'linear' }] },
    })
    const second = video('combo-2', { sourceStart: 12, sourceEnd: 15 })
    const project = projectOf([main, second], {
      textTracks: [
        textTrack([
          textClip('cap-1', {
            anim: {
              'position.y': [
                { t: 0, value: 0.8, ease: 'linear' },
                { t: 1, value: 0.5, ease: 'linear' },
              ],
            },
          }),
        ]),
      ],
    })

    // 三种特性确实都在
    expect(hasAnyAnimation(project)).toBe(true)
    expect(hasAnyTextAnimation(project)).toBe(true)
    expect([...project.clips, ...(project.overlayTracks ?? []).flatMap((t) => t.clips)].some((c) => c.mask)).toBe(true)

    // 媒体输入数 → 蒙版 PNG 的序号从它开始
    const mediaInputs = buildExportPlan(project, [SOURCE], true).inputs.length
    expect(mediaInputs).toBe(1)
    const plan = buildExportPlan(project, [SOURCE], true, {
      maskInputs: new Map([[main.id, mediaInputs]]),
    })
    // 蒙版读 [1:v]
    expect(plan.graph).toContain(`[${mediaInputs}:v]format=rgba,scale=`)

    // 文字层序号 = 媒体 + 蒙版；封面再往后一个
    const layout = exportInputLayout(plan.inputs.length, 1, true)
    expect(layout.textInputBase).toBe(mediaInputs + 1)
    expect(layout.coverInputIndex).toBe(mediaInputs + 2)
    applyTextOverlayGraph(plan, layout.textInputBase)
    expect(plan.graph).toContain(`[${layout.textInputBase}:v]format=rgba,fps=30`)

    // 总时长 = 分段变速后的主轨时长 + 第二段（字幕不改变时长）
    const expectedDuration = clipTimelineDuration(main) + clipTimelineDuration(second)
    expect(plan.totalDuration).toBeCloseTo(expectedDuration, 3)
    expect(plan.totalDuration).toBeCloseTo(6.25 + 3, 3)

    // 动画烘焙（主轨片段）：烘焙后的时长与它在时间轴上的时长一致
    const baked = bakeAnimatedClip(main, 'blob:anim-combo', clipTimelineDuration(main))
    expect(baked.speedSegments).toBeUndefined()
    expect(clipTimelineDuration(baked)).toBeCloseTo(clipTimelineDuration(main), 6)
  })
})