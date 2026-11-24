import { describe, expect, it } from 'vitest'
import { decodeSubtitleBytes, serializeSrt, serializeVtt } from '../src/editor/core/text'

describe('字幕导出：SRT / VTT', () => {
  it('SRT 使用逗号毫秒并带序号', () => {
    const out = serializeSrt([{ start: 1.5, end: 3.25, text: '你好' }])
    expect(out).toBe('1\n00:00:01,500 --> 00:00:03,250\n你好\n')
  })

  it('VTT 有 WEBVTT 头、用点分隔毫秒、cue 之间空行', () => {
    const out = serializeVtt([
      { start: 1.5, end: 3.25, text: '第一句' },
      { start: 4, end: 5, text: '第二句' },
    ])
    expect(out).toBe(
      'WEBVTT\n\n00:00:01.500 --> 00:00:03.250\n第一句\n\n00:00:04.000 --> 00:00:05.000\n第二句\n',
    )
  })

  it('VTT 空字幕只输出合法头，不产生多余空行', () => {
    expect(serializeVtt([])).toBe('WEBVTT\n\n')
  })
})

describe('字幕导入：编码识别', () => {
  it('UTF-8 正常解码', () => {
    const utf8 = new TextEncoder().encode('你好，世界')
    expect(decodeSubtitleBytes(utf8.buffer as ArrayBuffer)).toBe('你好，世界')
  })

  it('UTF-8 解不开时回退 GB18030（国产字幕常见）', () => {
    // “你好”的 GBK 字节：C4 E3 BA C3
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])
    expect(decodeSubtitleBytes(gbk.buffer as ArrayBuffer)).toBe('你好')
  })
})