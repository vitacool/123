import { describe, expect, it } from 'vitest'
import { DRAFT_SCHEMA_VERSION } from '../src/editor/core/draft'
import { createEmptyProject } from '../src/editor/core/operations'
import { toDraftSnapshot } from '../src/editor/services/draftStore'

describe('草稿快照版本号', () => {
  it('写入当前的 DRAFT_SCHEMA_VERSION（而不是硬编码 1）', () => {
    const snapshot = toDraftSnapshot({
      project: createEmptyProject(),
      assets: [],
      source: null,
      timelineZoom: 1,
      timelineSettings: {
        mainTrackMagnet: false,
        autoSnap: true,
        linkage: false,
        previewAxis: true,
      },
      captionFollow: true,
      exportRange: null,
      playhead: 0,
    })
    expect(snapshot.version).toBe(DRAFT_SCHEMA_VERSION)
  })
})