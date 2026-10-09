import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COMMANDS, main } from '../src/cli.ts'

const capture = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text), stdin: async () => '' } }
}

test('cli knows the commands from the design', () => {
  assert.deepEqual(Object.keys(COMMANDS), ['plan', 'spawn', 'send', 'prompt', 'promote', 'roster', 'capture', 'close', 'board', 'down', 'up', 'budget', 'guard', 'mcp'])
})

test('cli --help prints usage and exits 0', async () => {
  const { out, io } = capture()
  assert.equal(await main(['--help'], io), 0)
  assert.match(out.join('\n'), /drove spawn <seat>/)
})

test('cli rejects an unknown command with 2', async () => {
  const { err, io } = capture()
  assert.equal(await main(['nope'], io), 2)
  assert.match(err.join('\n'), /unknown command nope/)
})

test('cli reports a usage error with 2', async () => {
  const { err, io } = capture()
  assert.equal(await main(['spawn', 'w-api'], io), 2)
  assert.match(err.join('\n'), /missing --brief/)
})

test('cli dispatches to the stubs (exit 70 until they land)', async () => {
  const { err, io } = capture()
  assert.equal(await main(['roster'], io), 70)
  assert.match(err.join('\n'), /not implemented: commands\.defaultDeps/)
})
