export interface OpenProjectMessage {
  type: 'open'
  projectId: string
  at: number
}

/**
 * 判断跨标签页广播的消息是否指向「当前同一个项目」。
 * 纯函数便于单测；实际收发由 VideoEditor 的 BroadcastChannel effect 完成。
 */
export function isSameProjectOpenMessage(
  data: unknown,
  projectId: string | null,
): boolean {
  if (!projectId || !data || typeof data !== 'object') return false
  const message = data as Partial<OpenProjectMessage>
  return (
    message.type === 'open' &&
    typeof message.projectId === 'string' &&
    message.projectId === projectId
  )
}