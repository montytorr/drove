import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as protocol from '../src/protocol.ts'
import type { Control } from '../src/types.ts'

const TOKEN = 'a'.repeat(64)
const control: Control = {
  v: 1,
  id: 'c-17',
  run: 'drove-20261009-1042-a3f1',
  from: 'planner',
  to: 'w-api',
  kind: 'verdict',
  expects: 'none',
  verdict: 'approve',
  body: 'Approved. Commit only your own paths now.',
  at: '2026-10-09T10:20:53.000Z',
}

test('constants are pinned', () => {
  assert.deepEqual(protocol.REPORT_KINDS, ['done', 'question', 'blocked', 'progress', 'promote'])
  assert.deepEqual(protocol.EXPECTS, ['review', 'answer', 'none'])
  assert.equal(protocol.ENVELOPE_OPEN, '⟦drove v1')
})

test('defaultExpects follows the kind', () => {
  assert.equal(protocol.defaultExpects('done'), 'review')
  assert.equal(protocol.defaultExpects('progress'), 'none')
  for (const kind of ['question', 'blocked', 'promote'] as const) assert.equal(protocol.defaultExpects(kind), 'answer')
})

test('validateReport fills expects and normalises the summary', () => {
  const result = protocol.validateReport({ kind: 'done', summary: ' all\n  green ', details: ' branch x ' })
  assert.deepEqual(result, { ok: true, value: { kind: 'done', expects: 'review', summary: 'all green', details: 'branch x' } })
})

test('validateReport keeps an explicit expects and for', () => {
  const result = protocol.validateReport({ kind: 'question', expects: 'answer', for: 'human', summary: 's' })
  assert.deepEqual(result, { ok: true, value: { kind: 'question', expects: 'answer', for: 'human', summary: 's' } })
})

test('validateReport rejects bad input', () => {
  const bad = [null, 'x', [], {}, { kind: 'hello', summary: 's' }, { kind: 'done' }, { kind: 'done', summary: '  ' }, { kind: 'done', summary: 's', expects: 'x' }, { kind: 'done', summary: 's', for: 'cal' }, { kind: 'done', summary: 'x'.repeat(501) }, { kind: 'done', summary: 's', details: 3 }, { kind: 'done', summary: 's', details: 'x'.repeat(6001) }]
  for (const input of bad) assert.equal(protocol.validateReport(input).ok, false, JSON.stringify(input))
})

test('a report round-trips through JSON after stamping', () => {
  const checked = protocol.validateReport({ kind: 'done', summary: 'ok', details: 'd' })
  assert.ok(checked.ok)
  const report = protocol.stampReport(checked.value, { id: protocol.newReportId('w-api', 1760000000000), run: 'r', seat: 'w-api', token: 't', at: '2026-10-09T10:20:53.000Z' })
  assert.match(report.id, /^r-w-api-1760000000000-[0-9a-f]{4}$/)
  assert.equal(report.v, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report)
  assert.equal(protocol.validateReport(report).ok, true)
})

const FIELDS = { id: 'c-1', run: 'r-1', from: 'planner', to: 'w-api', kind: 'promote', model: 'claude-opus-5-5', effort: 'high', expects: 'none' }

test('macOf is the first 16 hex of HMAC-SHA256 over the signed header fields and the body', () => {
  const mac = protocol.macOf(TOKEN, FIELDS, 'body')
  assert.match(mac, /^[0-9a-f]{16}$/)
  assert.equal(mac, protocol.macOf(TOKEN, FIELDS, 'body'))
  assert.notEqual(mac, protocol.macOf(TOKEN, { ...FIELDS, id: 'c-2' }, 'body'))
  assert.notEqual(mac, protocol.macOf(TOKEN, FIELDS, 'bodY'))
  assert.notEqual(mac, protocol.macOf('b'.repeat(64), FIELDS, 'body'))
  assert.deepEqual(protocol.MAC_FIELDS, ['id', 'run', 'from', 'to', 'kind', 'verdict', 'model', 'effort', 'expects'])
  assert.equal(
    protocol.macInput(FIELDS, ' body \r\n'),
    'drove v1\nid=c-1\nrun=r-1\nfrom=planner\nto=w-api\nkind=promote\nverdict=\nmodel=claude-opus-5-5\neffort=high\nexpects=none\n\nbody',
  )
  // pinned: mod/hooks/protocol.ts and mod/tests/orchestrator.test.tsx pin the same value for the same input
  assert.equal(protocol.macOf('tok', FIELDS, 'Approved.\n\nShip it'), '82816e5fcc24eb4a')
})

