import { describe, expect, it } from 'vitest'
import {
  REVERSE_MAX_LONG_SIDE,
  buildReverseChunkArgs,
  buildReverseConcatArgs,
  buildReverseConcatList,
  countLinkedCaptions,
  matchesReverseOrigin,
  mirrorAnimationTimes,
  needsReverseConfirm,
  originalRangeOf,
  planReverseRestore,
  replaceClipSourceInProject,
  reverseActionState,
  reverseAssetFileName,
  reverseAssetName,
  reverseAssetOrigin,
  reverseChunks,
  reverseOrder,
  reverseScalePlan,
} from '../src/editor/core/reverse'
import { evalAnimation } from '../src/editor/core/animation'
import { createReverseClipCommand } from '../src/editor/core/commands'
import { HistoryStack } from '../src/editor/core/history'
import {
  addOverlayTrackFromClip,
  createClip,
  createInitialProject,
} from '../src/editor/core/operations'
import type {
  Clip,
  Easing,
  Keyframe,
  MediaAsset,
  Project,
  TextClip,
} from '../src/editor/core/types'

const SOURCE = { url: 'blob:reverse-source', duration: 30 }

function project(): Project {
  return createInitialProject(SOURCE, 'clip-a')
}

/** 带满属性 + 关键帧的主轨片段。 */
function richClip(): Clip {
  return {
    ...createClip(SOURCE.url, 2, 12, {}, 'clip-a'),
    rotation: 30,
    flipH: true,
    crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    scale: 1.2,
    position: { x: 0.1, y: -0.05 },
    speed: 2,
    keepPitch: false,
    volume: 0.6,
    fadeIn: 0.4,
    fadeOut: 0.3,
    opacity: 0.8,
    blendMode: 'screen',
    transitionOut: { type: 'fade', duration: 0.5 },
    background: { type: 'color', color: '#112233' },
    color: { brightness: 10, contrast: -5, saturation: 20, temperature: 8 },
    anim: {
      'position.x': [
        { t: 0, value: 0.2, ease: 'easeIn' },
        { t: 0.5, value: 0.5, ease: 'easeOut' },
        { t: 1, value: 0.9, ease: 'linear' },
      ],
      opacity: [
        { t: 0.25, value: 0.3, ease: 'hold' },
        { t: 0.75, value: 1, ease: 'easeInOut' },
      ],
      volume: [
        { t: 0, value: 0.2, ease: 'linear' },
        { t: 1, value: 1, ease: 'linear' },
      ],
    },
  }
}

describe('reverseChunks（分段区间）', () => {
  it('按 2 秒切分，尾段不足半段并入前一段', () => {
    expect(reverseChunks(0, 5)).toEqual([
      { start: 0, end: 2, duration: 2 },
      { start: 2, end: 4, duration: 2 },
      { start: 4, end: 5, duration: 1 },
    ])
    expect(reverseChunks(0, 4)).toEqual([
      { start: 0, end: 2, duration: 2 },
      { start: 2, end: 4, duration: 2 },
    ])
    // 4.05 秒：最后 0.05 秒并入第二段，而不是单独成段。
    expect(reverseChunks(0, 4.05)).toEqual([
      { start: 0, end: 2, duration: 2 },
      { start: 2, end: 4.05, duration: 2.05 },
    ])
    // 2.1 秒整段吃掉（剩余不足半段）。
    expect(reverseChunks(0, 2.1)).toEqual([{ start: 0, end: 2.1, duration: 2.1 }])
  })

  it('从源入点开始切分，且不超出源出点', () => {
    const chunks = reverseChunks(3, 8.5)
    expect(chunks[0].start).toBe(3)
    expect(chunks.at(-1)!.end).toBeCloseTo(8.5, 6)
    expect(chunks.every((chunk) => chunk.duration <= 2.06)).toBe(true)
    const covered = chunks.reduce((total, chunk) => total + chunk.duration, 0)
    expect(covered).toBeCloseTo(5.5, 6)
  })

  it('夹取非法输入；过短区间没有分段', () => {
    expect(reverseChunks(-3, 2)).toEqual([{ start: 0, end: 2, duration: 2 }])
    expect(reverseChunks(4, 4)).toEqual([])
    expect(reverseChunks(4, 3)).toEqual([])
    expect(reverseChunks(0, 0.01)).toEqual([])
    expect(reverseChunks(0, Number.NaN)).toEqual([])
  })

  it('长片段的分段数量符合「约 2 秒一段」', () => {
    expect(reverseChunks(0, 60)).toHaveLength(30)
    expect(needsReverseConfirm(60)).toBe(false)
    expect(needsReverseConfirm(60.5)).toBe(true)
  })
})

