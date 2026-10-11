#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { runBoard } from './board.ts'
import { runWeb } from './web.ts'
import * as commands from './commands.ts'
import { HOOK_EVENTS, runHook } from './hooks.ts'
import { isPidAlive } from './git.ts'
import { serveMcp } from './mcp.ts'
import * as modhost from './modhost.ts'
import { ENV, identityFromEnv } from './paths.ts'
import { CONTROL_KINDS } from './protocol.ts'
import type { AgentKind, CommandResult, Effort, HookEventName, Role, SeatRole, SendRequest, SpawnRequest } from './types.ts'

type Values = Record<string, string | boolean | undefined>
type Io = { out: (text: string) => void; err: (text: string) => void; stdin: () => Promise<string>; launch?: (plan: commands.ProcessPlan) => Promise<number> }
type Handler = (values: Values, positionals: string[], io: Io) => Promise<number>
type Spec = { usage: string; why: string; options?: ParseArgsConfig['options']; run: Handler }

const str = (values: Values, key: string): string | undefined => (typeof values[key] === 'string' ? (values[key] as string) : undefined)
const need = (value: string | undefined, what: string): string => {
  if (!value) throw new UsageError(`missing ${what}`)
  return value
}

class UsageError extends Error {}

// Globs may hold commas inside braces ({a,b}), so only a comma outside braces separates two of them.
export const splitGlobs = (text: string): string[] => {
  const globs: string[] = ['']
  let depth = 0
  for (const char of text) {
    if (char === ',' && depth === 0) globs.push('')
    else {
      depth = Math.max(0, depth + (char === '{' ? 1 : char === '}' ? -1 : 0))
      globs[globs.length - 1] += char
    }
  }
  return globs.map(glob => glob.trim()).filter(Boolean)
}

const onOff = (values: Values, key: string): boolean | undefined => {
  const value = str(values, key)
  if (value === undefined) return undefined
  if (value !== 'on' && value !== 'off') throw new UsageError(`--${key} must be on or off; got "${value}"`)
  return value === 'on'
}
// An empty value is the empty list ("--mcp ''" keeps Drove's server alone); a flag left out is undefined.
const nameList = (values: Values, key: string): string[] | undefined => str(values, key)?.split(',').map(name => name.trim()).filter(Boolean)
export const spawnRequestOf = (values: Values, positionals: readonly string[], brief: string): SpawnRequest => ({
  seat: need(positionals[0], '<seat>'),
  kind: need(str(values, 'kind'), '--kind') as AgentKind,
  cairn: str(values, 'cairn'),
  brief,
  model: str(values, 'model'),
  effort: str(values, 'effort') as Effort | undefined,
  base: str(values, 'base'),
  mcp: nameList(values, 'mcp'),
  plugins: nameList(values, 'plugins'),
  userMemory: onOff(values, 'user-memory'),
  role: str(values, 'role') as SeatRole | undefined,
  target: str(values, 'target'),
  owns: str(values, 'owns') === undefined ? undefined : splitGlobs(str(values, 'owns') as string),
  maxTurns: count(values, 'max-turns'),
  maxTokens: count(values, 'max-tokens'),
})

const count = (values: Values, key: string): number | undefined => (str(values, key) === undefined ? undefined : Number(str(values, key)))

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const print = (result: CommandResult, io: Io): number => {
  if (result.ok) {
    io.out(result.text)
    return 0
  }
  io.err(`${result.code}: ${result.text}`)
  return 1
}

const launchProcess = (plan: commands.ProcessPlan): Promise<number> =>
  new Promise(resolve => {
    const [command = '', ...args] = plan.argv
    const child = spawn(command, args, { cwd: plan.cwd, env: { ...process.env, ...plan.env }, stdio: 'inherit' })
    process.on('SIGINT', () => child.kill('SIGINT'))
    process.on('SIGTERM', () => child.kill('SIGTERM'))
    child.on('error', error => {
      process.stderr.write(`${error.message}\n`)
      resolve(127)
    })
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })

const printThenLaunch = async (result: CommandResult, io: Io): Promise<number> => {
  const code = print(result, io)
  const plan = result.ok ? (result.data as commands.ProcessPlan | undefined) : undefined
  return plan?.argv ? (io.launch ?? launchProcess)(plan) : code
}

const runRef = (values: Values) => ({ run: str(values, 'run'), repo: process.cwd() })

const textArg = async (positionals: string[], from: number, io: Io): Promise<string> => {
  const text = positionals.slice(from).join(' ')
  return text === '-' ? io.stdin() : need(text, 'text')
}