test('every header field that changes behaviour is covered by the mac, and a missing field differs from a set one', () => {
  const edits: Record<string, string> = { id: 'c-9', run: 'r-9', from: 'planner2', to: 'w-other', kind: 'brief', verdict: 'approve', model: 'claude-fable-5-1', effort: 'max', expects: 'review' }
  const all = { ...FIELDS, verdict: 'changes' }
  const base = protocol.macOf(TOKEN, all, 'body')
  assert.notEqual(base, protocol.macOf(TOKEN, FIELDS, 'body'), 'a verdict that was not there before')
  for (const key of protocol.MAC_FIELDS) {
    assert.notEqual(protocol.macOf(TOKEN, { ...all, [key]: edits[key] }, 'body'), base, `editing ${key}`)
    assert.notEqual(protocol.macOf(TOKEN, { ...all, [key]: undefined }, 'body'), base, `dropping ${key}`)
  }
  assert.equal(protocol.macOf(TOKEN, { ...all, extra: 'ignored' }, 'body'), base)
})

test('a control envelope round-trips and verifies', () => {
  const text = protocol.formatControl(control, TOKEN)
  assert.match(text, /^⟦drove v1 run=drove-20261009-1042-a3f1 from=planner to=w-api id=c-17 kind=verdict verdict=approve expects=none mac=[0-9a-f]{16}⟧\n/)
  const envelope = protocol.parseEnvelope(text)
  assert.ok(envelope)
  assert.equal(envelope.body, control.body)
  assert.deepEqual(
    { id: envelope.fields.id, to: envelope.fields.to, kind: envelope.fields.kind, verdict: envelope.fields.verdict, expects: envelope.fields.expects },
    { id: 'c-17', to: 'w-api', kind: 'verdict', verdict: 'approve', expects: 'none' },
  )
  assert.equal(protocol.verifyControl(envelope, TOKEN), true)
})

test('the generated reply line is rendered but not part of the body', () => {
  const text = protocol.formatControl(control, TOKEN)
  assert.match(text, /\n↩ Reply with the drove report tool \(server drove\): kind done, expects none, with the branch and the commit sha\.$/)
  assert.doesNotMatch(protocol.parseEnvelope(text)?.body ?? '', /↩/)
})

test('a multi-line body with blank lines survives', () => {
  const body = 'line one\n\nline three\n- bullet'
  const envelope = protocol.parseEnvelope(protocol.formatControl({ ...control, kind: 'message', verdict: undefined, expects: 'answer', body }, TOKEN))
  assert.equal(envelope?.body, body)
  assert.equal(protocol.verifyControl(envelope as NonNullable<typeof envelope>, TOKEN), true)
})

test('a MAC mismatch is detected', () => {
  const text = protocol.formatControl(control, TOKEN)
  const envelope = protocol.parseEnvelope(text)
  assert.ok(envelope)
  assert.equal(protocol.verifyControl(envelope, 'b'.repeat(64)), false)
  assert.equal(protocol.verifyControl({ ...envelope, body: `${envelope.body} (edited)` }, TOKEN), false)
  assert.equal(protocol.verifyControl({ ...envelope, fields: { ...envelope.fields, id: 'c-18' } }, TOKEN), false)
  assert.equal(protocol.verifyControl({ ...envelope, fields: { ...envelope.fields, mac: 'short' } }, TOKEN), false)
  const { mac: _mac, ...noMac } = envelope.fields
  assert.equal(protocol.verifyControl({ ...envelope, fields: noMac }, TOKEN), false)
})

test('editing a header field of a genuine envelope fails the mac', () => {
  const genuine = protocol.formatControl({ ...control, kind: 'promote', verdict: undefined, model: 'claude-sonnet-5-5', effort: 'high', expects: 'none' }, TOKEN)
  const envelope = protocol.parseEnvelope(genuine)
  assert.ok(envelope)
  assert.equal(protocol.verifyControl(envelope, TOKEN), true)
  const edits: Record<string, string> = { model: 'claude-fable-5-1', effort: 'max', kind: 'demote', expects: 'review', to: 'w-other', run: 'drove-20991231-2359-ffff', from: 'human', verdict: 'approve' }
  for (const [key, value] of Object.entries(edits)) {
    assert.equal(protocol.verifyControl({ ...envelope, fields: { ...envelope.fields, [key]: value } }, TOKEN), false, `edited ${key}`)
  }
  const { effort: _effort, ...withoutEffort } = envelope.fields
  assert.equal(protocol.verifyControl({ ...envelope, fields: withoutEffort }, TOKEN), false, 'dropped effort')
  assert.equal(protocol.verifyControl({ ...envelope, fields: { ...envelope.fields, note: 'extra' } }, TOKEN), true, 'a key outside the signed set is ignored')
  const verdict = protocol.parseEnvelope(protocol.formatControl(control, TOKEN))
  assert.ok(verdict)
  assert.equal(protocol.verifyControl({ ...verdict, fields: { ...verdict.fields, verdict: 'changes' } }, TOKEN), false, 'verdict approve edited to changes')
})