describe('reverseOrder（拼接顺序）', () => {
  it('按逆序输出分段下标', () => {
    expect(reverseOrder(3)).toEqual([2, 1, 0])
    expect(reverseOrder(1)).toEqual([0])
    expect(reverseOrder(0)).toEqual([])
  })
})

describe('reverseScalePlan（长边不超过源分辨率与 1080）', () => {
  it('1080p 横屏把长边压到 1080，等比且取偶数', () => {
    const plan = reverseScalePlan(1920, 1080)
    expect(plan.width).toBe(1080)
    expect(plan.height).toBe(608)
    expect(plan.filter).toBe('scale=1080:608:flags=lanczos')
  })

  it('小于上限的素材保持原尺寸（不放大）', () => {
    expect(reverseScalePlan(640, 360)).toMatchObject({ width: 640, height: 360 })
    expect(reverseScalePlan(720, 1280)).toMatchObject({ width: 608, height: 1080 })
  })

  it('4K 与竖屏 4K 都会降到长边 1080', () => {
    expect(reverseScalePlan(3840, 2160)).toMatchObject({ width: 1080, height: 608 })
    expect(reverseScalePlan(2160, 3840)).toMatchObject({ width: 608, height: 1080 })
    expect(REVERSE_MAX_LONG_SIDE).toBe(1080)
  })

  it('宽高非法时给出可用的最小偶数尺寸', () => {
    expect(reverseScalePlan(0, 0)).toMatchObject({ width: 2, height: 2 })
  })
})

describe('倒放素材命名', () => {
  it('去掉扩展名后加「-倒放」', () => {
    expect(reverseAssetName('demo.mp4')).toBe('demo-倒放')
    expect(reverseAssetFileName('demo.mp4')).toBe('demo-倒放.mp4')
    expect(reverseAssetFileName('a/b:c*.mov')).toBe('a-b-c--倒放.mp4')
  })

  it('空名与超长名', () => {
    expect(reverseAssetFileName(undefined)).toBe('framecut-倒放.mp4')
    expect(reverseAssetFileName('   ')).toBe('framecut-倒放.mp4')
    expect(reverseAssetName(`${'x'.repeat(80)}.mp4`)).toBe(`${'x'.repeat(56)}-倒放`)
  })
})

describe('FFmpeg 参数（分段 / 拼接）', () => {
  it('分段命令：输入定位 + 先缩放再 reverse，音频可选', () => {
    const args = buildReverseChunkArgs({
      inputFile: 'in.mp4',
      outputFile: 'chunk0.mp4',
      start: 2,
      duration: 1.5,
      scaleFilter: 'scale=1080:608:flags=lanczos',
      withAudio: true,
    })
    expect(args[args.indexOf('-ss') + 1]).toBe('2')
    expect(args[args.indexOf('-t') + 1]).toBe('1.5')
    expect(args[args.indexOf('-i') + 1]).toBe('in.mp4')
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1080:608:flags=lanczos,reverse')
    expect(args[args.indexOf('-af') + 1]).toBe('areverse')
    expect(args).toContain('-map')
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac')
    expect(args[args.length - 1]).toBe('chunk0.mp4')
  })

  it('无音频时用 -an，不出现 areverse', () => {
    const args = buildReverseChunkArgs({
      inputFile: 'in.mp4',
      outputFile: 'chunk0.mp4',
      start: 0,
      duration: 2,
      scaleFilter: 'scale=640:360',
      withAudio: false,
    })
    expect(args).toContain('-an')
    expect(args).not.toContain('-af')
    expect(args.join(' ')).not.toContain('areverse')
  })

  it('concat 列表按给定顺序列出文件', () => {
    expect(buildReverseConcatList(['c2.mp4', 'c1.mp4', 'c0.mp4'])).toBe(
      "ffconcat version 1.0\nfile 'c2.mp4'\nfile 'c1.mp4'\nfile 'c0.mp4'\n",
    )
  })

  it('拼接命令：concat 解复用 + 直接 copy', () => {
    const args = buildReverseConcatArgs({ listFile: 'list.txt', outputFile: 'out.mp4' })
    expect(args[args.indexOf('-f') + 1]).toBe('concat')
    expect(args[args.indexOf('-i') + 1]).toBe('list.txt')
    expect(args[args.indexOf('-c') + 1]).toBe('copy')
    expect(args[args.length - 1]).toBe('out.mp4')
  })

  it('拼接兜底：copy 失败时改用重编码参数', () => {
    const args = buildReverseConcatArgs({
      listFile: 'list.txt',
      outputFile: 'out.mp4',
      reencode: true,
    })
    expect(args).not.toContain('copy')
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264')
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac')
    expect(args[args.indexOf('-crf') + 1]).toBe('18')
  })
})

