import { describe, expect, it } from 'vitest'
import {
  buildCaptionsFromWords,
  captionPauseClass,
  charWidthUnit,
  cleanCaptionWord,
  containsCjk,
  audioRms,
  hasAudibleSignal,
  isFillerWord,
  maxLineUnits,
  measureWidthUnits,
  mixToMono,
  resamplePcm,
  slicePcm,
  stripFillers,
} from '../src/editor/core/captions'
import type { TimelineWord } from '../src/editor/core/captionMapping'

function word(text: string, start: number, end: number): TimelineWord {
  return {
    text,
    start,
    end,
    source: { sourceUrl: 'src', clipId: 'clip', trackKind: 'main' },
  }
}

function timeline(words: TimelineWord[]): TimelineWord[] {
  return [...words].sort((a, b) => a.start - b.start)
}

describe('规则 6：中文文本清洗', () => {
  it('只去掉句号，保留句中逗号/顿号/分号和？！/书名号/引号', () => {
    expect(cleanCaptionWord('你好。')).toBe('你好')
    expect(cleanCaptionWord('你好，世界')).toBe('你好，世界')
    expect(cleanCaptionWord('真的吗？')).toBe('真的吗？')
    expect(cleanCaptionWord('他说「很好」。')).toBe('他说「很好」')
    expect(cleanCaptionWord('一，二；三：四')).toBe('一，二；三：四')
  })

  it('中英混排时在英文/数字两侧各加一个半角空格', () => {
    expect(cleanCaptionWord('用iPhone拍照')).toBe('用 iPhone 拍照')
    expect(cleanCaptionWord('2024年')).toBe('2024 年')
    expect(cleanCaptionWord('hello世界')).toBe('hello 世界')
  })
})

describe('规则 1：标点分类', () => {
  it('句末标点为 hard，逗号类为 soft，其余为 null', () => {
    expect(captionPauseClass('你好。')).toBe('hard')
    expect(captionPauseClass('你好？')).toBe('hard')
    expect(captionPauseClass('你好！')).toBe('hard')
    expect(captionPauseClass('How!')).toBe('hard')
    expect(captionPauseClass('你好，')).toBe('soft')
    expect(captionPauseClass('a;')).toBe('soft')
    expect(captionPauseClass('你好')).toBe(null)
  })

  it('忽略末尾成对引号/括号', () => {
    expect(captionPauseClass('他说「好」')).toBe(null)
    expect(captionPauseClass('说完。」')).toBe('hard')
  })
})

describe('规则 2：宽度与字数上限', () => {
  it('全角记 1，半角记 0.5，并识别是否含中文', () => {
    expect(charWidthUnit('中')).toBe(1)
    expect(charWidthUnit('a')).toBe(0.5)
    expect(measureWidthUnits('你好ab')).toBeCloseTo(3)
    expect(containsCjk('你好 ab')).toBe(true)
    expect(containsCjk('hello world')).toBe(false)
  })

  it('上限 = min(放宽后的字数上限, 85% 宽度折合)', () => {
    expect(maxLineUnits('16:9', 0.055, true)).toBe(22)
    expect(maxLineUnits('9:16', 0.042, true)).toBeCloseTo(11.38, 1)
    expect(maxLineUnits('16:9', 0.055, false)).toBeCloseTo(21) // 42 * 0.5
    // 超大字号时 85% 宽度约束比字数上限更紧
    expect(maxLineUnits('16:9', 0.12, true)).toBeLessThan(22)
  })
})

describe('规则 7：语气词', () => {
  it('识别并删除单独出现的语气词，保留其他词的时间', () => {
    expect(isFillerWord('嗯')).toBe(true)
    expect(isFillerWord('那个')).toBe(true)
    expect(isFillerWord('就是说')).toBe(true)
    expect(isFillerWord('嗯嗯呢')).toBe(false)
    const words = timeline([word('嗯', 0, 0.3), word('大家好', 0.3, 1), word('那个', 1.1, 1.4)])
    const stripped = stripFillers(words)
    expect(stripped.map((w) => w.text)).toEqual(['大家好'])
    expect(stripped[0].start).toBe(0.3)
  })
})

describe('规则 1/3/4：断句优先级与时长约束', () => {
  it('句末标点优先断句，时间以词为准（末词 end + 0.1）', () => {
    const cues = buildCaptionsFromWords(
      timeline([word('你好', 0, 0.4), word('世界。', 0.4, 0.9), word('再见', 2, 2.8)]),
      { aspectRatio: '16:9' },
    )
    expect(cues.map((c) => c.text)).toEqual(['你好世界', '再见'])
    expect(cues[0]).toMatchObject({ start: 0, end: 1 })
    expect(cues[1]).toMatchObject({ start: 2, end: 2.9 })
  })

  it('停顿超过 0.45s 断句', () => {
    const cues = buildCaptionsFromWords(
      timeline([word('第一句', 0, 0.5), word('第二句', 1.2, 1.7)]),
      { aspectRatio: '16:9' },
    )
    expect(cues.map((c) => c.text)).toEqual(['第一句', '第二句'])
  })

  it('逗号类标点断句', () => {
    const cues = buildCaptionsFromWords(
      timeline([word('第一，', 0, 0.5), word('第二', 0.6, 1.1)]),
      { aspectRatio: '16:9' },
    )
    expect(cues.map((c) => c.text)).toEqual(['第一，', '第二'])
  })

  it('字数上限在词边界切断', () => {
    const long = Array.from({ length: 46 }, (_, index) =>
      word('字', index * 0.3, index * 0.3 + 0.29),
    )
    const cues = buildCaptionsFromWords(long, { aspectRatio: '16:9' })
    // 每个 cue 不超过放宽后的 16:9 上限（22 个全角字）
    for (const cue of cues) {
      expect(measureWidthUnits(cue.text)).toBeLessThanOrEqual(22)
    }
    expect(cues.length).toBeGreaterThan(1)
  })

  it('最短 0.8s 向后延长，且不盖到下一条', () => {
    const cues = buildCaptionsFromWords(
      timeline([word('短', 0, 0.2), word('下一条', 1.2, 1.7)]),
      { aspectRatio: '16:9' },
    )
    // 第一条从 0.2s 延长到 0.8s；下一条 1.2s 开始，不重叠
    expect(cues[0].end - cues[0].start).toBeGreaterThanOrEqual(0.79)
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start)
  })

  it('超过 6s 在最近的词边界切开', () => {
    const long = Array.from({ length: 30 }, (_, index) =>
      word(`词${index}`, index * 0.3, index * 0.3 + 0.29),
    )
    const cues = buildCaptionsFromWords(long, { aspectRatio: '1:1' })
    for (const cue of cues) {
      expect(cue.end - cue.start).toBeLessThanOrEqual(6.01)
      expect(cue.end - cue.start).toBeGreaterThanOrEqual(0.79)
    }
  })
})

