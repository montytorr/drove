import { join } from 'node:path'
import { plannerDir } from './paths.ts'
import { clipUtf8, jsonlBytes, LINE_MAX_BYTES, readJsonlFrom } from './store.ts'
import type { Report } from './types.ts'

// The planner's pending ledger (<run>/planner/pending.jsonl): what the watcher has for the planner and not yet delivered.
// `hold` is a done report whose checks Drove is running (DROVE-126), or one that follows such a report from the same seat
// and waits for it: on disk, so a restart still has it, and not the planner's yet. `add` is what the planner reads (a held
// report moves to it, with Drove's line in `report.autocheck`), `ack` takes ids off both.
export type LedgerLine = { t: 'hold'; report: Report } | { t: 'add'; report: Report } | { t: 'ack'; ids: string[] }

export const clippedMarker = (seat: string): string => ` … [clipped by Drove to fit its ${LINE_MAX_BYTES}-byte ledger line: drove reports ${seat} shows it in full]`

// What gives way when a ledger line is over the cap: the worker's details, then its summary, then Drove's own check line.
const CLIPPABLE = ['details', 'summary', 'autocheck'] as const

const clipped = (text: string, excess: number, marker: string): string => {
  // JSON escapes only add bytes, so cutting k bytes of the text takes at least k bytes off the line.
  const keep = Buffer.byteLength(text) - excess - (Buffer.byteLength(JSON.stringify(marker)) - 2)
  return `${clipUtf8(text, keep)}${marker}`
}

// The report as `line` can write it under the jsonl cap (DROVE-170), or undefined when even clipped it is over.
export const fitReport = (report: Report, line: (report: Report) => LedgerLine): Report | undefined => {
  const marker = clippedMarker(report.seat)
  let fitted = report
  for (const field of CLIPPABLE) {
    const excess = jsonlBytes(line(fitted)) - LINE_MAX_BYTES
    if (excess <= 0) return fitted
    const text = fitted[field]
    // A field no longer than the marker gains nothing from a clip.
    if (text && Buffer.byteLength(text) > Buffer.byteLength(marker)) fitted = { ...fitted, [field]: clipped(text, excess, marker) }
  }
  return jsonlBytes(line(fitted)) <= LINE_MAX_BYTES ? fitted : undefined
}

export const pendingFile = (home: string, run: string): string => join(plannerDir(home, run), 'pending.jsonl')

export type Folded = {
  open: Report[]
  held: Report[]
  seen: Set<string>
  // Reports the planner must not read: held now, or held and then sent back to the worker (never released). One that was
  // released (`add`) is not in it, whether or not it was acked afterwards.
  suppressed: Set<string>
  // Drove's line on each report that was released with one.
  notes: Map<string, string>
}

export const fold = (items: readonly LedgerLine[]): Folded => {
  const open = new Map<string, Report>()
  const held = new Map<string, Report>()
  const seen = new Set<string>()
  const suppressed = new Set<string>()
  const notes = new Map<string, string>()
  for (const line of items) {
    if (line.t === 'hold') {
      held.set(line.report.id, line.report)
      seen.add(line.report.id)
      if (!open.has(line.report.id)) suppressed.add(line.report.id)
    } else if (line.t === 'add') {
      held.delete(line.report.id)
      open.set(line.report.id, line.report)
      seen.add(line.report.id)
      suppressed.delete(line.report.id)
      if (line.report.autocheck) notes.set(line.report.id, line.report.autocheck)
    } else {
      for (const id of line.ids) {
        open.delete(id)
        held.delete(id)
      }
    }
  }
  return { open: [...open.values()], held: [...held.values()], seen, suppressed, notes }
}

const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

export const readFolded = async (home: string, run: string): Promise<Folded> => {
  try {
    return fold((await readJsonlFrom<LedgerLine>(pendingFile(home, run), { offset: 0 })).items)
  } catch (error) {
    if (isEnoent(error)) return fold([])
    throw error
  }
}
