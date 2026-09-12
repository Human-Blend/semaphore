import { useState } from 'react'
import type { ConvId } from '@shared/types'
import { IconButton } from '@/ui/atoms'
import { PollDialog } from './PollDialog'

// The composer's Poll control. Lives here rather than inside Composer.tsx for
// the same reason DiagramButton does: the composer keeps one line of poll code,
// and the dialog's state belongs to the thing that opens it.

export function PollIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M2.25 4.25h9" />
      <path d="M2.25 8h6" />
      <path d="M2.25 11.75h11.5" />
      <circle cx="13.25" cy="4.25" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="10.25" cy="8" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function PollButton({ conv, label }: { conv: ConvId; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton label="Start a poll" active={open} onClick={() => setOpen(true)}>
        <PollIcon size={16} />
      </IconButton>
      {open && <PollDialog conv={conv} label={label} onClose={() => setOpen(false)} />}
    </>
  )
}