describe('关键帧镜像（t → 1 - t）', () => {
  /**
   * 等价性采样：对 t = 0, 0.01, …, 1 断言
   * `evalAnimation(镜像结果, 1 - t) === evalAnimation(原关键帧, t)`。
   *
   * hold 跳变点两侧 ±1e-3 内跳过断言：hold 在镜像后表达不了「区间起点立即跳到终点值」，
   * 实现用「段首之后 2e-4 处插入辅助帧」来近似，跳变时刻与原片只差 2e-4，
   * 误差只可能落在跳变点附近这个窗口里（窗口内本来就是一个瞬时跳变）。
   */
  const HOLD_SKIP = 1e-3

  /** 原关键帧里「实际发生跳变」的时间点：后一帧 ease === 'hold' 的那些帧。 */
  const holdJumps = (keys: readonly Keyframe[]): number[] => {
    const sorted = [...keys].sort((left, right) => left.t - right.t)
    const jumps: number[] = []
    for (let index = 1; index < sorted.length; index += 1) {
      if ((sorted[index].ease ?? 'linear') === 'hold') jumps.push(sorted[index].t)
    }
    return jumps
  }

  const nearJump = (t: number, keys: readonly Keyframe[]): boolean =>
    holdJumps(keys).some((jump) => Math.abs(t - jump) <= HOLD_SKIP)

  const expectMirrorEquivalent = (label: string, keys: Keyframe[]): void => {
    const mirrored = mirrorAnimationTimes({ 'position.x': keys })!['position.x']!
    for (let step = 0; step <= 100; step += 1) {
      const t = step / 100
      if (nearJump(t, keys)) continue
      const expected = evalAnimation(keys, t, 0)
      const actual = evalAnimation(mirrored, 1 - t, 0)
      if (Math.abs(actual - expected) >= 1e-6) {
        throw new Error(
          `${label} 在 t=${t} 不等价：原 ${expected}，镜像逆放 ${actual}`,
        )
      }
    }
  }

  const expectDoubleMirrorEquivalent = (label: string, keys: Keyframe[]): void => {
    const twice = mirrorAnimationTimes(mirrorAnimationTimes({ 'position.x': keys }))![
      'position.x'
    ]!
    for (let step = 0; step <= 100; step += 1) {
      const t = step / 100
      if (nearJump(t, keys)) continue
      const expected = evalAnimation(keys, t, 0)
      const actual = evalAnimation(twice, t, 0)
      if (Math.abs(actual - expected) >= 1e-6) {
        throw new Error(`${label} 两次镜像后在 t=${t} 不等价：原 ${expected}，实际 ${actual}`)
      }
    }
  }

  it('时间镜像并按时间重排，值随画面反向', () => {
    const mirrored = mirrorAnimationTimes({
      'position.x': [
        { t: 0, value: 0.2, ease: 'easeIn' },
        { t: 0.5, value: 0.5, ease: 'easeOut' },
        { t: 1, value: 0.9, ease: 'linear' },
      ],
    })!
    const keys = mirrored['position.x']!
    expect(keys.map((key) => key.t)).toEqual([0, 0.5, 1])
    expect(keys.map((key) => key.value)).toEqual([0.9, 0.5, 0.2])
    // 第一帧没有前一段 → linear。
    expect(keys[0].ease).toBe('linear')
    // 区间 [k0→k1] 的缓动来自后一帧 k1（easeOut），镜像后这一段反向，
    // 缓动落在来自 k0 的那一帧上，取反向缓动 easeIn。
    expect(keys[2].ease).toBe('easeIn')
    // 区间 [k1→k2] 的缓动来自 k2（linear），镜像后落在来自 k1 的那一帧上。
    expect(keys[1].ease).toBe('linear')
  })

  it('输入顺序打乱时先排序再镜像', () => {
    const mirrored = mirrorAnimationTimes({
      'position.x': [
        { t: 1, value: 0.9, ease: 'linear' },
        { t: 0, value: 0.2, ease: 'easeIn' },
        { t: 0.5, value: 0.5, ease: 'easeOut' },
      ],
    })!
    expect(mirrored['position.x']!.map((key) => key.t)).toEqual([0, 0.5, 1])
    expectMirrorEquivalent(
      '乱序输入',
      [
        { t: 0, value: 0.2, ease: 'easeIn' },
        { t: 0.5, value: 0.5, ease: 'easeOut' },
        { t: 1, value: 0.9, ease: 'linear' },
      ],
    )
  })

  it('[easeIn, hold, linear] 的镜像与原动画互逆', () => {
    const keys: Keyframe[] = [
      { t: 0, value: 0.2, ease: 'easeIn' },
      { t: 0.5, value: 0.5, ease: 'hold' },
      { t: 1, value: 0.9, ease: 'linear' },
    ]
    const mirrored = mirrorAnimationTimes({ 'position.x': keys })!['position.x']!
    // hold 段镜像后需要一条辅助帧表达「段首立即跳到终点值再保持」。
    expect(mirrored.length).toBe(keys.length + 1)
    const aux = mirrored.find((key) => key.ease === 'hold')
    expect(aux).toBeTruthy()
    expect(aux!.value).toBe(0.2)
    expect(aux!.t).toBeGreaterThan(0.5)
    expect(aux!.t).toBeLessThan(0.5 + 1e-3)
    // 辅助帧的间隔必须大于关键帧唯一性阈值（1e-4）。
    expect(aux!.t - 0.5).toBeGreaterThan(1e-4)

    expectMirrorEquivalent('[easeIn, hold, linear]', keys)
    expectDoubleMirrorEquivalent('[easeIn, hold, linear] 两次镜像', keys)
  })

  it('hold 在最后一帧时不被使用（末帧缓动不参与求值）', () => {
    const keys: Keyframe[] = [
      { t: 0.2, value: 0.4, ease: 'hold' },
      { t: 0.6, value: 0.9, ease: 'easeInOut' },
    ]
    const mirrored = mirrorAnimationTimes({ 'position.x': keys })!['position.x']!
    // 有效区间是 [0.2, 0.6]（用后一帧的 easeInOut），首帧的 hold 从不生效。
    expect(mirrored.map((key) => key.t)).toEqual([0.4, 0.8])
    expect(mirrored[1].value).toBe(0.4)
    expect(mirrored[1].ease).toBe('easeInOut')
    expectMirrorEquivalent('首帧 ease 不生效', keys)
    expectDoubleMirrorEquivalent('首帧 ease 不生效（两次镜像）', keys)
  })

  it('随机关键帧（固定种子，easeIn/easeOut/easeInOut/linear）镜像后仍互为逆放', () => {
    // 简单 LCG：固定种子保证可复现，不依赖 Math.random。
    let seed = 20261118
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const eases: Easing[] = ['easeIn', 'easeOut', 'easeInOut', 'linear']
    for (let round = 0; round < 12; round += 1) {
      const count = 2 + Math.floor(rand() * 4)
      const times: number[] = []
      for (let index = 0; index < count; index += 1) {
        // 留出间隔，避免产生零长度区间或重复时间点。
        times.push(index === 0 ? 0 : Math.min(1, index / (count - 1)))
      }
      const keys: Keyframe[] = times.map((t) => ({
        t,
        value: Math.round(rand() * 100) / 100,
        ease: eases[Math.floor(rand() * eases.length)],
      }))
      expectMirrorEquivalent(`随机第 ${round} 组`, keys)
      expectDoubleMirrorEquivalent(`随机第 ${round} 组（两次镜像）`, keys)
    }
  })

  it('音量关键帧也镜像（倒放后声音内容与包络一起反向）', () => {
    const volume = [
      { t: 0, value: 0.2, ease: 'linear' as const },
      { t: 0.4, value: 0.9, ease: 'linear' as const },
      { t: 1, value: 1, ease: 'linear' as const },
    ]
    const mirrored = mirrorAnimationTimes({ volume: [...volume] })!
    expect(mirrored.volume!.map((key) => key.t)).toEqual([0, 0.6, 1])
    // 值随声音内容反向：原来的末帧值现在在最前面。
    expect(mirrored.volume!.map((key) => key.value)).toEqual([1, 0.9, 0.2])
  })

  it('没有关键帧时返回 undefined', () => {
    expect(mirrorAnimationTimes(undefined)).toBeUndefined()
    expect(mirrorAnimationTimes({})).toBeUndefined()
    expect(mirrorAnimationTimes({ 'position.x': [] })).toBeUndefined()
  })
})

