import { Converter } from 'opencc-js'
import type { AsrScript } from '../../core/asr'

const toSimplified = Converter({ from: 'tw', to: 'cn' })
const toTraditional = Converter({ from: 'cn', to: 'tw' })

/**
 * 繁简转换。以前 worker 里**无条件**把繁体转简体，用户无法保留繁体原文；
 * 现在作为显式选项传入，并参与 ASR 缓存键（切换字形不会复用旧缓存）。
 */
export function convertAsrScript(
  text: string,
  script: AsrScript = 'simplified',
): string {
  if (script === 'original') return text
  if (script === 'traditional') return toTraditional(text)
  return toSimplified(text)
}