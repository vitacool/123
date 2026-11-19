let counter = 0

/**
 * Stable enough for a browser editor and injectable for deterministic tests.
 * `crypto.randomUUID` is only available in secure contexts, so keep a fallback.
 */
export function createId(prefix: string): string {
  counter += 1
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
  }
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`
}