describe('替换片段素材（保留其它属性 + 断开字幕链接）', () => {
  it('主轨片段：只换素材引用与关键帧，其它属性全保留', () => {
    const clip = richClip()
    const base: Project = { ...project(), clips: [clip] }
    const mirrored = mirrorAnimationTimes(clip.anim)
    const next = replaceClipSourceInProject(base, {
      clipId: 'clip-a',
      sourceUrl: 'blob:reversed',
      sourceStart: 0,
      sourceEnd: 10,
      anim: mirrored,
    })
    const updated = next.clips[0]
    expect(updated.sourceUrl).toBe('blob:reversed')
    expect(updated.sourceStart).toBe(0)
    expect(updated.sourceEnd).toBe(10)
    // 保留：变速、调色、变换、转场、音量、不透明度、混合、背景、裁剪…
    expect(updated.speed).toBe(2)
    expect(updated.keepPitch).toBe(false)
    expect(updated.volume).toBe(0.6)
    // 淡入淡出对调：倒放后声音方向相反，原来的淡入变成淡出。
    expect(updated.fadeIn).toBe(0.3)
    expect(updated.fadeOut).toBe(0.4)
    expect(updated.opacity).toBe(0.8)
    expect(updated.blendMode).toBe('screen')
    expect(updated.transitionOut).toEqual({ type: 'fade', duration: 0.5 })
    expect(updated.background).toEqual({ type: 'color', color: '#112233' })
    expect(updated.color).toEqual({ brightness: 10, contrast: -5, saturation: 20, temperature: 8 })
    expect(updated.crop).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 })
    expect(updated.rotation).toBe(30)
    expect(updated.flipH).toBe(true)
    expect(updated.position).toEqual({ x: 0.1, y: -0.05 })
    // 关键帧（含音量）全部镜像。
    expect(updated.anim!['position.x']!.map((key) => key.value)).toEqual([0.9, 0.5, 0.2])
    expect(updated.anim!.volume!.map((key) => key.value)).toEqual([1, 0.2])
  })

  it('叠加轨片段同样可用', () => {
    const base = addOverlayTrackFromClip(project(), 'clip-a', 'track-over', 'overlay-a')!.project
    const next = replaceClipSourceInProject(base, {
      clipId: 'overlay-a',
      sourceUrl: 'blob:reversed',
      sourceStart: 0,
      sourceEnd: 5,
    })
    expect(next.overlayTracks![0].clips[0].sourceUrl).toBe('blob:reversed')
    expect(next.clips[0].sourceUrl).toBe(SOURCE.url)
  })

  it('断开指向该片段的智能字幕链接，其它字幕保持原样', () => {
    const linked: TextClip = {
      id: 'linked',
      text: '字幕',
      start: 1,
      end: 3,
      x: 0.5,
      y: 0.9,
      fontSize: 0.05,
      color: '#fff',
      background: 'transparent',
      align: 'center',
      bold: false,
      link: { clipId: 'clip-a', sourceStart: 2, sourceEnd: 4, padStart: 0, padEnd: 0 },
    }
    const manual: TextClip = { ...linked, id: 'manual', link: undefined }
    const base: Project = {
      ...project(),
      textTracks: [
        { id: 'track-text', name: '字幕', muted: false, hidden: false, clips: [linked, manual] },
      ],
    }
    expect(countLinkedCaptions(base, 'clip-a')).toBe(1)
    const next = replaceClipSourceInProject(base, {
      clipId: 'clip-a',
      sourceUrl: 'blob:reversed',
      sourceStart: 0,
      sourceEnd: 5,
    })
    const [nextLinked, nextManual] = next.textTracks![0].clips
    expect(nextLinked.link).toBeUndefined()
    // 字幕文本与时间保持原样（交给用户重新对齐，而不是静默删除）。
    expect(nextLinked.text).toBe('字幕')
    expect(nextLinked.start).toBe(1)
    expect(nextManual.link).toBeUndefined()
    expect(countLinkedCaptions(next, 'clip-a')).toBe(0)
  })

  it('找不到片段时返回原 project（引用不变）', () => {
    const base = project()
    const next = replaceClipSourceInProject(base, {
      clipId: 'missing',
      sourceUrl: 'blob:reversed',
      sourceStart: 0,
      sourceEnd: 5,
    })
    expect(next).toBe(base)
  })

  it('命令可撤销 / 重做，撤销后恢复原素材与字幕链接', () => {
    const linked: TextClip = {
      id: 'linked',
      text: '字幕',
      start: 1,
      end: 3,
      x: 0.5,
      y: 0.9,
      fontSize: 0.05,
      color: '#fff',
      background: 'transparent',
      align: 'center',
      bold: false,
      link: { clipId: 'clip-a', sourceStart: 2, sourceEnd: 4, padStart: 0, padEnd: 0 },
    }
    const clip = richClip()
    const initial: Project = {
      ...project(),
      clips: [clip],
      textTracks: [
        { id: 'track-text', name: '字幕', muted: false, hidden: false, clips: [linked] },
      ],
    }
    const history = new HistoryStack(initial)
    const command = createReverseClipCommand({
      clipId: 'clip-a',
      sourceUrl: 'blob:reversed',
      sourceStart: 0,
      sourceEnd: 10,
      anim: mirrorAnimationTimes(clip.anim),
    })
    expect(command.label).toBe('倒放片段')

    const applied = history.execute(command)
    expect(applied.changed).toBe(true)
    expect(history.project.clips[0].sourceUrl).toBe('blob:reversed')
    expect(history.project.textTracks![0].clips[0].link).toBeUndefined()

    history.undo()
    expect(history.project.clips[0].sourceUrl).toBe(SOURCE.url)
    expect(history.project.clips[0].sourceStart).toBe(2)
    expect(history.project.clips[0].anim).toEqual(clip.anim)
    expect(history.project.textTracks![0].clips[0].link).toEqual(linked.link)

    history.redo()
    expect(history.project.clips[0].sourceUrl).toBe('blob:reversed')
    expect(history.project.textTracks![0].clips[0].link).toBeUndefined()
  })
})