export const COMMANDS: Record<string, Spec> = {
  plan: {
    usage: 'drove plan [--kind claude|codex] [--model M] [--effort E] [--goal TEXT | --from-cairn REF | --next PROJECT] [--run ID]',
    why: "start a planner in this pane; --from-cairn makes a Cairn task the run's goal, --next picks the top task of a Cairn project",
    options: { kind: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, goal: { type: 'string' }, run: { type: 'string' }, 'from-cairn': { type: 'string' }, next: { type: 'string' } },
    run: async (values, _positionals, io) =>
      printThenLaunch(
        await commands.plan(commands.defaultDeps(), {
          repo: process.cwd(),
          kind: (str(values, 'kind') ?? 'claude') as AgentKind,
          model: str(values, 'model'),
          effort: str(values, 'effort') as Effort | undefined,
          goal: str(values, 'goal'),
          run: str(values, 'run'),
          cairn: str(values, 'from-cairn'),
          next: str(values, 'next'),
        }),
        io,
      ),
  },
  init: {
    usage: 'drove init <dir> [--json]',
    why: 'make a new git repo (main, one empty commit) in an empty or missing directory, for a run that needs one',
    options: { json: { type: 'boolean' } },
    run: async (values, positionals, io) =>
      print(await commands.initRepo(commands.defaultDeps(), need(positionals[0], '<dir>'), process.cwd(), values.json === true), io),
  },
  spawn: {
    usage: 'drove spawn <seat> --kind claude|codex --cairn REF --brief TEXT|- [--model M] [--effort E] [--base BRANCH] [--mcp NAME,NAME] [--plugins NAME,NAME] [--user-memory on|off] [--role implementer|reviewer|tester --target SEAT] [--owns GLOB,GLOB] [--max-turns N] [--max-tokens N]',
    why: 'open a worker in its own worktree and pane, and brief it',
    options: { kind: { type: 'string' }, cairn: { type: 'string' }, brief: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, base: { type: 'string' }, mcp: { type: 'string' }, plugins: { type: 'string' }, 'user-memory': { type: 'string' }, role: { type: 'string' }, target: { type: 'string' }, owns: { type: 'string' }, 'max-turns': { type: 'string' }, 'max-tokens': { type: 'string' } },
    run: async (values, positionals, io) => {
      const brief = need(str(values, 'brief'), '--brief')
      return print(await commands.spawn(commands.defaultDeps(), commands.identityOrPlanner(), spawnRequestOf(values, positionals, brief === '-' ? await io.stdin() : brief)), io)
    },
  },
  send: {
    usage: 'drove send <seat> --kind message|answer|verdict [--verdict approve|changes] [--expects review|answer|none] TEXT|-',
    why: 'send one enveloped control message through the best transport',
    options: { kind: { type: 'string' }, verdict: { type: 'string' }, expects: { type: 'string' } },
    run: async (values, positionals, io) => {
      const kind = str(values, 'kind') ?? 'message'
      if (!CONTROL_KINDS.includes(kind as never) || ['brief', 'promote', 'demote'].includes(kind)) throw new UsageError(`--kind ${kind} is not sendable`)
      return print(
        await commands.send(commands.defaultDeps(), commands.identityOrPlanner(), {
          seat: need(positionals[0], '<seat>'),
          kind: kind as SendRequest['kind'],
          verdict: str(values, 'verdict') as SendRequest['verdict'],
          expects: str(values, 'expects') as SendRequest['expects'],
          body: await textArg(positionals, 1, io),
        }),
        io,
      )
    },
  },
  prompt: {
    usage: 'drove prompt <seat> TEXT|-',
    why: 'raw herdr agent prompt into a seat this run owns (guarded)',
    run: async (_values, positionals, io) =>
      print(await commands.prompt(commands.defaultDeps(), commands.identityOrPlanner(), need(positionals[0], '<seat>'), await textArg(positionals, 1, io)), io),
  },
  promote: {
    usage: 'drove promote <seat> [--model M] --effort E [--reason TEXT]',
    why: "change a worker's model or effort (may restart it with resume)",
    options: { model: { type: 'string' }, effort: { type: 'string' }, reason: { type: 'string' } },
    run: async (values, positionals, io) =>
      print(
        await commands.promote(commands.defaultDeps(), commands.identityOrPlanner(), {
          seat: need(positionals[0], '<seat>'),
          model: str(values, 'model') ?? '',
          effort: need(str(values, 'effort'), '--effort') as Effort,
          reason: str(values, 'reason'),
        }),
        io,
      ),
  },
  migrate: {
    usage: 'drove migrate <seat> --kind claude|codex [--model M] [--effort E] [--reason TEXT]',
    why: 'move a worker to the other agent kind in the same worktree, with a handoff brief',
    options: { kind: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, reason: { type: 'string' } },
    run: async (values, positionals, io) =>
      print(
        await commands.migrate(commands.defaultDeps(), commands.identityOrPlanner(), {
          seat: need(positionals[0], '<seat>'),
          kind: need(str(values, 'kind'), '--kind') as AgentKind,
          model: str(values, 'model'),
          effort: str(values, 'effort') as Effort | undefined,
          reason: str(values, 'reason'),
        }),
        io,
      ),
  },
  roster: {
    usage: 'drove roster [--json] [--run ID]',
    why: 'one line per seat',
    options: { json: { type: 'boolean' }, run: { type: 'string' } },
    run: async (values, _positionals, io) => print(await commands.roster(commands.defaultDeps(), runRef(values), values.json === true), io),
  },
  reports: {
    usage: 'drove reports [<seat>] [--all] [--json] [--run ID]',
    why: "the workers' reports in full, those not yet read (a seat's latest when it has none unread); --all for every report",
    options: { all: { type: 'boolean' }, json: { type: 'boolean' }, run: { type: 'string' } },
    run: async (values, positionals, io) =>
      print(await commands.reports(commands.defaultDeps(), commands.identityOrPlanner(), runRef(values), { seat: positionals[0], all: values.all === true, asJson: values.json === true }), io),
  },
  capture: {
    usage: 'drove capture <seat> [--lines N] [--run ID]',
    why: "read a seat's recent output",
    options: { lines: { type: 'string' }, run: { type: 'string' } },
    run: async (values, positionals, io) =>
      print(await commands.capture(commands.defaultDeps(), runRef(values), need(positionals[0], '<seat>'), Number(str(values, 'lines') ?? 80)), io),
  },
  close: {
    usage: 'drove close <seat> [--remove-worktree]',
    why: 'quit a worker and close its pane',
    options: { 'remove-worktree': { type: 'boolean' } },
    run: async (values, positionals, io) =>
      print(await commands.close(commands.defaultDeps(), commands.identityOrPlanner(), need(positionals[0], '<seat>'), values['remove-worktree'] === true), io),
  },
  merge: {
    usage: 'drove merge <seat> [--pr] [--squash] [-m MSG] [--run ID]',
    why: "integrate a worker's branch behind the repo's checks: local runs them in the seat's worktree then merges --no-ff into the base; --pr pushes, opens a PR, reads its checks and gh pr merges when green (pending returns the PR URL: run it again)",
    options: { pr: { type: 'boolean' }, squash: { type: 'boolean' }, message: { type: 'string', short: 'm' }, 'no-checks': { type: 'boolean' }, run: { type: 'string' } },
    run: async (values, positionals, io) =>
      print(
        await commands.merge(commands.defaultDeps(), commands.identityOrPlanner(), runRef(values), {
          seat: need(positionals[0], '<seat>'),
          pr: values.pr === true,
          squash: values.squash === true,
          message: str(values, 'message'),
          noChecks: values['no-checks'] === true,
        }),
        io,
      ),
  },
  board: {
    usage: 'drove board [--once] [--web [--port N]] [--run ID]',
    why: 'live board for a herdr pane (plain when piped or NO_COLOR), or read-only in a browser with --web',
    options: { once: { type: 'boolean' }, web: { type: 'boolean' }, port: { type: 'string' }, run: { type: 'string' } },
    run: async (values, _positionals, io) => {
      const deps = commands.defaultDeps()
      const located = await commands.boardRun(deps, { run: str(values, 'run') ?? (process.env[ENV.run] || undefined), repo: process.cwd() })
      if ('error' in located) return print(located.error, io)
      if (values.web === true) {
        const port = str(values, 'port') === undefined ? 0 : Number(str(values, 'port'))
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a port number (0 to 65535)')
        await runWeb(deps, located.run, { port, write: text => void process.stdout.write(text) })
        return 0
      }
      if (str(values, 'port') !== undefined) throw new UsageError('--port needs --web')
      await runBoard(deps, located.run, values.once === true)
      return 0
    },
  },
  down: {
    usage: 'drove down [--run ID]',
    why: 'save session ids and stop the run',
    options: { run: { type: 'string' } },
    run: async (values, _positionals, io) => print(await commands.down(commands.defaultDeps(), runRef(values)), io),
  },
  up: {
    usage: 'drove up [--run ID] [--seat SEAT]',
    why: 'resume a stopped run (or one dead seat)',
    options: { run: { type: 'string' }, seat: { type: 'string' } },
    run: async (values, _positionals, io) => printThenLaunch(await commands.up(commands.defaultDeps(), runRef(values), str(values, 'seat')), io),
  },
  budget: {
    usage: 'drove budget <n> [--run ID]',
    why: "raise the pane budget (the human's OK; agents are denied)",
    options: { run: { type: 'string' } },
    run: async (values, positionals, io) => print(await commands.budget(commands.defaultDeps(), runRef(values), Number(need(positionals[0], '<n>'))), io),
  },
  guard: {
    usage: `drove guard <${HOOK_EVENTS.join('|')}>`,
    why: 'hook entry point for Claude and Codex',
    run: async (_values, positionals, io) => {
      const event = need(positionals[0], '<event>')
      if (!HOOK_EVENTS.includes(event as HookEventName)) throw new UsageError(`unknown hook event ${event}`)
      const result = await runHook(event as HookEventName, await io.stdin(), process.env)
      if (result.stdout) io.out(result.stdout)
      if (result.stderr) io.err(result.stderr)
      return result.code
    },
  },
  mcp: {
    usage: 'drove mcp',
    why: 'stdio MCP server; role from DROVE_ROLE',
    run: async () => {
      const role = process.env[ENV.role]
      if (role !== 'planner' && role !== 'worker') throw new UsageError(`${ENV.role} must be planner or worker`)
      await serveMcp(role as Role)
      return 0
    },
  },
  mod: {
    usage: 'drove mod attach --session ID [--pane P] [--goal TEXT] [--model M] [--effort E] [--budget N] [--run ID] | drove mod bridge --run ID --session ID | drove mod report (JSON on stdin)',
    why: "the Claude orchestrator mod's entry points: attach a session as planner, stream wakes and roster, the worker report alias",
    options: { session: { type: 'string' }, pane: { type: 'string' }, goal: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, budget: { type: 'string' }, run: { type: 'string' } },
    run: async (values, positionals, io) => {
      const action = positionals[0]
      const json = (result: CommandResult): number => {
        io.out(JSON.stringify(result))
        return result.ok ? 0 : 1
      }
      if (action === 'attach') {
        const budget = str(values, 'budget')
        return json(
          await modhost.attach(commands.defaultDeps(), {
            repo: process.cwd(),
            sessionId: need(str(values, 'session'), '--session'),
            paneId: str(values, 'pane'),
            goal: str(values, 'goal'),
            model: str(values, 'model'),
            effort: str(values, 'effort') as Effort | undefined,
            budget: budget === undefined ? undefined : Number(budget),
            run: str(values, 'run'),
          }),
        )
      }
      if (action === 'report') return json(await modhost.report(commands.defaultDeps(), identityFromEnv(), JSON.parse((await io.stdin()) || '{}')))
      if (action === 'bridge') {
        const controller = new AbortController()
        process.on('SIGTERM', () => controller.abort())
        process.on('SIGINT', () => controller.abort())
        return modhost.runBridge(commands.defaultDeps(), need(str(values, 'run'), '--run'), { sessionId: need(str(values, 'session'), '--session') }, nodeBridgeIo(), controller.signal)
      }
      throw new UsageError(`unknown mod action ${action ?? '<nothing>'}`)
    },
  },
}

