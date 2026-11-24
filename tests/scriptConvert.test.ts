import { describe, expect, it } from 'vitest'
import { convertAsrScript } from '../src/editor/services/asr/scriptConvert'

describe('ASR 输出字形（opencc 不再写死）', () => {
  it('simplified：繁体转简体（历史默认行为）', () => {
    expect(convertAsrScript('繁體中文')).toBe('繁体中文')
  })

  it('traditional：简体转繁体', () => {
    expect(convertAsrScript('简体中文', 'traditional')).toBe('簡體中文')
  })

  it('original：原样返回', () => {
    expect(convertAsrScript('繁體中文', 'original')).toBe('繁體中文')
  })
})