describe('倒放素材复用判断', () => {
  const asset = (extra: Partial<MediaAsset> = {}): MediaAsset => ({
    id: 'asset-a',
    url: 'blob:asset-a',
    name: 'a.mp4',
    size: 1,
    duration: 10,
    width: 1920,
    height: 1080,
    kind: 'video',
    ...extra,
  })

  it('同一原素材同一区间才复用', () => {
    const origin = reverseAssetOrigin(asset(), 2, 8)
    expect(origin).toEqual({ assetId: 'asset-a', sourceUrl: 'blob:asset-a', start: 2, end: 8 })
    const reversed = asset({
      id: 'asset-rev',
      url: 'blob:rev',
      reversedFrom: origin,
    })
    expect(matchesReverseOrigin(reversed, reverseAssetOrigin(asset(), 2, 8))).toBe(true)
    // 区间不同 → 不复用。
    expect(matchesReverseOrigin(reversed, reverseAssetOrigin(asset(), 2, 9))).toBe(false)
    // 原素材不同 → 不复用。
    expect(
      matchesReverseOrigin(reversed, reverseAssetOrigin(asset({ id: 'other' }), 2, 8)),
    ).toBe(false)
    // 普通素材没有来源记录 → 不复用。
    expect(matchesReverseOrigin(asset(), origin)).toBe(false)
  })

  it('区间用 1e-4 容差比较（浮点往返）', () => {
    const reversed = asset({ reversedFrom: { assetId: 'asset-a', start: 2, end: 8 } })
    expect(matchesReverseOrigin(reversed, { assetId: 'asset-a', start: 2.00000001, end: 8 })).toBe(
      true,
    )
  })
})

