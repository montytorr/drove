import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Control, ControlKind, Envelope, Expects, Report, ReportInput, ReportKind } from './types.ts'

export const REPORT_KINDS: readonly ReportKind[] = ['done', 'question', 'blocked', 'progress', 'promote']
export const EXPECTS: readonly Expects[] = ['review', 'answer', 'none']
export const CONTROL_KINDS: readonly ControlKind[] = ['brief', 'message', 'answer', 'verdict', 'promote', 'demote', 'nudge']
export const ENVELOPE_OPEN = '⟦drove v1'
export const ENVELOPE_CLOSE = '⟧'
export const SUMMARY_MAX = 500
export const DETAILS_MAX = 6000

const HEADER_RE = /^⟦drove v1((?: [a-z]+=[^\s⟧]*)*)⟧\n?([\s\S]*)$/
const REPLY_RE = /\n?↩ Reply [^\n]*$/
const MAC_LENGTH = 16

export const defaultExpects = (kind: ReportKind): Expects => (kind === 'done' ? 'review' : kind === 'progress' ? 'none' : 'answer')

export const newReportId = (seat: string, nowMs: number): string => `r-${seat}-${nowMs}-${randomBytes(2).toString('hex')}`

type Validation = { ok: true; value: ReportInput } | { ok: false; error: string }

export const validateReport = (input: unknown): Validation => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, error: 'report must be an object' }
  const { kind, expects, for: forWho, summary, details } = input as Record<string, unknown>
  if (typeof kind !== 'string' || !(REPORT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `kind must be one of ${REPORT_KINDS.join(', ')}` }
  }
  const reportKind = kind as ReportKind
  if (expects !== undefined && (typeof expects !== 'string' || !(EXPECTS as readonly string[]).includes(expects))) {
    return { ok: false, error: `expects must be one of ${EXPECTS.join(', ')}` }
  }
  if (forWho !== undefined && forWho !== 'human') return { ok: false, error: 'for must be "human" when given' }
  if (typeof summary !== 'string' || !summary.trim()) return { ok: false, error: 'summary is required' }
  const oneLine = summary.replace(/\s+/g, ' ').trim()
  if (oneLine.length > SUMMARY_MAX) return { ok: false, error: `summary is ${oneLine.length} characters, the cap is ${SUMMARY_MAX}` }
  if (details !== undefined && typeof details !== 'string') return { ok: false, error: 'details must be a string' }
  if (typeof details === 'string' && details.length > DETAILS_MAX) {
    return { ok: false, error: `details is ${details.length} characters, the cap is ${DETAILS_MAX}` }
  }
  return {
    ok: true,
    value: {
      kind: reportKind,
      expects: (expects as Expects | undefined) ?? defaultExpects(reportKind),
      ...(forWho ? { for: 'human' as const } : {}),
      summary: oneLine,
      ...(typeof details === 'string' && details.trim() ? { details: details.trim() } : {}),
    },
  }
}

export const stampReport = (input: ReportInput, meta: { id: string; run: string; seat: string; token: string; at: string }): Report => ({
  v: 1,
  id: meta.id,
  run: meta.run,
  seat: meta.seat,
  token: meta.token,
  kind: input.kind,
  expects: input.expects ?? defaultExpects(input.kind),
  ...(input.for ? { for: input.for } : {}),
  summary: input.summary,
  ...(input.details ? { details: input.details } : {}),
  at: meta.at,
})

// A terminal turns a pasted LF into CR (or CRLF) and drops trailing blanks, so the mac is taken over this canonical
// form on both ends. mod/hooks/protocol.ts canonicalText and canonicalBody mirror these two; keep them identical.
export const canonicalText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')

export const canonicalBody = (text: string): string => canonicalText(text).trim()

export const macOf = (token: string, id: string, body: string): string =>
  createHmac('sha256', token).update(`${id}\n${canonicalBody(body)}`).digest('hex').slice(0, MAC_LENGTH)

const fieldValue = (value: string): string => value.replace(/[\s⟧]+/g, '_')

export const replyLine = (kind: ControlKind, expects: Expects): string => {
  const via = 'Reply with the drove report tool (server drove)'
  if (kind === 'brief') return `↩ ${via} when done, blocked, or when you need a decision.`
  if (kind === 'nudge') return `↩ ${via}: kind done, question or blocked.`
  if (kind === 'verdict') {
    return expects === 'none'
      ? `↩ ${via}: kind done, expects none, with the branch and the commit sha.`
      : `↩ ${via}: kind done, expects review, once the changes are made and verified.`
  }
  if (expects === 'review') return `↩ ${via}: kind done, expects review.`
  if (expects === 'answer') return `↩ ${via}: kind question, expects answer.`
  return ''
}

export const formatControl = (control: Control, token: string): string => {
  const body = canonicalBody(control.body)
  const fields: [string, string | undefined][] = [
    ['run', control.run],
    ['from', control.from],
    ['to', control.to],
    ['id', control.id],
    ['kind', control.kind],
    ['verdict', control.verdict],
    ['model', control.model],
    ['effort', control.effort],
    ['expects', control.expects],
    ['mac', macOf(token, control.id, body)],
  ]
  const header = fields
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => ` ${key}=${fieldValue(value)}`)
    .join('')
  const reply = replyLine(control.kind, control.expects)
  return [`${ENVELOPE_OPEN}${header}${ENVELOPE_CLOSE}`, body, reply].filter(Boolean).join('\n')
}

export const parseEnvelope = (text: string): Envelope | undefined => {
  const match = HEADER_RE.exec(canonicalText(text).trimStart())
  if (!match) return undefined
  const fields: Record<string, string> = {}
  for (const pair of (match[1] ?? '').trim().split(' ').filter(Boolean)) {
    const at = pair.indexOf('=')
    fields[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return { fields, body: (match[2] ?? '').replace(REPLY_RE, '').trim() }
}

export const verifyControl = (envelope: Envelope, token: string): boolean => {
  const { id, mac } = envelope.fields
  if (!id || !mac || !token) return false
  const expected = Buffer.from(macOf(token, id, envelope.body))
  const given = Buffer.from(mac)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

const NEXT: Record<ReportKind, string> = {
  progress: '',
  done: 'Review the work (read-only: git diff, Read, Grep), then answer with drove send, kind verdict (approve, or changes with notes).',
  blocked: 'Unblock it with drove send, or ask the human if the decision is theirs.',
  question: 'Answer with drove send, kind answer (expects none unless you need more), or ask the human if the decision is theirs.',
  promote: 'Decide with drove promote (higher effort on the worker model first, then the promoted model), or refuse with drove send saying why.',
}

export const renderReport = (report: Report, humanName: string): string => {
  const forHuman = report.for === 'human'
  const next = forHuman
    ? `This decision is ${humanName}'s: ask ${humanName} now (give the worker's options as choices), then relay the answer with drove send, kind answer. Do not decide it yourself.`
    : report.kind === 'done' && report.expects === 'none'
      ? 'This confirms work you already approved (branch and commit). Nothing to review: close it with drove close unless you have more for it.'
      : NEXT[report.kind]
  const head = `[worker ${report.seat} · ${report.kind}${forHuman ? ` for ${humanName}` : ''} · expects ${report.expects}]`
  return [head, report.summary, report.details ?? '', next ? `→ ${next}` : ''].filter(Boolean).join('\n')
}

export const renderReports = (reports: readonly Report[], humanName: string): string =>
  reports.map(report => renderReport(report, humanName)).join('\n\n')
