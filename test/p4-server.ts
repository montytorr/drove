import { serveMcp } from '../src/mcp.ts'
import { identityFromEnv } from '../src/paths.ts'
import { defaultToolPorts } from '../src/tools.ts'
import type { ToolPorts } from '../src/tools.ts'
import type { Role } from '../src/types.ts'
import { fakePorts, makeExec } from './p4-helpers.ts'

const identity = identityFromEnv()
if (!identity) throw new Error('identity env missing')

const commands = Object.fromEntries(
  ['spawn', 'send', 'prompt', 'promote', 'roster', 'capture', 'close', 'down', 'raiseBudget'].map((name) => [name, async () => ({ ok: true as const, text: `${name} ok` })]),
) as unknown as ToolPorts['commands']

const { exec } = makeExec()
const deps = { exec, clock: { now: () => new Date() }, home: identity.home }

await serveMcp(identity.role as Role, process.stdin, process.stdout, {
  deps,
  identity,
  toolPorts: { ...defaultToolPorts, commands },
  watchPorts: fakePorts().ports,
  loop: false,
})
