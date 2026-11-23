import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { DraftProjectRecord } from '../src/editor/core/projectLibrary'
import type { DraftSnapshot } from '../src/editor/core/draft'

/**
 * 「紧急快照」：页面卸载时 IDB 写事务会被中止（pagehide 确实触发，但事务没提交），
 * 所以关页面前用**同步**的 localStorage 留一份，下次启动回放。
 *
 * 这里验证三件事：
 * 1. 写入后 `loadProjectRecord` 能读到它（即使 IDB 里还没有记录）；
 * 2. 它比 IDB 里的旧记录新时，读出来的是它；
 * 3. 正常落盘（saveProjectRecord）之后快照被清掉，不会反复回放旧内容。
 */

/** node 环境没有 localStorage：装一个同步的内存实现。 */
function installLocalStorage(): void {
  const map = new Map<string, string>()
  const storage = {
    get length() {
      return map.size
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

const record = (id: string, updatedAt: number, marker: string): DraftProjectRecord =>
  ({
    id,
    name: `project-${id}`,
    updatedAt,
    snapshot: { project: { clips: [{ id: marker }] } } as unknown as DraftSnapshot,
  }) as DraftProjectRecord

vi.resetModules()

describe('draftStore：页面卸载的紧急快照（localStorage）', () => {
  beforeEach(() => {
    installLocalStorage()
    // 每次用全新内存数据库，避免记录串场
    Object.defineProperty(globalThis, 'indexedDB', {
      value: new IDBFactory(),
      configurable: true,
      writable: true,
    })
  })

  it('写入后即使 IDB 没有记录也能被读到；正常落盘后快照被清除', async () => {
    vi.resetModules()
    const store = await import('../src/editor/services/draftStore')

    const pending = record('p1', 1000, 'from-emergency')
    expect(store.writeEmergencyDraft(pending)).toBe(true)

    // IDB 里没有 → 回放到紧急快照
    const loaded = await store.loadProjectRecord('p1')
    expect(loaded?.snapshot).toEqual(pending.snapshot)

    // 列表里也能看到（项目库刷新后能打开）
    const list = await store.loadProjectRecords()
    expect(list.map((item) => item.id)).toContain('p1')

    // 正常落盘后清除
    await store.saveProjectRecord(record('p1', 2000, 'persisted'))
    expect(localStorage.getItem('framecut:draft-pending:p1')).toBeNull()
    const after = await store.loadProjectRecord('p1')
    expect(after?.snapshot).toEqual(record('p1', 2000, 'persisted').snapshot)
  })

  it('快照比 IDB 记录旧时，仍用 IDB 里的（不拿旧内容覆盖新内容）', async () => {
    vi.resetModules()
    const store = await import('../src/editor/services/draftStore')

    await store.saveProjectRecord(record('p2', 5000, 'newer-in-idb'))
    store.writeEmergencyDraft(record('p2', 1000, 'older-emergency'))

    const loaded = await store.loadProjectRecord('p2')
    expect(loaded?.snapshot).toEqual(record('p2', 5000, 'newer-in-idb').snapshot)
    const list = await store.loadProjectRecords()
    const item = list.find((entry) => entry.id === 'p2')
    expect(item?.snapshot).toEqual(record('p2', 5000, 'newer-in-idb').snapshot)
  })

  it('localStorage 不可用（隐私模式）时安全降级，不抛错', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new Error('denied')
      },
      configurable: true,
    })
    vi.resetModules()
    const store = await import('../src/editor/services/draftStore')
    expect(() => store.writeEmergencyDraft(record('p3', 1, 'x'))).not.toThrow()
    await expect(store.loadProjectRecord('p3')).resolves.toBeNull()
  })
})