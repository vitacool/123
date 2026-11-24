/**
 * 共享 Worker 的请求/响应桥。
 *
 * 为什么必须有：`new Worker(url)` **不会**因为脚本 404 / 被 CSP 拦截而抛错，
 * 它只在异步阶段派发一个 `error` 事件；模块内部 import 失败同理。如果调用方
 * 只在 `message` 上 resolve，这个 Promise 会**永久 pending**：界面卡在「正在识别」，
 * 既不报错也不结束，取消后重试还是同一个坏 worker（单例）。
 *
 * 同类问题在 FFmpeg 侧已经踩过（见 services/ffmpegRuntime.ts 的 LOAD_TIMEOUT_MS），
 * 这里把三件事一起处理：
 * 1. `error` / `messageerror` → reject 所有在途请求，并丢弃该 worker（下次重建）；
 * 2. 请求级「无消息看门狗」→ 下载卡住 / 推理卡死也能超时退出，而不是永久挂着；
 * 3. AbortSignal → 立即 reject 并把 `cancel` 转给 worker（worker 侧在块间检查）。
 */

export interface WorkerMessage {
  id: number
  type: string
}

export interface WorkerClientOptions {
  /** 用于拼错误文案，例如「语音识别 Worker」。 */
  label: string
  /** 创建 worker；每次重建（失败后）都会重新调用。 */
  create: () => Worker
  /**
   * 多久没收到任何消息（进度 / 结果 / 错误）就判定卡死。
   * 每收到一条属于该请求的消息都会重置计时；<= 0 表示关闭。
   */
  idleTimeoutMs?: number
}

/** 一次请求的构造参数。 */
export interface WorkerRequest<Message extends WorkerMessage> {
  build: (id: number) => { data: Record<string, unknown>; transfer?: Transferable[] }
  /** 处理属于该请求的消息；返回 true 表示这是终结消息（resolve）。 */
  handle: (message: Message) => boolean
  signal?: AbortSignal
}

interface Pending {
  reject: (error: Error) => void
  /** 清掉看门狗计时器。 */
  clearTimer: () => void
  /** 从 worker 上摘掉监听。 */
  detach: () => void
}

let nextRequestId = 1

function abortError(): Error {
  return typeof DOMException === 'function'
    ? new DOMException('已取消', 'AbortError')
    : Object.assign(new Error('已取消'), { name: 'AbortError' })
}

export class WorkerClient<Message extends WorkerMessage> {
  private readonly options: Required<Pick<WorkerClientOptions, 'label' | 'create'>> &
    Pick<WorkerClientOptions, 'idleTimeoutMs'>
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending>()

  constructor(options: WorkerClientOptions) {
    this.options = options
  }

  /** 当前 worker（可能为 null）；仅用于测试/诊断。 */
  get current(): Worker | null {
    return this.worker
  }

  /** 丢弃 worker 并 reject 所有在途请求（worker 级故障、测试重置）。 */
  dispose(reason: string): void {
    const worker = this.worker
    const entries = [...this.pending.entries()]
    this.worker = null
    this.pending.clear()
    for (const [, entry] of entries) {
      entry.clearTimer()
      entry.detach()
      entry.reject(new Error(reason))
    }
    worker?.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const created = this.options.create()
    // 脚本加载失败 / 模块解析失败 / CSP：只有 error 事件，没有 message。
    created.addEventListener('error', (event) => {
      const detail = (event as ErrorEvent)?.message
      this.dispose(
        `${this.options.label}加载失败${detail ? `：${detail}` : ''}（请检查 worker 资源是否可访问、CSP 是否允许 module worker）。`,
      )
    })
    created.addEventListener('messageerror', () => {
      this.dispose(`${this.options.label}消息通道错误（结构化克隆失败）。`)
    })
    this.worker = created
    return created
  }

  request(request: WorkerRequest<Message>): Promise<Message> {
    return new Promise<Message>((resolve, reject) => {
      const worker = this.ensureWorker()
      const id = nextRequestId
      nextRequestId += 1
      if (nextRequestId > 1e9) nextRequestId = 1

      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        this.pending.delete(id)
        worker.removeEventListener('message', onMessage)
        request.signal?.removeEventListener('abort', onAbort)
      }
      const settle = (action: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        action()
      }
      const armWatchdog = (): void => {
        const timeout = this.options.idleTimeoutMs ?? 0
        if (settled || timeout <= 0) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          settle(() =>
            reject(
              new Error(
                `${this.options.label}超过 ${Math.round(timeout / 1000)}s 没有任何响应，已中止（模型下载或推理卡住）。`,
              ),
            ),
          )
        }, timeout)
      }

      const onMessage = (event: MessageEvent): void => {
        const message = event.data as Message | undefined
        if (!message || typeof message !== 'object' || message.id !== id) return
        armWatchdog()
        if (!request.handle(message)) return
        settle(() => resolve(message))
      }
      const onAbort = (): void => {
        // 先告诉 worker 别再算了（它在人声块之间检查），再立刻 reject，不让 UI 等。
        try {
          worker.postMessage({ type: 'cancel', id })
        } catch {
          // worker 可能已经死了：忽略，反正要 reject。
        }
        settle(() => reject(abortError()))
      }

      this.pending.set(id, {
        reject,
        clearTimer: () => {
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
        },
        detach: () => worker.removeEventListener('message', onMessage),
      })

      if (request.signal?.aborted) {
        onAbort()
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      worker.addEventListener('message', onMessage)
      armWatchdog()
      try {
        const { data, transfer } = request.build(id)
        worker.postMessage(data, transfer ?? [])
      } catch (error) {
        settle(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        )
      }
    })
  }
}