test('promote controls carry model and effort', () => {
  const text = protocol.formatControl({ ...control, kind: 'promote', verdict: undefined, model: 'claude-opus-5-5', effort: 'high', expects: 'none' }, TOKEN)
  const envelope = protocol.parseEnvelope(text)
  assert.equal(envelope?.fields.model, 'claude-opus-5-5')
  assert.equal(envelope?.fields.effort, 'high')
})

test('a multi-paragraph envelope typed as a paste (CR or CRLF line ends, trailing blanks dropped) still verifies', () => {
  const body = 'Plan — step one → verify · done   \n\nSecond paragraph, with a line that ends in blanks \t \n\nThird: ok'
  const text = protocol.formatControl({ ...control, kind: 'brief', verdict: undefined, expects: 'review', body }, TOKEN)
  assert.doesNotMatch(text, /[ \t]$/m)
  assert.equal(protocol.macOf(TOKEN, FIELDS, body), protocol.macOf(TOKEN, FIELDS, body.replace(/\n/g, '\r\n')))
  for (const eol of ['\n', '\r', '\r\n']) {
    const envelope = protocol.parseEnvelope(text.replace(/\n/g, eol))
    assert.ok(envelope)
    assert.equal(envelope.body, 'Plan — step one → verify · done\n\nSecond paragraph, with a line that ends in blanks\n\nThird: ok')
    assert.equal(protocol.verifyControl(envelope, TOKEN), true)
    assert.equal(protocol.verifyControl({ ...envelope, body: `${envelope.body}!` }, TOKEN), false)
  }
})

test('parseEnvelope rejects text that is not an envelope', () => {
  assert.equal(protocol.parseEnvelope('hello'), undefined)
  assert.equal(protocol.parseEnvelope('⟦orch v1 id=x⟧\nbody'), undefined)
  assert.equal(protocol.parseEnvelope('  ⟦drove v1 id=c-1 mac=ab⟧\nbody')?.body, 'body')
})

test('replyLine tells the receiver how to answer', () => {
  assert.match(protocol.replyLine('brief', 'none'), /when done, blocked/)
  assert.match(protocol.replyLine('verdict', 'review'), /kind done, expects review/)
  assert.match(protocol.replyLine('answer', 'answer'), /kind question/)
  assert.match(protocol.replyLine('nudge', 'none'), /done, question or blocked/)
  assert.equal(protocol.replyLine('message', 'none'), '')
})

test('renderReport names the next step and the human', () => {
  const base = { v: 1 as const, id: 'r', run: 'r', seat: 'w-api', token: 't', summary: 'tests pass', at: '2026-10-09T10:20:53.000Z' }
  const done = protocol.renderReport({ ...base, kind: 'done', expects: 'review', details: 'branch b' }, 'Sam')
  assert.match(done, /^\[worker w-api · done · expects review\]\ntests pass\nbranch b\n→ Review the work/)
  const asked = protocol.renderReport({ ...base, kind: 'question', expects: 'answer', for: 'human' }, 'Sam')
  assert.match(asked, /question for Sam · expects answer/)
  assert.match(asked, /This decision is Sam's/)
  const confirm = protocol.renderReport({ ...base, kind: 'done', expects: 'none' }, 'Sam')
  assert.match(confirm, /confirms work you already approved/)
  assert.doesNotMatch(protocol.renderReport({ ...base, kind: 'progress', expects: 'none' }, 'Sam'), /→/)
})

test('renderReports joins several reports', () => {
  const base = { v: 1 as const, id: 'r', run: 'r', token: 't', kind: 'blocked' as const, expects: 'answer' as const, summary: 's', at: '2026-10-09T10:20:53.000Z' }
  const text = protocol.renderReports([{ ...base, seat: 'a' }, { ...base, seat: 'b' }], 'the human')
  assert.match(text, /\[worker a · blocked[\s\S]*\n\n\[worker b · blocked/)
})