describe('恢复正放：原区间推导 originalRangeOf', () => {
  /** 倒放素材覆盖原素材 [2,12]（长度 10s）。 */
  const origin = { assetId: 'asset-orig', sourceUrl: 'blob:orig', start: 2, end: 12 }

  it('未分割：整段倒放素材映射回整个原始区间', () => {
    expect(originalRangeOf({ sourceStart: 0, sourceEnd: 10 }, origin)).toEqual({
      start: 2,
      end: 12,
    })
  })

  it('倒放后从中间分割：两段各自映射到原片对应区间，且首尾相接、方向相反', () => {
    // 时间轴左半段（倒放素材 0..5）对应原片的后半段 7..12。
    const left = originalRangeOf({ sourceStart: 0, sourceEnd: 5 }, origin)
    // 时间轴右半段（倒放素材 5..10）对应原片的前半段 2..7。
    const right = originalRangeOf({ sourceStart: 5, sourceEnd: 10 }, origin)
    expect(left).toEqual({ start: 7, end: 12 })
    expect(right).toEqual({ start: 2, end: 7 })
    // 首尾相接（原片上不重叠、不留缝）。
    expect(left.start).toBe(right.end)
  })

  it('左裁 / 右裁之后', () => {
    // 裁掉倒放素材开头 2 秒（原片末尾 2 秒）→ 原 [2,10]。
    expect(originalRangeOf({ sourceStart: 2, sourceEnd: 10 }, origin)).toEqual({
      start: 2,
      end: 10,
    })
    // 裁掉倒放素材末尾 2 秒（原片开头 2 秒）→ 原 [4,12]。
    expect(originalRangeOf({ sourceStart: 0, sourceEnd: 8 }, origin)).toEqual({
      start: 4,
      end: 12,
    })
    // 两头都裁。
    expect(originalRangeOf({ sourceStart: 2, sourceEnd: 8 }, origin)).toEqual({
      start: 4,
      end: 10,
    })
  })

  it('变速片段只改时间轴时长、不改源区间', () => {
    const clip = { sourceStart: 0, sourceEnd: 10, speed: 4 }
    expect(originalRangeOf(clip, origin)).toEqual({ start: 2, end: 12 })
  })

  it('越界的源区间被夹回原始区间内', () => {
    expect(originalRangeOf({ sourceStart: 0, sourceEnd: 12 }, origin)).toEqual({
      start: 2,
      end: 12,
    })
    expect(originalRangeOf({ sourceStart: -2, sourceEnd: 6 }, origin)).toEqual({
      start: 6,
      end: 12,
    })
  })
})

