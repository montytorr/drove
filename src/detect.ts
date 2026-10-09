import type { Attention, Derived, Seat, SeatSignals } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: detect.${name}`)
}

export const DIALOGS: readonly { pattern: RegExp; reason: Attention['reason']; detail: string }[] = [
  {
    pattern: /Background server has incompatible feature settings/,
    reason: 'codex-version-mismatch',
    detail: 'Codex CLI and app-server daemon versions differ; align them (codex --version vs the daemon). Drove will not answer the dialog.',
  },
  { pattern: /trust (this|the files in this) folder/i, reason: 'trust', detail: 'A folder-trust prompt is waiting in the pane.' },
  { pattern: /hook.*trust/i, reason: 'hook-trust', detail: 'A hook-trust prompt is waiting in the pane.' },
]

export const HOOK_FRESH_MS = 10_000
export const NUDGE_GRACE_MS = 20_000

export const matchDialog = (seat: string, screen: string, at: Date): Attention | undefined => todo('matchDialog')
export const deriveState = (seat: Seat, signals: SeatSignals, now: Date): Derived => todo('deriveState')
export const needsNudge = (seat: Seat, now: Date): boolean => todo('needsNudge')
