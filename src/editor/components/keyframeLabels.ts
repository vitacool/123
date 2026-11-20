import type { AnimatableProperty } from '../core/types'

/** 可动画属性的中文短标签（时间轴 tooltip / 曲线浮层共用）。 */
export const ANIMATABLE_LABELS: Record<AnimatableProperty, string> = {
  'position.x': '位置X',
  'position.y': '位置Y',
  scale: '缩放',
  rotation: '旋转',
  opacity: '不透明度',
  volume: '音量',
}

/** 把一组属性名连成「位置X、不透明度」。 */
export function labelList(props: readonly AnimatableProperty[]): string {
  return props.map((prop) => ANIMATABLE_LABELS[prop]).join('、')
}