import { closeSync, constants, openSync, writeSync } from 'node:fs'
import { isForHuman } from '../mod/hooks/roster.ts'
import * as herdr from './herdr.ts'
import type { Exec, HerdrAgent, Seat, SeatState } from './types.ts'

// DROVE-141: herdr reads a Claude pane's light only from its screen and title, so a planner that ends its turn while
// its workers run shows blue (done). herdr's claude manifest reads a title that starts with a Braille or half-circle
// spinner glyph as working (osc_title_working, above the idle prompt box), so Drove writes such a title to the planner
// pane's terminal while it waits on working workers. That is display only: it goes to the terminal's output, never its
// input. Claude takes the title back at its next turn; when the waiting ends, Drove puts back Claude's idle `✳ ` title.

// Claude animates half-circles while it works, so a title with this Braille cell is Drove's and nobody else's.
export const LIGHT_GLYPH = '⠿'
export const IDLE_GLYPH = '✳'
// Claude may rewrite its title while idle; the poll sees that at once. This re-writes Drove's own title now and then too.
export const REASSERT_MS = 30_000

export const workingTitle = (text: string): string => `${LIGHT_GLYPH} ${text}`
export const idleTitle = (text: string): string => `${IDLE_GLYPH} ${text}`
export const oscTitle = (title: string): string => `\x1b]0;${title.replace(/[\u0000-\u001f\u007f]/g, ' ')}\x07`

const QUIET: ReadonlySet<SeatState> = new Set(['closing', 'closed', 'down'])
const ASKS: ReadonlySet<string> = new Set(['question', 'blocked', 'promote'])

// The same seats the attention list names (attention.ts): a dialog or approval in the pane, an item for a person, or a
// question, block or promotion the worker sent for the human and nobody has answered.
export const needsHuman = (seat: Seat): boolean =>
  seat.state === 'blocked' ||
  seat.state === 'needs-input' ||
  seat.attention.some(isForHuman) ||
  (seat.owes !== 'none' && seat.lastReport?.for === 'human' && ASKS.has(seat.lastReport.kind))

// Yellow only while at least one worker works and nobody waits on a person, so red and blue stay honest.
export const wantsWorking = (seats: readonly Seat[], runNeedsHuman = false): boolean => {
  const live = seats.filter(seat => !QUIET.has(seat.state))
  return !runNeedsHuman && live.some(seat => seat.state === 'working') && !live.some(needsHuman)
}

export type LightHold = { text: string; at: number }
export type LightStep = { hold?: LightHold; write?: string }

const textOf = (planner: HerdrAgent): string | undefined =>
  planner.title || planner.terminalTitle?.replace(/^\S\s+/u, '').trim() || undefined

// One look at the planner pane. While Drove holds the title, herdr shows exactly Drove's title; any other title means
// Claude has taken it back (a turn started, or it rewrote its idle title), and Drove lets go without restoring anything.
export const stepLight = (hold: LightHold | undefined, planner: HerdrAgent | undefined, wanted: boolean, now: number): LightStep => {
  if (!planner) return {}
  if (hold && planner.terminalTitle === workingTitle(hold.text)) {
    if (!wanted) return { write: idleTitle(hold.text) }
    if (now - hold.at >= REASSERT_MS) return { hold: { ...hold, at: now }, write: workingTitle(hold.text) }
    return { hold }
  }
  const isResting = planner.status === 'idle' || planner.status === 'done'
  const text = textOf(planner)
  if (!wanted || !isResting || !text) return {}
  return { hold: { text, at: now }, write: workingTitle(text) }
}

// ---------- the planner pane's terminal ----------

const TTY_NAME = /^(?:tty[\w.]+|pts\/\d+)$/

export const paneTty = async (exec: Exec, paneId: string): Promise<string | undefined> => {
  const info = await herdr.run(exec, herdr.paneProcessInfoArgv(paneId), 10_000)
  const pid = info.ok ? herdr.parseShellPid(info.value) : undefined
  if (pid === undefined) return undefined
  const ps = await exec(['ps', '-o', 'tty=', '-p', String(pid)], { timeoutMs: 5_000 })
  const name = ps.stdout.trim()
  return ps.code === 0 && TTY_NAME.test(name) ? `/dev/${name}` : undefined
}

// Synchronous, so a watcher that stops can still put the idle title back on its way out.
export const writeTty = (path: string, data: string): void => {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOCTTY)
  try {
    writeSync(fd, data)
  } finally {
    closeSync(fd)
  }
}