const nodeBridgeIo = (): modhost.BridgeIo => {
  let isBroken = false
  process.stdout.on('error', () => {
    isBroken = true
  })
  return {
    write: line => {
      if (isBroken) return false
      process.stdout.write(`${JSON.stringify(line)}\n`)
      return true
    },
    pid: process.pid,
    ppid: () => process.ppid,
    isAlive: isPidAlive,
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal)
      } catch {
        // already gone
      }
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
}

export const usage = (): string =>
  ['Usage: drove <command> [options]', '', ...Object.values(COMMANDS).map(spec => `  ${spec.usage}\n      ${spec.why}`)].join('\n')

const defaultIo: Io = {
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`),
  stdin: readStdin,
}

export const main = async (argv: readonly string[], io: Io = defaultIo): Promise<number> => {
  const [name, ...rest] = argv
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    io.out(usage())
    return 0
  }
  const spec = COMMANDS[name]
  if (!spec) {
    io.err(`unknown command ${name}\n\n${usage()}`)
    return 2
  }
  try {
    const { values, positionals } = parseArgs({ args: [...rest], options: spec.options ?? {}, allowPositionals: true, strict: true })
    return await spec.run(values as Values, positionals, io)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err(`${message}\n\n${spec.usage}`)
      return 2
    }
    io.err(message)
    return message.startsWith('not implemented') ? 70 : 1
  }
}

const isEntry = (): boolean => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntry()) process.exitCode = await main(process.argv.slice(2))
