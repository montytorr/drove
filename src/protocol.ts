import type { Control, ControlKind, Envelope, Expects, Report, ReportInput, ReportKind } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: protocol.${name}`)
}

export const REPORT_KINDS: readonly ReportKind[] = ['done', 'question', 'blocked', 'progress', 'promote']
export const EXPECTS: readonly Expects[] = ['review', 'answer', 'none']
export const CONTROL_KINDS: readonly ControlKind[] = ['brief', 'message', 'answer', 'verdict', 'promote', 'demote', 'nudge']
export const ENVELOPE_OPEN = '⟦drove v1'
export const ENVELOPE_CLOSE = '⟧'

export const defaultExpects = (kind: ReportKind): Expects => todo('defaultExpects')
export const validateReport = (input: unknown): { ok: true; value: ReportInput } | { ok: false; error: string } => todo('validateReport')
export const stampReport = (input: ReportInput, meta: { id: string; run: string; seat: string; token: string; at: string }): Report => todo('stampReport')
export const macOf = (token: string, id: string, body: string): string => todo('macOf')
export const formatControl = (control: Control, token: string): string => todo('formatControl')
export const parseEnvelope = (text: string): Envelope | undefined => todo('parseEnvelope')
export const verifyControl = (envelope: Envelope, token: string): boolean => todo('verifyControl')
export const replyLine = (kind: ControlKind, expects: Expects): string => todo('replyLine')
export const renderReport = (report: Report, humanName: string): string => todo('renderReport')
export const renderReports = (reports: readonly Report[], humanName: string): string => todo('renderReports')
