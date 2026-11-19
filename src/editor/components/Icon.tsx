import type { ReactNode, SVGProps } from 'react'

export type IconName =
  | 'undo'
  | 'redo'
  | 'export'
  | 'close'
  | 'chevron'
  | 'play'
  | 'pause'
  | 'replay'
  | 'split'
  | 'trimLeft'
  | 'trimRight'
  | 'rotateLeft'
  | 'rotateRight'
  | 'freeze'
  | 'crop'
  | 'flipH'
  | 'flipV'
  | 'marker'
  | 'fit'
  | 'fill'
  | 'reset'
  | 'trash'
  | 'plus'
  | 'minus'
  | 'zoom'
  | 'expand'
  | 'collapse'
  | 'check'
  | 'upload'
  | 'film'
  | 'note'
  | 'warning'
  | 'info'
  | 'clock'
  | 'mouse'
  | 'spark'
  | 'eye'
  | 'eyeOff'
  | 'volume'
  | 'volumeOff'
  | 'music'
  | 'power'
  | 'lock'
  | 'text'
  | 'unlink'

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName
  size?: number
}

const paths: Record<IconName, ReactNode> = {
  undo: (
    <>
      <path d="M9 7 4 12l5 5" />
      <path d="M4 12h9.2a5.8 5.8 0 0 1 5.8 5.8" />
    </>
  ),
  redo: (
    <>
      <path d="m15 7 5 5-5 5" />
      <path d="M20 12h-9.2a5.8 5.8 0 0 0-5.8 5.8" />
    </>
  ),
  export: (
    <>
      <path d="M12 3v12" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 16.5v3.2c0 .7.6 1.3 1.3 1.3h12.4c.7 0 1.3-.6 1.3-1.3v-3.2" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  chevron: <path d="m7 9.5 5 5 5-5" />,
  play: <path d="M8.5 5.8v12.4L18 12 8.5 5.8Z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <path d="M8.5 6v12" />
      <path d="M15.5 6v12" />
    </>
  ),
  replay: (
    <>
      <path d="M6.7 7.5A7.2 7.2 0 1 1 4.8 12" />
      <path d="M4.5 4.8v4.4h4.4" />
    </>
  ),
  split: (
    <>
      <path d="M12 3v7" />
      <path d="M12 14v7" />
      <path d="m8.5 10 3.5-3 3.5 3" />
      <path d="m8.5 14 3.5 3 3.5-3" />
    </>
  ),
  trimLeft: (
    <>
      <path d="M5 4v16" strokeDasharray="2 2.5" />
      <path d="M9 7v10l8-5-8-5Z" />
    </>
  ),
  trimRight: (
    <>
      <path d="M19 4v16" strokeDasharray="2 2.5" />
      <path d="M15 7v10l-8-5 8-5Z" />
    </>
  ),
  rotateLeft: (
    <>
      <path d="M5.2 9.2A7.5 7.5 0 1 1 5 14.8" />
      <path d="M5 4.8v4.5h4.5" />
    </>
  ),
  rotateRight: (
    <>
      <path d="M18.8 9.2A7.5 7.5 0 1 0 19 14.8" />
      <path d="M19 4.8v4.5h-4.5" />
    </>
  ),
  freeze: (
    <>
      <path d="M12 3v18" />
      <path d="m4.8 7.5 14.4 9" />
      <path d="m19.2 7.5-14.4 9" />
      <path d="m9.4 5.2 2.6 2.6 2.6-2.6" />
      <path d="m9.4 18.8 2.6-2.6 2.6 2.6" />
    </>
  ),
  crop: (
    <>
      <path d="M6.5 3v14.5H21" />
      <path d="M3 6.5h14.5V21" />
    </>
  ),
  flipH: (
    <>
      <path d="M12 3v18" strokeDasharray="2.5 3" />
      <path d="M8.5 6.5 4 12l4.5 5.5v-11Z" />
      <path d="M15.5 6.5 20 12l-4.5 5.5v-11Z" />
    </>
  ),
  flipV: (
    <>
      <path d="M3 12h18" strokeDasharray="2.5 3" />
      <path d="M6.5 8.5 12 4l5.5 4.5h-11Z" />
      <path d="M6.5 15.5 12 20l5.5-4.5h-11Z" />
    </>
  ),
  marker: (
    <>
      <path d="M7 21V4" />
      <path d="M7 4.5c3.2-1.5 5.6 1.5 9.5.3v8.7c-3.9 1.2-6.3-1.8-9.5-.3V4.5Z" />
    </>
  ),
  fit: (
    <>
      <path d="M8.5 4.5H4.5v4" />
      <path d="M15.5 4.5h4v4" />
      <path d="M19.5 15.5v4h-4" />
      <path d="M8.5 19.5h-4v-4" />
      <rect x="8" y="8" width="8" height="8" rx="1" />
    </>
  ),
  fill: (
    <>
      <path d="M5 5h14v14H5z" strokeDasharray="2.5 2.5" />
      <path d="M8 8h8v8H8z" />
    </>
  ),
  reset: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v4.3h4.3" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9 7V4.5h6V7" />
      <path d="m6.5 7 .8 12.2c0 .7.6 1.3 1.3 1.3h6.8c.7 0 1.3-.6 1.3-1.3L17.5 7" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  zoom: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  expand: (
    <>
      <path d="M4 9V4h5" />
      <path d="M20 15v5h-5" />
      <path d="M15 4h5v5" />
      <path d="M9 20H4v-5" />
    </>
  ),
  collapse: (
    <>
      <path d="M9 4v5H4" />
      <path d="M15 20v-5h5" />
      <path d="M20 9h-5V4" />
      <path d="M4 15h5v5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M4.5 15.5v3.2c0 .7.6 1.3 1.3 1.3h12.4c.7 0 1.3-.6 1.3-1.3v-3.2" />
    </>
  ),
  film: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M8 4.5v15M16 4.5v15M3.5 9H8M3.5 15H8M16 9h4.5M16 15h4.5" />
    </>
  ),
  note: (
    <>
      <path d="M5 4.5h14v15H5z" />
      <path d="M8.5 9h7M8.5 12.5h7M8.5 16h4" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.8 21 20H3L12 3.8Z" />
      <path d="M12 9v4.5" />
      <path d="M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  mouse: (
    <>
      <rect x="7" y="3.5" width="10" height="17" rx="5" />
      <path d="M12 3.5v6" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3v5M12 16v5M3 12h5M16 12h5" />
      <path d="m6 6 3 3M15 15l3 3M18 6l-3 3M9 15l-3 3" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12s3.4-6 9.2-6 9.2 6 9.2 6-3.4 6-9.2 6-9.2-6-9.2-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4.8 7.4C3.4 9 2.8 12 2.8 12s3.4 6 9.2 6c1.4 0 2.6-.3 3.7-.8" />
      <path d="M9.5 5.3c.8-.2 1.6-.3 2.5-.3 5.8 0 9.2 6 9.2 6s-1 1.8-2.8 3.4" />
      <path d="M4 4l16 16" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9.2h3L11 6v12l-4-3.2H4z" />
      <path d="M15 9.3a4 4 0 0 1 0 5.4" />
      <path d="M17.6 6.8a7.3 7.3 0 0 1 0 10.4" />
    </>
  ),
  volumeOff: (
    <>
      <path d="M4 9.2h3L11 6v12l-4-3.2H4z" />
      <path d="m16 9.5 5 5" />
      <path d="m21 9.5-5 5" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V6l9-2v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="15.5" cy="16" r="2.5" />
    </>
  ),
  power: (
    <>
      <path d="M12 3v9" />
      <path d="M6.6 6.7a7.5 7.5 0 1 0 10.8 0" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7.2a4 4 0 0 1 8 0V10" />
    </>
  ),
  unlink: (
    <>
      <path d="M9.5 14.5 6.2 17.8a2.9 2.9 0 0 1-4.1-4.1l3.3-3.3" />
      <path d="M14.5 9.5l3.3-3.3a2.9 2.9 0 0 1 4.1 4.1l-3.3 3.3" />
      <path d="M9.8 6.6 11 5.4a3.4 3.4 0 0 1 4.8 4.8l-1.2 1.2" />
      <path d="M14.2 17.4 13 18.6a3.4 3.4 0 0 1-4.8-4.8l1.2-1.2" />
    </>
  ),
  text: (
    <>
      <path d="M5 5h14" />
      <path d="M12 5v14" />
      <path d="M9 19h6" />
    </>
  ),
}

export function Icon({ name, size = 18, className, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}