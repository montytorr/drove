import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { baseName, parseShell, unwrap } from './shell.ts'
import type { Segment } from './shell.ts'
import type { GuardDecision, GuardInput, Role } from './types.ts'

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'shell', 'exec_command'])

type Context = Pick<GuardInput, 'writableRoots' | 'openSeats'> & { cwd?: string }
type Scope = { role: Role; roots: readonly string[]; seats: readonly string[]; cwd: string }

const MAX_NESTING = 6
const HARMLESS_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const HELP_FLAGS = new Set(['--help', '-h', '--version', '-V', '-v'])
const PUSH_FLAGS_WITH_VALUE = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
const PUSH_FLAGS_FOR_ALL = new Set(['--all', '--mirror'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const HERDR_OPTIONS_WITH_VALUE = new Set(['--timeout', '-t'])
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])

const FILE_WRITERS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'chgrp', 'ln', 'tee', 'dd', 'truncate',
  'install', 'rsync', 'scp', 'patch', 'unzip', 'shred', 'kill', 'pkill', 'killall', 'launchctl', 'crontab',
])

const RUNTIMES = new Set([
  'node', 'deno', 'python', 'python3', 'ruby', 'php', 'perl', 'tsx', 'ts-node', 'bash', 'sh', 'zsh', 'fish',
  'jest', 'vitest', 'pytest', 'playwright', 'mocha', 'tsc', 'eslint', 'prettier', 'biome', 'osascript',
  'eval', 'source', '.', 'dash', 'ksh',
])

const READ_ONLY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set(['ls', 'list', 'view', 'info', 'show', 'outdated', 'why', 'explain', 'search', 'help', 'audit', 'config', 'root', 'prefix', 'bin']),
  pnpm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'why', 'help', 'audit', 'root']),
  yarn: new Set(['list', 'info', 'why', 'outdated', 'help', 'audit']),
  bun: new Set(['pm']),
  brew: new Set(['list', 'ls', 'info', 'search', 'outdated', 'deps', 'uses', 'config', 'doctor', 'leaves']),
  cargo: new Set(['tree', 'metadata', 'search', 'version', 'help']),
  go: new Set(['list', 'env', 'version', 'doc', 'help']),
  pip: new Set(['list', 'show', 'freeze', 'check', 'help', 'index']),
  pip3: new Set(['list', 'show', 'freeze', 'check', 'help', 'index']),
  uv: new Set(['tree', 'help', 'version']),
  docker: new Set(['ps', 'logs', 'images', 'inspect', 'version', 'info', 'stats', 'top', 'port', 'diff', 'history']),
  kubectl: new Set(['get', 'describe', 'logs', 'top', 'explain', 'version', 'config', 'api-resources']),
  make: new Set(['-n', '--dry-run', '--just-print']),
}
const PACKAGE_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'brew', 'cargo', 'go', 'pip', 'pip3', 'uv', 'poetry', 'gem', 'bundle', 'composer', 'gradle', 'mvn', 'docker', 'docker-compose', 'kubectl', 'make', 'npx', 'pnpx', 'bunx'])