describe('规则 5：防闪烁', () => {
  it('相邻间隔 < 0.3s 时把前一条延长到下一条起点', () => {
    const cues = buildCaptionsFromWords(
      timeline([word('前。', 0, 0.4), word('后', 0.6, 1)]),
      { aspectRatio: '16:9' },
    )
    expect(cues[0].end).toBe(cues[1].start)
  })
})

describe('口播 fixture 集成', () => {
  it('不折行、不闪烁、每条 0.8~6s、切点都在词边界', () => {
    const fixture: TimelineWord[] = timeline([
      word('大家好', 0.0, 0.6),
      word('今天', 0.6, 1.0),
      word('我们来', 1.0, 1.5),
      word('聊一下', 1.5, 2.0),
      word('智能字幕。', 2.0, 2.7),
      word('嗯', 2.8, 3.0),
      word('第一点', 3.2, 3.8),
      word('是', 3.8, 4.0),
      word('准确率，', 4.0, 4.5),
      word('第二点', 4.5, 5.1),
      word('是', 5.1, 5.3),
      word('速度。', 5.3, 5.9),
      word('那么', 6.3, 6.7),
      word('它', 6.7, 6.9),
      word('真的', 6.9, 7.2),
      word('好用吗？', 7.2, 8.0),
      word('我们用', 8.3, 8.9),
      word('iPhone', 8.9, 9.4),
      word('拍摄', 9.4, 9.8),
      word('并且', 9.8, 10.2),
      word('在2024年', 10.2, 11.0),
      word('发布了', 11.0, 11.4),
      word('这个', 11.4, 11.8),
      word('功能。', 11.8, 12.4),
    ])

    const cues = buildCaptionsFromWords(fixture, {
      aspectRatio: '16:9',
      removeFillers: true,
    })

    expect(cues.length).toBeGreaterThan(0)

    const starts = fixture.map((w) => w.start)
    for (const cue of cues) {
      const duration = cue.end - cue.start
      // 规则 3：时长在 0.8~6s 之间
      expect(duration).toBeGreaterThanOrEqual(0.79)
      expect(duration).toBeLessThanOrEqual(6.01)
      // 规则 2：不折行（宽度不超过上限）
      const hasCjk = containsCjk(cue.text)
      expect(measureWidthUnits(cue.text)).toBeLessThanOrEqual(
        maxLineUnits('16:9', 0.055, hasCjk),
      )
      // 规则 4/1：开始时间落在某个词边界上
      expect(starts).toContain(cue.start)
    }

    // 规则 5：相邻间隔不为负、且要么贴合要么 ≥0.3s
    for (let i = 0; i < cues.length - 1; i += 1) {
      const gap = cues[i + 1].start - cues[i].end
      expect(gap).toBeGreaterThanOrEqual(-1e-6)
      expect(gap === 0 || gap >= 0.29).toBe(true)
    }

    // 规则 7：语气词被去除
    const joined = cues.map((c) => c.text).join('')
    expect(joined).not.toContain('嗯')
  })
})

describe('audio PCM helpers', () => {
  it('mixes stereo channels to mono', () => {
    const mono = mixToMono([
      new Float32Array([1, 0, -1]),
      new Float32Array([0, 1, 1]),
    ])
    expect([...mono]).toEqual([0.5, 0.5, 0])
  })

  it('slices by seconds and resamples to 16 kHz', () => {
    const pcm = new Float32Array(16000).fill(0.5)
    expect(slicePcm(pcm, 16000, 0.25, 0.5)).toHaveLength(4000)
    const resampled = resamplePcm(new Float32Array(48000).fill(0.25), 48000, 16000)
    expect(resampled).toHaveLength(16000)
    expect(resampled[0]).toBeCloseTo(0.25)
  })

  it('detects silence and audible signal', () => {
    expect(hasAudibleSignal(new Float32Array(16000))).toBe(false)
    expect(hasAudibleSignal(new Float32Array(16000).fill(0.2))).toBe(true)
  })

  it('audioRms 返回均方根音量', () => {
    expect(audioRms(new Float32Array(0))).toBe(0)
    expect(audioRms(new Float32Array(16000))).toBe(0)
    expect(audioRms(new Float32Array(16000).fill(0.2))).toBeCloseTo(0.2, 3)
  })
})