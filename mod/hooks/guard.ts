import { baseName, parseShell, unwrap } from './shell'

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const HARMLESS_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])

const FILE_WRITERS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'chgrp', 'ln', 'tee', 'dd', 'truncate',
  'install', 'rsync', 'scp', 'patch', 'unzip', 'shred', 'kill', 'pkill', 'killall', 'launchctl', 'crontab',
])

const RUNTIMES = new Set([
  'node', 'deno', 'python', 'python3', 'ruby', 'php', 'perl', 'tsx', 'ts-node', 'bash', 'sh', 'zsh', 'fish',
  'jest', 'vitest', 'pytest', 'playwright', 'mocha', 'tsc', 'eslint', 'prettier', 'biome', 'osascript',
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

const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

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

const DELEGATE = 'Delegate it to a worker (mcp__orchestrator__spawn_worker or message_worker).'

const firstPositional = (words: readonly string[], from: number, withValue: ReadonlySet<string> = new Set()): number => {
  let i = from
  while (i < words.length) {
    const word = words[i] ?? ''
    if (!word.startsWith('-')) return i
    i += withValue.has(word) ? 2 : 1
  }
  return i
}

const ghReason = (words: readonly string[]): string | undefined => {
  const [, group = '', action = ''] = words
  if (GH_WRITES[group]?.has(action)) return `gh ${group} ${action} changes GitHub`
  if (group === 'api' && words.some((word, i) => (/^-X$|^--method$/.test(words[i - 1] ?? '') && !/^get$/i.test(word)) || /^-(f|F)$|^--(field|raw-field|input)$/.test(word))) {
    return 'gh api with a method or fields writes to GitHub'
  }
  return undefined
}

const herdrReason = (words: readonly string[]): string | undefined => {
  const [, group = '', action = ''] = words
  return HERDR_WRITES[group]?.has(action) ? `herdr ${group} ${action} changes panes or agents: use the orchestrator tools, which keep the roster and the 5-pane budget` : undefined
}

const curlReason = (head: string, words: readonly string[]): string | undefined => {
  if (head === 'wget') return words.some(word => word === '-O-' || word === '-qO-' || word === '-O' && words[words.indexOf(word) + 1] === '-') ? undefined : 'wget writes a file'
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

const segmentReason = (input: readonly string[]): string | undefined => {
  const { words } = unwrap(input)
  const first = words[0]
  if (first === undefined) return undefined
  const head = baseName(first)
  if (/^\.{1,2}\//.test(first)) return `running ${first} executes a script`
  if (FILE_WRITERS.has(head)) return `${head} changes files or processes`
  if ((head === 'sed' || head === 'perl') && words.some(word => /^-[a-zA-Z]*i/.test(word) || word.startsWith('--in-place'))) return `${head} -i edits files in place`
  if (head === 'perl' || RUNTIMES.has(head)) return `${head} runs code`
  if (head === 'gh') return ghReason(words)
  if (head === 'herdr') return herdrReason(words)
  if (head === 'curl' || head === 'wget') return curlReason(head, words)
  if (head === 'claude') return 'starting another Claude session: use spawn_worker'
  if (PACKAGE_TOOLS.has(head)) return packageReason(head, words)
  return undefined
}

export const isInside = (path: string, roots: readonly string[]): boolean =>
  roots.some(root => {
    const base = root.endsWith('/') ? root : `${root}/`
    return path === root || path.startsWith(base)
  })

const substitutions = (command: string): string[] =>
  [...command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map(match => match[1] ?? match[2] ?? '').filter(Boolean)

export const bashReason = (command: string, writableRoots: readonly string[] = [], depth = 0): string | undefined => {
  if (depth > 3) return undefined
  for (const pipeline of parseShell(command)) {
    for (const segment of pipeline) {
      const target = segment.stdoutFile
      if (target !== undefined && !HARMLESS_TARGETS.has(target) && !isInside(target, writableRoots)) return `redirecting output into ${target} writes a file`
      const reason = segmentReason(segment.words)
      if (reason) return reason
    }
  }
  for (const inner of substitutions(command)) {
    const reason = bashReason(inner, writableRoots, depth + 1)
    if (reason) return reason
  }
  return undefined
}

export const editPathOf = (input: Record<string, unknown>): string | undefined => {
  const path = input.file_path ?? input.notebook_path ?? input.path
  return typeof path === 'string' ? path : undefined
}

export const orchestratorDeny = (what: string): string =>
  `Orchestrator mode: ${what}. You plan, delegate and review; you never change code or run scripts yourself. ${DELEGATE} (Cal can leave the mode with /orchestrate off.)`

export const WORKER_FORBIDDEN = (command: string): string | undefined => {
  for (const pipeline of parseShell(command)) {
    for (const segment of pipeline) {
      const { words } = unwrap(segment.words)
      const head = baseName(words[0] ?? '')
      if (head === 'git' && words[firstPositional(words, 1, GIT_OPTIONS_WITH_VALUE)] === 'push') return 'workers never push; report done and let the orchestrator and Cal decide'
      if (head === 'herdr' && herdrReason(words)) return 'workers do not open or drive panes; ask the orchestrator with mcp__orchestrator__report'
      if (head === 'claude') return 'workers do not start other Claude sessions; ask the orchestrator with mcp__orchestrator__report'
    }
  }
  return undefined
}
