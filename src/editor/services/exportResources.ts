/**
 * 导出流程的资源清理器。
 *
 * 导出会往 FFmpeg 的共享虚拟文件系统（MEMFS）里写很多临时文件（输入副本、蒙版 PNG、
 * 文字层 PNG/列表、滤镜图脚本、输出文件、自检产物），还会为动画中间视频创建 objectURL。
 * 这些资源**必须在所有出口**都回收：成功、失败、以及中途取消。
 *
 * 之前这些清理散落在导出函数末尾的 `finally` 里，而动画预处理 / 蒙版写入 / 文字层渲染
 * 都发生在 `try` **之前** —— 那一步失败或取消时 `finally` 根本不执行：
 * MEMFS 里留下成堆文件（尤其蒙版 PNG 每次导出都累积）、objectURL 泄漏、
 * `activeExportSignal` 也不会被清空。
 *
 * 这里的约定：
 * - 资源**一创建/一写入就登记**，而不是结束时凭记忆列清单（漏写一处就漏一处泄漏）；
 * - {@link ExportResources.dispose} 幂等，且每一项单独 try/catch —— 某个文件删不掉
 *   不影响其它文件被删、也不影响 URL 回收。
 */

/** 只要能删文件即可，便于测试注入 mock（真实的 FFmpeg 实例满足这个形状）。 */
export interface FileDeleter {
  deleteFile(name: string): Promise<unknown>
}

export class ExportResources {
  private readonly files = new Set<string>()
  private readonly urls = new Set<string>()
  private disposed = false

  /** 登记一个待删除的 MEMFS 文件（重复登记无副作用）。 */
  registerFile(name: string): string {
    if (!this.disposed && name) this.files.add(name)
    return name
  }

  /** 批量登记文件（例如一组输入副本）。 */
  registerFiles(names: Iterable<string>): void {
    for (const name of names) this.registerFile(name)
  }

  /** 登记一个待回收的 objectURL（重复登记无副作用）。 */
  registerUrl(url: string): string {
    if (!this.disposed && url) this.urls.add(url)
    return url
  }

  /** 还没清理的资源（测试与日志用）。 */
  get pending(): { files: string[]; urls: string[] } {
    return { files: [...this.files], urls: [...this.urls] }
  }

  /**
   * 回收全部登记的资源。幂等：第二次调用直接返回，不会重复删/重复 revoke。
   *
   * @param ffmpeg 清理时**当前**的 FFmpeg 实例（多线程降级后旧 worker 的文件系统已不存在，
   *   所以调用方要传最终使用的那一个）；为 null 时只回收 URL。
   */
  async dispose(ffmpeg: FileDeleter | null): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const files = [...this.files]
    const urls = [...this.urls]
    this.files.clear()
    this.urls.clear()
    for (const file of files) {
      try {
        await ffmpeg?.deleteFile(file)
      } catch {
        // 单个文件删不掉（可能从未写入、或已被渲染器自行删除）不影响其它资源。
      }
    }
    for (const url of urls) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // 已失效的 URL 忽略。
      }
    }
  }
}

/**
 * FFmpeg 失败日志里「音频相关」的特征。
 *
 * 无声重试（丢掉音轨再导一次）只在能确认是音频合成问题时才做；
 * OOM、滤镜图语法错误、编码器初始化失败等必须原样报给用户，否则会把真实问题掩盖成
 * 「已改为导出无声视频」。
 */
const AUDIO_FAILURE_PATTERNS: readonly RegExp[] = [
  // 引用了音频流、但输入里没有：最常见的「原声合成失败」
  /matches no streams/i,
  /does not contain any stream/i,
  /could not find (?:an? )?audio/i,
  /no audio (?:stream|track)/i,
  // 明确指向音频流 / 音频滤镜的错误
  /stream specifier .*:a\b/i,
  /audio:.*(?:error|invalid|failed)/i,
  /error while (?:decoding|filtering|processing).*audio/i,
  /output pad .*(?:audio|:a\b)/i,
  // 音频滤镜 / 编码器初始化失败
  /\b(?:atempo|asetrate|aresample|amix|adelay|afade|atrim|anullsrc|anullsink)\b[^;]*(?:error|invalid|failed|not found)/i,
  /\b(?:libmp3lame|aac)\b[^;]*(?:error|not found|invalid)/i,
]

/** 判断这次失败是否属于「音频相关」，据此决定要不要静默重试无声导出。 */
export function isAudioRelatedFailure(
  error: unknown,
  logLines: readonly string[] = [],
): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const text = [message, ...logLines].join('\n')
  return AUDIO_FAILURE_PATTERNS.some((pattern) => pattern.test(text))
}