describe('倒放 → 恢复正放（整条链路）', () => {
  const originalAsset: MediaAsset = {
    id: 'asset-orig',
    url: 'blob:orig',
    name: 'orig.mp4',
    size: 1,
    duration: 20,
    width: 1920,
    height: 1080,
    kind: 'video',
  }
  /** 倒放素材：覆盖原片 [2,12]，长度 10s。 */
  const reversedAsset: MediaAsset = {
    id: 'asset-rev',
    url: 'blob:rev',
    name: 'orig-倒放.mp4',
    size: 1,
    duration: 10,
    width: 1920,
    height: 1080,
    kind: 'video',
    reversedFrom: { assetId: 'asset-orig', sourceUrl: 'blob:orig', start: 2, end: 12 },
  }
  const assets = [originalAsset, reversedAsset]

  /** 原片段（带满属性 + 关键帧），位于原素材 [2,12]。 */
  const originalClip = (): Clip => ({
    ...createClip('blob:orig', 2, 12, {}, 'clip-a'),
    rotation: 30,
    flipH: true,
    scale: 1.2,
    position: { x: 0.1, y: -0.05 },
    speed: 2,
    volume: 0.6,
    fadeIn: 0.4,
    opacity: 0.8,
    blendMode: 'screen',
    transitionOut: { type: 'fade', duration: 0.5 },
    color: { brightness: 10, contrast: -5, saturation: 20, temperature: 8 },
    anim: {
      'position.x': [
        { t: 0, value: 0.2, ease: 'easeIn' },
        { t: 0.5, value: 0.5, ease: 'easeOut' },
        { t: 1, value: 0.9, ease: 'linear' },
      ],
    },
  })

  /** 倒放后的片段：指向倒放素材 [0,10]，关键帧已镜像、淡入淡出已对调。 */
  const reversedClip = (): Clip => {
    const base = originalClip()
    return {
      ...base,
      sourceUrl: 'blob:rev',
      sourceStart: 0,
      sourceEnd: 10,
      anim: mirrorAnimationTimes(base.anim),
      fadeIn: base.fadeOut,
      fadeOut: base.fadeIn,
    }
  }

  const stripAnim = (clip: Clip): Omit<Clip, 'anim'> => {
    const { anim: _anim, ...rest } = clip
    return rest
  }

  it('倒放在状态上可被识别，且给出「取消倒放」文案', () => {
    const state = reverseActionState({ clip: reversedClip(), assets })
    expect(state.reversed).toBe(true)
    expect(state.enabled).toBe(true)
    expect(state.label).toBe('取消倒放')
    expect(state.originalAsset?.id).toBe('asset-orig')
    expect(state.originalRange).toEqual({ start: 2, end: 12 })

    const normal = reverseActionState({ clip: originalClip(), assets })
    expect(normal.reversed).toBe(false)
    expect(normal.label).toBe('倒放')
  })

  it('原素材优先按 assetId 查找（blob URL 刷新后会变）', () => {
    const refreshed: MediaAsset = { ...originalAsset, url: 'blob:orig-after-reload' }
    const plan = planReverseRestore({ clip: reversedClip(), assets: [refreshed, reversedAsset] })!
    expect(plan).toBeTruthy()
    expect(plan.input.sourceUrl).toBe('blob:orig-after-reload')
  })

  it('恢复命令：sourceUrl 与区间回到原片段，其余属性完全相同，关键帧逆放等价', () => {
    const clip = reversedClip()
    const plan = planReverseRestore({ clip, assets })!
    const restored = replaceClipSourceInProject(
      { ...project(), clips: [clip] },
      plan.input,
    ).clips[0]

    expect(restored.sourceUrl).toBe('blob:orig')
    expect(restored.sourceStart).toBe(2)
    expect(restored.sourceEnd).toBe(12)
    // 除素材引用与关键帧外，所有属性逐个相同。
    expect(stripAnim(restored)).toEqual(stripAnim(originalClip()))

    // 关键帧两次镜像后与原动画求值一致（hold 跳变点附近跳过，见上一个 describe 的说明）。
    const original = originalClip().anim!['position.x']!
    for (let step = 0; step <= 100; step += 1) {
      const t = step / 100
      if (Math.abs(t - 0.5) <= 1e-3) continue
      const expected = evalAnimation(original, t, 0)
      const actual = evalAnimation(restored.anim?.['position.x'], t, 0)
      expect(Math.abs(actual - expected)).toBeLessThan(1e-6)
    }
  })

  it('恢复命令可撤销 / 重做', () => {
    const clip = reversedClip()
    const history = new HistoryStack({ ...project(), clips: [clip] })
    const plan = planReverseRestore({ clip, assets })!
    const command = createReverseClipCommand(plan.input)
    expect(command.label).toBe('取消倒放')

    const applied = history.execute(command)
    expect(applied.changed).toBe(true)
    expect(history.project.clips[0].sourceUrl).toBe('blob:orig')
    expect(history.project.clips[0].sourceStart).toBe(2)

    history.undo()
    expect(history.project.clips[0].sourceUrl).toBe('blob:rev')
    expect(history.project.clips[0].sourceStart).toBe(0)
    expect(history.project.clips[0].sourceEnd).toBe(10)

    history.redo()
    expect(history.project.clips[0].sourceUrl).toBe('blob:orig')
    expect(history.project.clips[0].sourceStart).toBe(2)
  })

  it('原素材缺失：不产生恢复命令，可用性判断返回禁用与原因', () => {
    const clip = reversedClip()
    expect(planReverseRestore({ clip, assets: [reversedAsset] })).toBeNull()

    const state = reverseActionState({ clip, assets: [reversedAsset] })
    expect(state.reversed).toBe(true)
    expect(state.enabled).toBe(false)
    expect(state.reason).toBe('原素材已删除，无法恢复正放')
    expect(state.label).toBe('取消倒放')
  })

  it('可用性判断覆盖锁定 / 裁剪 / 进行中 / 定格片段', () => {
    const clip = originalClip()
    expect(reverseActionState({ clip, assets, locked: true }).reason).toBe('轨道已锁定，请先解锁')
    expect(reverseActionState({ clip, assets, cropping: true }).reason).toBe('正在裁剪画面')
    expect(reverseActionState({ clip, assets, busy: true }).reason).toBe('已有倒放任务在进行中')
    const freeze: Clip = { ...clip, type: 'freeze' }
    expect(reverseActionState({ clip: freeze, assets }).enabled).toBe(false)
    expect(reverseActionState({ clip: freeze, assets }).reason).toBe('定格 / 图片片段不支持倒放')
    expect(reverseActionState({ clip: null, assets }).reason).toBe('先在时间轴选一个视频片段')
  })
})