const GH_WRITES: Record<string, ReadonlySet<string>> = {
  pr: new Set(['create', 'merge', 'close', 'reopen', 'edit', 'comment', 'review', 'ready', 'checkout', 'lock', 'unlock', 'update-branch']),
  issue: new Set(['create', 'close', 'reopen', 'edit', 'comment', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin']),
  release: new Set(['create', 'delete', 'edit', 'upload']),
  repo: new Set(['create', 'delete', 'edit', 'fork', 'rename', 'archive', 'clone', 'sync']),
  workflow: new Set(['run', 'enable', 'disable']),
  run: new Set(['rerun', 'cancel', 'delete']),
  secret: new Set(['set', 'delete']),
  variable: new Set(['set', 'delete']),
}

const HERDR_WRITES: Record<string, ReadonlySet<string>> = {
  pane: new Set(['split', 'close', 'send-text', 'send-keys', 'run', 'move', 'resize', 'zoom']),
  agent: new Set(['start', 'prompt', 'send-keys', 'release', 'rename']),
  workspace: new Set(['create', 'close', 'rename', 'delete']),
  tab: new Set(['create', 'close', 'rename']),
  worktree: new Set(['create', 'add', 'remove']),
  server: new Set(['stop', 'restart']),
}

const PLANNER_DROVE = new Set(['spawn', 'send', 'prompt', 'promote', 'roster', 'capture', 'close', 'down'])
const WORKER_DROVE = new Set(['roster', 'capture'])

const WORKER_PUSH = 'workers never push; report done and let the planner and the human decide'

export const denyText = (role: Role, reason: string): string =>
  role === 'planner'
    ? `Drove planner: ${reason}. You plan, delegate and review; you never change code or run scripts yourself. Delegate it to a worker with the drove spawn or send tools. (The human can leave planner mode by starting a plain session.)`
    : `Drove worker: ${reason}.`

const expandHome = (path: string): string => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path)

const canonical = (path: string, cwd: string): string => {
  const absolute = resolve(cwd, expandHome(path))
  const tail: string[] = []
  let probe = absolute
  for (;;) {
    try {
      return join(realpathSync(probe), ...tail.reverse())
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return absolute
      tail.push(basename(probe))
      probe = parent
    }
  }
}

export const isInside = (path: string, roots: readonly string[], cwd: string = process.cwd()): boolean => {
  const target = canonical(path, cwd)
  return roots.some(root => {
    const base = canonical(root, cwd)
    return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`)
  })
}

const firstPositional = (words: readonly string[], from: number, withValue: ReadonlySet<string> = new Set()): number => {
  let i = from
  while (i < words.length) {
    const word = words[i] ?? ''
    if (!word.startsWith('-')) return i
    i += withValue.has(word) ? 2 : 1
  }
  return i
}

const isHelpOrVersion = (words: readonly string[]): boolean => {
  const at = words.findIndex((word, i) => i > 0 && HELP_FLAGS.has(word))
  return at > 0 && words.slice(1, at).every(word => !word.startsWith('-'))
}

const optionValue = (words: readonly string[], name: string): string | undefined => {
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? ''
    if (word === name) return words[i + 1]
    if (word.startsWith(`${name}=`)) return word.slice(name.length + 1)
  }
  return undefined
}

const gitDir = (start: string): string | undefined => {
  let dir = start
  for (;;) {
    const dotGit = join(dir, '.git')
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]
      return pointer ? resolve(dir, pointer.trim()) : undefined
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const currentBranch = (dir: string): string | undefined => {
  try {
    const head = gitDir(dir)
    return head ? /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(head, 'HEAD'), 'utf8'))?.[1]?.trim() : undefined
  } catch {
    return undefined
  }
}

const pushesProduction = (words: readonly string[], pushAt: number, cwd: string): boolean => {
  const dir = resolve(cwd, optionValue(words, '-C') ?? '.')
  const positionals: string[] = []
  for (let i = pushAt + 1; i < words.length; i += 1) {
    const word = words[i] ?? ''
    if (!word.startsWith('-')) positionals.push(word)
    else if (PUSH_FLAGS_WITH_VALUE.has(word)) i += 1
  }
  const refspecs = positionals.slice(1)
  if (refspecs.length === 0) return currentBranch(dir) === 'production'
  return refspecs.some(spec => {
    const destination = (spec.replace(/^\+/, '').split(':').pop() ?? '').replace(/^refs\/heads\//, '')
    return (destination === 'HEAD' ? currentBranch(dir) : destination) === 'production'
  })
}

const gitReason = (words: readonly string[], scope: Scope): string | undefined => {
  const at = firstPositional(words, 1, GIT_OPTIONS_WITH_VALUE)
  if (words[at] !== 'push') return undefined
  if (scope.role === 'worker') return WORKER_PUSH
  if (words.some(word => PUSH_FLAGS_FOR_ALL.has(word))) return 'git push --all or --mirror would also push production, which nobody pushes to'
  return pushesProduction(words, at, scope.cwd) ? 'nobody pushes to the production branch: push main (or master) instead' : undefined
}

const ghReason = (words: readonly string[]): string | undefined => {
  const [, group = '', action = ''] = words
  if (GH_WRITES[group]?.has(action)) return `gh ${group} ${action} changes GitHub`
  if (group === 'api' && words.some((word, i) => (/^-X$|^--method$/.test(words[i - 1] ?? '') && !/^get$/i.test(word)) || /^-(f|F)$|^--(field|raw-field|input)$/.test(word))) {
    return 'gh api with a method or fields writes to GitHub'
  }
  return undefined
}

const herdrReason = (words: readonly string[], scope: Scope): string | undefined => {
  const group = words[firstPositional(words, 1)] ?? ''
  const actionAt = firstPositional(words, words.indexOf(group) + 1)
  const action = words[actionAt] ?? ''
  if (!HERDR_WRITES[group]?.has(action)) return undefined
  if (scope.role === 'worker') return 'workers do not open or drive panes; ask the planner with the drove report tool'
  if (group === 'agent' && action === 'prompt') {
    const seat = words[firstPositional(words, actionAt + 1, HERDR_OPTIONS_WITH_VALUE)] ?? ''
    return scope.seats.includes(seat) ? undefined : `herdr agent prompt ${seat || '<nothing>'}: that is not an open seat of this run (use drove send)`
  }
  return `herdr ${group} ${action} changes panes or agents: use the drove tools, which keep the roster and the pane budget`
}

const isPluginTest = (words: readonly string[]): boolean =>
  words[1] === 'plugin' && words[2] === 'test' && words.length <= 4 && !(words[3] ?? '').startsWith('-')

const sessionReason = (head: 'claude' | 'codex', words: readonly string[], scope: Scope): string | undefined => {
  if (isHelpOrVersion(words)) return undefined
  if (head === 'claude' && scope.role === 'worker' && isPluginTest(words)) return undefined
  if (head === 'codex' && scope.role === 'planner' && words[1] === 'queue') {
    const thread = optionValue(words, '--thread')
    return thread !== undefined && scope.seats.includes(thread) ? undefined : `codex queue to ${thread ?? '<no thread>'}: that is not an open seat of this run`
  }
  return scope.role === 'worker'
    ? `workers do not start other ${head} sessions; ask the planner with the drove report tool`
    : `starting another ${head} session: use drove spawn`
}

const droveReason = (words: readonly string[], scope: Scope): string | undefined => {
  const at = firstPositional(words, 1)
  const sub = words[at] ?? ''
  const allowed = scope.role === 'planner' ? PLANNER_DROVE : WORKER_DROVE
  const isBoardOnce = scope.role === 'planner' && sub === 'board' && words.includes('--once')
  if (allowed.has(sub) || isBoardOnce) return undefined
  return `drove ${sub || '<nothing>'} is not available to a ${scope.role}${sub === 'budget' ? ': ask the human to run it' : ''}`
}

const curlReason = (head: string, words: readonly string[]): string | undefined => {
  if (head === 'wget') return words.some((word, i) => word === '-O-' || word === '-qO-' || (word === '-O' && words[i + 1] === '-')) ? undefined : 'wget writes a file'
  const writes = words.some((word, i) =>
    /^-(d|F|T)$|^--(data|data-raw|data-binary|data-urlencode|form|upload-file|json)$/.test(word) ||
    /^--data/.test(word) ||
    (/^-X$|^--request$/.test(words[i - 1] ?? '') && !/^(get|head)$/i.test(word)) ||
    /^-(o|O)$|^--(output|remote-name)$/.test(word),
  )
  return writes ? 'curl that sends data or saves a file' : undefined
}

const packageReason = (head: string, words: readonly string[]): string | undefined => {
  const allowed = READ_ONLY_SUBCOMMANDS[head]
  const sub = words[head === 'make' ? 1 : firstPositional(words, 1)] ?? ''
  if (allowed?.has(sub) || (head === 'make' && words.slice(1).some(word => allowed?.has(word)))) return undefined
  return `${head}${sub ? ` ${sub}` : ''} installs, builds or runs code (your CLAUDE.md: ask before running a script)`
}

const patchPaths = (text: string): string[] =>
  [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)].map(match => match[1] ?? '')

const patchReason = (text: string, scope: Scope): string | undefined => {
  const paths = patchPaths(text)
  const outside = paths.find(path => !isInside(path, scope.roots, scope.cwd))
  if (paths.length === 0) return 'apply_patch changes files and no path could be read from it'
  return outside === undefined ? undefined : `apply_patch on ${outside} changes code`
}

const redirectReason = (target: string, scope: Scope): string | undefined => {
  if (HARMLESS_TARGETS.has(target)) return undefined
  if (/[$`]/.test(target)) return `redirecting output into ${target} writes to a path that cannot be checked`
  return isInside(target, scope.roots, scope.cwd) ? undefined : `redirecting output into ${target} writes a file`
}

const plannerReason = (words: readonly string[], scope: Scope): string | undefined => {
  const first = words[0]
  if (first === undefined) return undefined
  const head = baseName(first)
  if (first.startsWith('$')) return 'the command name comes from a variable or a substitution, which cannot be checked'
  if (/^(\.{1,2}|~)\//.test(first) || (first.includes('/') && isInside(first, scope.roots, scope.cwd))) return `running ${first} executes a script`
  if (FILE_WRITERS.has(head)) return `${head} changes files or processes`
  if ((head === 'sed' || head === 'perl') && words.some(word => /^-[a-zA-Z]*i/.test(word) || word.startsWith('--in-place'))) return `${head} -i edits files in place`
  if (head === 'find' && words.some(word => FIND_ACTIONS.has(word))) return 'find with an action runs commands or deletes files'
  if (head === 'perl' || RUNTIMES.has(head)) return `${head} runs code`
  if (head === 'gh') return ghReason(words)
  if (head === 'curl' || head === 'wget') return curlReason(head, words)
  if (PACKAGE_TOOLS.has(head)) return packageReason(head, words)
  return undefined
}

const segmentReason = (segment: Segment, scope: Scope): string | undefined => {
  if (scope.role === 'planner' && segment.stdoutFile !== undefined) {
    const reason = redirectReason(segment.stdoutFile, scope)
    if (reason) return reason
  }
  const { words } = unwrap(segment.words)
  const first = words[0]
  if (first === undefined) return undefined
  const head = baseName(first)
  if (head === 'apply_patch' && scope.role === 'planner') return patchReason(segment.stdin.join('\n'), scope)
  if (head === 'git') return gitReason(words, scope)
  if (head === 'herdr') return herdrReason(words, scope)
  if (head === 'claude' || head === 'codex') return sessionReason(head, words, scope)
  if (head === 'drove') return droveReason(words, scope)
  return scope.role === 'planner' ? plannerReason(words, scope) : undefined
}

const commandReason = (command: string, scope: Scope, depth: number): string | undefined => {
  if (depth > MAX_NESTING) return scope.role === 'planner' ? 'the command nests substitutions too deeply to check' : undefined
  for (const pipeline of parseShell(command)) {
    for (const segment of pipeline) {
      const reason = segmentReason(segment, scope)
      if (reason) return reason
      for (const inner of segment.substitutions) {
        const innerReason = commandReason(inner, scope, depth + 1)
        if (innerReason) return innerReason
      }
    }
  }
  return undefined
}

export const bashReason = (command: string, role: Role, context: Context): string | undefined =>
  commandReason(command, { role, roots: context.writableRoots, seats: context.openSeats, cwd: context.cwd ?? process.cwd() }, 0)

const quoteWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)

export const commandOf = (input: Record<string, unknown>): string | undefined => {
  const raw = input.command ?? input.cmd
  if (typeof raw === 'string') return raw
  if (!Array.isArray(raw) || !raw.every(word => typeof word === 'string')) return undefined
  const argv = raw as string[]
  if (SHELLS.has(baseName(argv[0] ?? ''))) {
    const flag = argv.findIndex((word, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(word))
    if (flag > 0 && typeof argv[flag + 1] === 'string') return argv[flag + 1]
  }
  return argv.map(quoteWord).join(' ')
}

export const editPathsOf = (tool: string, input: Record<string, unknown>): string[] => {
  const direct = input.file_path ?? input.notebook_path ?? input.path
  if (typeof direct === 'string') return [direct]
  if (tool !== 'apply_patch') return []
  const chunks = [input.patch, input.input, input.command, input.cmd].flatMap(value => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(item => typeof item === 'string') : []))
  return patchPaths(chunks.join('\n'))
}

const ALLOW: GuardDecision = { allow: true }

const denied = (role: Role, reason: string): GuardDecision => ({ allow: false, reason: denyText(role, reason) })

const workdirOf = (input: GuardInput): string => (typeof input.input.workdir === 'string' ? resolve(input.cwd, input.input.workdir) : input.cwd)

export const decide = (input: GuardInput): GuardDecision => {
  const { role, tool } = input
  if (EDIT_TOOLS.has(tool)) {
    if (role === 'worker') return ALLOW
    const paths = editPathsOf(tool, input.input)
    if (paths.length === 0) return denied(role, `${tool} changes code and no path could be read from it`)
    const outside = paths.find(path => !isInside(path, input.writableRoots, input.cwd))
    return outside === undefined ? ALLOW : denied(role, `${tool} on ${outside} changes code`)
  }
  if (!SHELL_TOOLS.has(tool)) return ALLOW
  const command = commandOf(input.input)
  if (command === undefined) return role === 'planner' ? denied(role, 'there is no command text to check') : ALLOW
  const reason = bashReason(command, role, { writableRoots: input.writableRoots, openSeats: input.openSeats, cwd: workdirOf(input) })
  return reason ? denied(role, reason) : ALLOW
}
