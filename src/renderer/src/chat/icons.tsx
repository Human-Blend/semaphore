// Tiny inline SVG icons for the conversation pane — stroke: currentColor.

interface IconProps {
  size?: number
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  } as const
}

export function ReplyIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6.5 3.5 3 7l3.5 3.5" />
      <path d="M3 7h6a4 4 0 0 1 4 4v1.5" />
    </svg>
  )
}

export function PencilIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m11.1 2.6 2.3 2.3L5.6 12.7l-3.1.8.8-3.1z" />
      <path d="m9.6 4.1 2.3 2.3" />
    </svg>
  )
}

export function TrashIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.5 4.5h11" />
      <path d="M6.5 4.5V3.2a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.3" />
      <path d="m4 4.5.6 8a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8" />
      <path d="M6.6 7v3.8M9.4 7v3.8" />
    </svg>
  )
}

export function CopyIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.4a1.6 1.6 0 0 0-1.6-1.6H4.1a1.6 1.6 0 0 0-1.6 1.6v4.8a1.6 1.6 0 0 0 1.6 1.6h.4" />
    </svg>
  )
}

export function PinIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6.2 1.8h3.6l-.4 3.8 2.4 2v1H8.6v4.6L8 14.4l-.6-1.2V8.6H4.2v-1l2.4-2z" />
    </svg>
  )
}

export function SmilePlusIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="6.5" cy="9" r="5" />
      <path d="M4.6 8.2h.01M8.4 8.2h.01" strokeWidth={2} />
      <path d="M4.5 10.6a2.6 2.6 0 0 0 4 0" />
      <path d="M12.7 1.6v4M10.7 3.6h4" />
    </svg>
  )
}

export function CodeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M5.3 4.5 2 8l3.3 3.5" />
      <path d="M10.7 4.5 14 8l-3.3 3.5" />
    </svg>
  )
}

export function GifIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="1.5" y="3" width="13" height="10" rx="2.5" />
      <text
        x="8"
        y="10.6"
        textAnchor="middle"
        fontSize="5.4"
        fontWeight={700}
        fontFamily="var(--font-mono)"
        fill="currentColor"
        stroke="none"
      >
        GIF
      </text>
    </svg>
  )
}

export function SendIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M14 2 7.4 8.6" />
      <path d="M14 2 9.6 13.8 7.4 8.6 2.2 6.4z" />
    </svg>
  )
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
    </svg>
  )
}

export function ClockIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </svg>
  )
}

export function UploadIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 10.2V2.6" />
      <path d="M4.6 5.8 8 2.4l3.4 3.4" />
      <path d="M2.5 10.8v1.6a1.2 1.2 0 0 0 1.2 1.2h8.6a1.2 1.2 0 0 0 1.2-1.2v-1.6" />
    </svg>
  )
}
