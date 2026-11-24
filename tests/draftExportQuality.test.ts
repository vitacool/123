import { describe, expect, it } from 'vitest'
import { normalizeProjectExportQuality } from '../src/editor/core/draft'
import { createInitialProject } from '../src/editor/core/operations'
import type { ExportTier } from '../src/editor/core/types'

const base = createInitialProject({ url: 'blob:a', duration: 10 }, 'clip-a')

describe('normalizeProjectExportQuality（画质档位）', () => {
  it('合法档位保持不变（对象引用也不变）', () => {
    const project = {
      ...base,
      exportQuality: { ...base.exportQuality, loudness: 'off' as const, tier: 'high' as ExportTier },
    }
    expect(normalizeProjectExportQuality(project)).toBe(project)
  })

  it('非法档位回退到缺省（standard）', () => {
    const project = {
      ...base,
      exportQuality: {
        ...base.exportQuality,
        loudness: 'off' as const,
        tier: 'ultra' as unknown as ExportTier,
      },
    }
    expect(normalizeProjectExportQuality(project).exportQuality.tier).toBeUndefined()
  })
})