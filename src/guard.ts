import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { baseName, parseShell, unwrap } from './shell.ts'
import type { Segment } from './shell.ts'
import type { GuardDecision, GuardInput, Role } from './types.ts'

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'shell', 'exec_command'])

type Context = Pick<GuardInput, 'writableRoots' | 'openSeats' | 'owns'> & { cwd?: string; readOnly?: boolean }
// readOnly is a reviewer seat (DROVE-91): a worker whose Bash gets the planner's rules, with the repo's checks allowed.
type Scope = { role: Role; roots: readonly string[]; seats: readonly string[]; cwd: string; owns?: readonly string[]; readOnly?: boolean }

const MAX_NESTING = 6
const HARMLESS_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const HELP_FLAGS = new Set(['--help', '-h', '--version', '-V', '-v'])
const PUSH_FLAGS_WITH_VALUE = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
const PUSH_FLAGS_FOR_ALL = new Set(['--all', '--mirror'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const MERGE_FLAGS_WITH_VALUE = new Set(['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--into-name', '--cleanup'])
const SEAT_BRANCH = /^(?:worktree-|drove\/)(.+)$/
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

// What `gh` may change for the planner, and what stays with the human because it deletes, publishes or reconfigures.
const GH_PLANNER_WRITES: Record<string, ReadonlySet<string>> = {
  pr: new Set(['create', 'merge', 'close', 'reopen', 'edit', 'comment', 'review', 'ready', 'checkout', 'lock', 'unlock', 'update-branch']),
  issue: new Set(['create', 'close', 'reopen', 'edit', 'comment', 'lock', 'unlock', 'pin', 'unpin']),
  release: new Set(['create', 'edit', 'upload']),
  repo: new Set(['create', 'fork', 'clone', 'sync']),
  workflow: new Set(['run', 'enable', 'disable']),
  run: new Set(['rerun', 'cancel']),
  label: new Set(['create', 'edit', 'clone']),
}

const GH_HUMAN_ONLY: Record<string, ReadonlySet<string>> = {
  issue: new Set(['delete', 'transfer']),
  release: new Set(['delete', 'delete-asset']),
  run: new Set(['delete']),
  repo: new Set(['delete', 'rename', 'archive', 'unarchive', 'edit']),
  label: new Set(['delete']),
  secret: new Set(['set', 'delete', 'remove']),
  variable: new Set(['set', 'delete', 'remove']),
}

// What a reviewer may ask GitHub (DROVE-91): reads only, whatever the planner is allowed to write above.
const GH_READS: Record<string, ReadonlySet<string>> = {
  pr: new Set(['view', 'list', 'diff', 'checks', 'status']),
  issue: new Set(['view', 'list', 'status']),
  release: new Set(['view', 'list']),
  run: new Set(['view', 'list']),
  workflow: new Set(['view', 'list']),
  repo: new Set(['view', 'list']),
  label: new Set(['list']),
  auth: new Set(['status']),
}
const GH_READ_GROUPS = new Set(['search', 'status', 'help', 'version'])

const GH_OPTIONS_WITH_VALUE = new Set(['-R', '--repo', '--hostname'])
const GH_BRANCH_OPTIONS = new Set(['--base', '-B', '--target', '--ref', '-r', '--head', '-H'])

const HERDR_WRITES: Record<string, ReadonlySet<string>> = {
  pane: new Set(['split', 'close', 'send-text', 'send-keys', 'run', 'move', 'resize', 'zoom']),
  agent: new Set(['start', 'prompt', 'send-keys', 'release', 'rename']),
  workspace: new Set(['create', 'close', 'rename', 'delete']),
  tab: new Set(['create', 'close', 'rename']),
  worktree: new Set(['create', 'add', 'remove']),
  server: new Set(['stop', 'restart']),
}

const PLANNER_DROVE = new Set(['init', 'spawn', 'send', 'prompt', 'promote', 'merge', 'roster', 'capture', 'close', 'down'])
const WORKER_DROVE = new Set(['roster', 'capture'])

const WORKER_PUSH = 'workers never push; report done and let the planner and the human decide'

// What a reviewer may run besides reading (DROVE-91): the repo's test, lint and typecheck scripts and the usual checkers,
// without their flags that rewrite files. Like the rest of this guard it reads arguments and is not a sandbox: a test
// still runs the repo's code.
const CHECK_SCRIPT = /^(?:test|tests|lint|typecheck|type-check|check|tsc)(?::[\w-]+)*$/
const CHECK_SCRIPT_WRITES = /(?:^|:)(?:fix|write|format|update|snapshot|clean)(?::|$)/
const CHECK_WRITE_FLAG = /^(?:--fix(?:-.+)?|--write|--apply(?:-unsafe)?|-u|--update(?:-snapshots?)?|--updateSnapshot|--output(?:=.*)?|-o)$/
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_EXECUTORS = new Set(['npx', 'pnpx', 'bunx'])
const CHECKERS = new Set(['eslint', 'jest', 'vitest', 'mocha', 'pytest', 'ruff'])
const CARGO_CHECKS = new Set(['test', 'check', 'clippy'])
const GO_CHECKS = new Set(['test', 'vet'])
const TMP_ROOTS = ['/tmp', '/private/tmp', tmpdir()]

// Reading git, for a reviewer: the history and the diffs of the work under review, never a command that moves HEAD or a ref.
const GIT_READ_ONLY = new Set([
  'diff', 'log', 'show', 'status', 'blame', 'grep', 'ls-files', 'ls-tree', 'cat-file', 'rev-parse', 'rev-list', 'merge-base', 'shortlog',
  'describe', 'show-ref', 'for-each-ref', 'name-rev', 'diff-tree', 'diff-files', 'diff-index', 'whatchanged', 'cherry', 'range-diff',
  'check-attr', 'check-ignore', 'count-objects', 'version', 'help', 'var', 'verify-commit', 'verify-tag',
])
const GIT_LISTING: Record<string, ReadonlySet<string>> = {
  remote: new Set(['-v', '--verbose', 'show', 'get-url']),
  worktree: new Set(['list']),
  stash: new Set(['list', 'show']),
  config: new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']),
  submodule: new Set(['status']),
  reflog: new Set(['show']),
}
// branch and tag list with no argument and write with a flag or a name; -a lists for a branch and annotates for a tag.
const GIT_REF_WRITE_FLAG: Record<string, RegExp> = {
  branch: /^(?:-[a-zA-Z]*[dDmMcCfu]|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))/,
  tag: /^(?:-[a-zA-Z]*[dasSufFme]|--(?:delete|annotate|sign|local-user|force|file|message|edit))/,
}

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

// A worker's owns globs are relative to its worktree: `*` stays inside one directory, `**` crosses them, `{a,b}` alternates,
// and a glob that names a directory owns everything under it. Writes outside the worktree are refused, except scratch
// space (the temp directories and Claude's per-project memory), which is not project files.
const CLAUDE_MEMORY = '.claude/projects/*/memory/**'
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g

const globToRegExp = (glob: string): RegExp => {
  let source = ''
  let depth = 0
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] ?? ''
    if (char === '*') {
      if (glob[i + 1] !== '*') source += '[^/]*'
      else if (glob[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (char === '?') source += '[^/]'
    else if (char === '{') {
      depth += 1
      source += '(?:'
    } else if (char === '}' && depth > 0) {
      depth -= 1
      source += ')'
    } else if (char === ',' && depth > 0) source += '|'
    else source += char.replace(REGEXP_SPECIALS, '\\$&')
  }
  return depth > 0 ? new RegExp(`^${glob.replace(REGEXP_SPECIALS, '\\$&')}$`) : new RegExp(`^${source}$`)
}

const matchesGlob = (path: string, glob: string): boolean => globToRegExp(glob.replace(/^\.\//, '')).test(path)

const worktreeRoot = (start: string): string => {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

const isScratch = (target: string): boolean =>
  isInside(target, ['/tmp', '/private/tmp', tmpdir()], '/') || matchesGlob(relative(homedir(), target), CLAUDE_MEMORY)

export const isOwned = (path: string, owns: readonly string[], cwd: string): boolean => {
  const target = canonical(path, cwd)
  const relation = relative(canonical(worktreeRoot(cwd), cwd), target)
  if (relation === '') return false
  if (relation === '..' || relation.startsWith('../')) return isScratch(target)
  const parts = relation.split('/')
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
  return owns.some(glob => candidates.some(candidate => matchesGlob(candidate, glob)))
}

// A Claude Code session scratchpad: <tmp>/claude-<uid>/<project>/<session>/scratchpad. The planner may write there
// and nowhere else in the temp directories; a glob or variable before the scratchpad segment is not a path we can trust.
const SCRATCHPAD = /^claude-[^/*?[\]{}$`]+\/(?:[^/*?[\]{}$`]+\/)*scratchpad(?:\/|$)/

export const isPlannerScratchpad = (path: string, cwd: string): boolean => {
  if (/[$`]/.test(path)) return false
  const target = canonical(path, cwd)
  return [...new Set(['/tmp', '/private/tmp', tmpdir()])].some(base => {
    const root = canonical(base, '/')
    return target.startsWith(`${root}/`) && SCRATCHPAD.test(target.slice(root.length + 1))
  })
}

const SCRATCHPAD_WRITERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'tee'])

const ownsText = (path: string, owns: readonly string[]): string =>
  `${path}: this file is outside the paths your brief gives you (${owns.join(', ')}); ask the planner with the drove report tool`

// A path with a variable or a substitution cannot be resolved, so only literal paths are checked.
const ownsReason = (path: string, scope: Scope): string | undefined => {
  if (scope.owns === undefined || HARMLESS_TARGETS.has(path) || /[$`]/.test(path)) return undefined
  return isOwned(path, scope.owns, scope.cwd) ? undefined : ownsText(path, scope.owns)
}

const OPTIONS_WITH_VALUE: Record<string, ReadonlySet<string>> = {
  cp: new Set(['-t', '--target-directory', '-S', '--suffix']),
  mv: new Set(['-t', '--target-directory', '-S', '--suffix']),
  install: new Set(['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group']),
  ln: new Set(['-t', '--target-directory', '-S', '--suffix']),
  mkdir: new Set(['-m', '--mode']),
  touch: new Set(['-d', '--date', '-t', '-r', '--reference']),
  truncate: new Set(['-s', '--size', '-r', '--reference']),
  sed: new Set(['-e', '--expression', '-f', '--file', '-l', '--line-length']),
  perl: new Set(['-e', '-E', '-I', '-M', '-m', '-F', '-l']),
}

const positionalsOf = (words: readonly string[], withValue: ReadonlySet<string> = new Set()): string[] => {
  const found: string[] = []
  let isRest = false
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? ''
    if (isRest || word === '-' || !word.startsWith('-')) found.push(word)
    else if (word === '--') isRest = true
    else if (withValue.has(word)) i += 1
  }
  return found
}

const isInPlaceEdit = (head: string, words: readonly string[]): boolean =>
  (head === 'sed' || head === 'perl') && words.some(word => /^-[a-zA-Z]*i/.test(word) || word.startsWith('--in-place'))

// The paths a file-writing command changes, where its arguments say so. Anything more indirect (a script, an interpreter,
// a checkout) is not parsed, so this is a seatbelt against mistakes and not a sandbox.
const writeTargets = (head: string, words: readonly string[]): string[] => {
  const withValue = OPTIONS_WITH_VALUE[head]
  if (head === 'rm' || head === 'rmdir' || head === 'touch' || head === 'tee' || head === 'mkdir' || head === 'truncate') return positionalsOf(words, withValue)
  if (head === 'chmod' || head === 'chown' || head === 'chgrp') return positionalsOf(words).slice(1)
  if (head === 'dd') return words.filter(word => word.startsWith('of=')).map(word => word.slice(3))
  if (head === 'mv' || head === 'cp' || head === 'install' || head === 'ln') {
    const directory = optionValue(words, '-t') ?? optionValue(words, '--target-directory')
    const positionals = positionalsOf(words, withValue)
    if (head === 'mv') return [...positionals, ...(directory ? [directory] : [])]
    return directory ? [directory] : positionals.slice(-1)
  }
  if (isInPlaceEdit(head, words)) {
    const files = positionalsOf(words, withValue).filter(Boolean)
    const hasScript = head === 'perl' || words.some(word => /^(-e|-f|--expression|--file)(=|$)/.test(word))
    return hasScript ? files : files.slice(1)
  }
  return []
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

// The seat a revision names, whatever the spelling: worktree-w-x, drove/w-x, origin/worktree-w-x, refs/heads/drove/w-x~2.
// Every seat branch Drove makes has one of the two prefixes, so the roster itself need not be read. A seat's branch is never
// merged by hand: the gate that runs its checks cannot be skipped.
const seatOfRevision = (revision: string): string | undefined => {
  const name = revision.replace(/^refs\/(?:heads|remotes\/[^/]+)\//, '').replace(/[~^@:].*$/, '')
  const unremoted = name.includes('/') && !name.startsWith('drove/') ? name.slice(name.indexOf('/') + 1) : name
  for (const candidate of [name, unremoted]) {
    const seat = SEAT_BRANCH.exec(candidate)?.[1]
    if (seat) return seat
  }
  return undefined
}

const mergeReason = (words: readonly string[], mergeAt: number): string | undefined => {
  for (let i = mergeAt + 1; i < words.length; i += 1) {
    const word = words[i] ?? ''
    if (MERGE_FLAGS_WITH_VALUE.has(word)) i += 1
    else if (!word.startsWith('-')) {
      const seat = seatOfRevision(word)
      if (seat) return `git merge ${word} merges a worker's branch unchecked: use drove merge ${seat}: it runs the checks first`
    }
  }
  return undefined
}

const gitReadReason = (words: readonly string[], at: number): string | undefined => {
  const sub = words[at] ?? ''
  const rest = words.slice(at + 1)
  const reason = `git ${sub || '<nothing>'} can change the repository; a reviewer reads only (git diff, log, show, status and the like)`
  if (rest.some(word => word === '--output' || word.startsWith('--output='))) return reason
  if (GIT_READ_ONLY.has(sub)) return undefined
  const listing = GIT_LISTING[sub]
  if (listing) return (sub === 'remote' && rest.length === 0) || (rest[0] !== undefined && listing.has(rest[0])) ? undefined : reason
  const writeFlag = GIT_REF_WRITE_FLAG[sub]
  if (writeFlag) return rest.some(word => writeFlag.test(word)) || (!rest.some(word => word.startsWith('-')) && rest.length > 0) ? reason : undefined
  return reason
}

const gitReason = (words: readonly string[], scope: Scope): string | undefined => {
  const at = firstPositional(words, 1, GIT_OPTIONS_WITH_VALUE)
  if (words[at] === 'merge' && scope.role === 'planner') return mergeReason(words, at)
  if (scope.readOnly && words[at] !== 'push') return gitReadReason(words, at)
  if (words[at] !== 'push') return undefined
  if (scope.role === 'worker') return WORKER_PUSH
  if (words.some(word => PUSH_FLAGS_FOR_ALL.has(word))) return 'git push --all or --mirror would also push production, which nobody pushes to'
  return pushesProduction(words, at, scope.cwd) ? 'nobody pushes to the production branch: push main (or master) instead' : undefined
}

const namesProduction = (words: readonly string[]): boolean =>
  words.some((word, i) => {
    const [name = '', inline] = word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
    if (!GH_BRANCH_OPTIONS.has(name)) return false
    return (inline ?? words[i + 1] ?? '').replace(/^[^:]*:/, '') === 'production'
  })

// gh api reads with GET and writes with another method or with fields, in the separate and the joined spellings.
const ghApiWrites = (words: readonly string[]): boolean =>
  words.some((word, i) => {
    const joined = /^(?:-X|--method=)(.+)$/.exec(word)?.[1]
    const method = word === '-X' || word === '--method' ? words[i + 1] : joined
    if (method !== undefined && !/^get$/i.test(method)) return true
    return /^(?:-f|-F|--field|--raw-field|--input)(?:=.*)?$/.test(word) || /^-[fF]./.test(word)
  })

const ghReadOnlyReason = (words: readonly string[]): string | undefined => {
  if (isHelpOrVersion(words)) return undefined
  const at = firstPositional(words, 1, GH_OPTIONS_WITH_VALUE)
  const group = words[at] ?? ''
  const action = words[firstPositional(words, at + 1, GH_OPTIONS_WITH_VALUE)] ?? ''
  if (group === 'api') return ghApiWrites(words) ? 'gh api with a method or fields writes to GitHub; a reviewer reads only' : undefined
  if (GH_READ_GROUPS.has(group) || GH_READS[group]?.has(action)) return undefined
  return `gh ${group}${action ? ` ${action}` : ''} can change GitHub or the checkout; a reviewer reads only (gh pr view, list, diff, checks and the like, and gh api GETs)`
}

const ghReason = (words: readonly string[]): string | undefined => {
  const at = firstPositional(words, 1, GH_OPTIONS_WITH_VALUE)
  const group = words[at] ?? ''
  const action = words[firstPositional(words, at + 1, GH_OPTIONS_WITH_VALUE)] ?? ''
  if (GH_HUMAN_ONLY[group]?.has(action)) return `gh ${group} ${action} deletes, transfers or reconfigures GitHub: ask the human to run it`
  if (group === 'api' && words.some((word, i) => (/^-X$|^--method$/.test(words[i - 1] ?? '') && !/^get$/i.test(word)) || /^-(f|F)$|^--(field|raw-field|input)$/.test(word))) {
    return 'gh api with a method or fields writes to GitHub: ask the human to run it'
  }
  if (!GH_PLANNER_WRITES[group]?.has(action)) return undefined
  if (group === 'pr' && action === 'merge' && words.includes('--admin')) return 'gh pr merge --admin bypasses branch protection: ask the human'
  if (namesProduction(words)) return `gh ${group} ${action} names the production branch: nobody pushes to the production branch, use main (or master) instead`
  if (group === 'repo' && action === 'create' && (words.includes('--public') || !words.some(word => word === '--private' || word === '--internal'))) {
    return 'gh repo create without --private or --internal would publish a repo: ask the human to run it'
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
  if (scope.role === 'planner' && sub === 'merge' && words.some(word => word === '--no-checks' || word.startsWith('--no-checks='))) {
    return "drove merge --no-checks skips the repo's checks and is for the human to run: let the checks pass, or ask the human"
  }
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

// A reviewer's scratch: the temp directories, but never its own worktree even when the repo itself lives under one.
const isReviewerScratch = (path: string, cwd: string): boolean => {
  if (/[$`]/.test(path)) return false
  const target = canonical(path, cwd)
  const relation = relative(canonical(worktreeRoot(cwd), cwd), target)
  return (relation === '..' || relation.startsWith('../')) && isScratch(target)
}

const patchReason = (text: string, scope: Scope): string | undefined => {
  const paths = patchPaths(text)
  const outside = paths.find(path => !(scope.readOnly ? isReviewerScratch(path, scope.cwd) : isInside(path, scope.roots, scope.cwd)))
  if (paths.length === 0) return 'apply_patch changes files and no path could be read from it'
  return outside === undefined ? undefined : `apply_patch on ${outside} changes code`
}

const redirectReason = (target: string, scope: Scope): string | undefined => {
  if (HARMLESS_TARGETS.has(target)) return undefined
  if (/[$`]/.test(target)) return `redirecting output into ${target} writes to a path that cannot be checked`
  const isAllowed = scope.readOnly ? isReviewerScratch(target, scope.cwd) : isInside(target, scope.roots, scope.cwd) || isPlannerScratchpad(target, scope.cwd)
  return isAllowed ? undefined : `redirecting output into ${target} writes a file`
}

// Where a planner or a reviewer may write with a file command: the planner's session scratchpad, a reviewer's temp directories.
const isScratchTarget = (target: string, scope: Scope): boolean =>
  scope.readOnly ? isReviewerScratch(target, scope.cwd) : isPlannerScratchpad(target, scope.cwd)

const isCheckCommand = (head: string, words: readonly string[]): boolean => {
  const args = words.slice(1)
  if (args.some(word => CHECK_WRITE_FLAG.test(word))) return false
  const first = args[0] ?? ''
  if (SCRIPT_RUNNERS.has(head)) {
    const script = first === 'run' || first === 'run-script' || first === 'exec' ? args[1] : first
    return first === 't' || (script !== undefined && CHECK_SCRIPT.test(script) && !CHECK_SCRIPT_WRITES.test(script))
  }
  if (PACKAGE_EXECUTORS.has(head)) {
    const at = firstPositional(words, 1)
    return at < words.length && isCheckCommand(baseName(words[at] ?? ''), words.slice(at))
  }
  if (head === 'make') return args.length > 0 && args.every(word => word.startsWith('-') || (CHECK_SCRIPT.test(word) && !CHECK_SCRIPT_WRITES.test(word)))
  if (head === 'cargo') return CARGO_CHECKS.has(first)
  if (head === 'go') return GO_CHECKS.has(first)
  if (head === 'tsc') return args.includes('--noEmit') && !args.includes('-b') && !args.includes('--build')
  if (head === 'prettier') return args.some(word => word === '--check' || word === '-c' || word === '--list-different' || word === '-l')
  if (head === 'biome') return ['check', 'lint', 'ci'].includes(first)
  if (head === 'node') return args.includes('--test')
  if (head === 'python' || head === 'python3') return first === '-m' && ['pytest', 'unittest'].includes(args[1] ?? '')
  return CHECKERS.has(head)
}

const plannerReason = (words: readonly string[], scope: Scope): string | undefined => {
  const first = words[0]
  if (first === undefined) return undefined
  const head = baseName(first)
  if (first.startsWith('$')) return 'the command name comes from a variable or a substitution, which cannot be checked'
  if (/^(\.{1,2}|~)\//.test(first) || (first.includes('/') && isInside(first, scope.roots, scope.cwd))) return `running ${first} executes a script`
  if (FILE_WRITERS.has(head)) {
    const targets = SCRATCHPAD_WRITERS.has(head) ? writeTargets(head, words) : []
    if (targets.length > 0 && targets.every(target => isScratchTarget(target, scope))) return undefined
    return `${head} changes files or processes`
  }
  if ((head === 'sed' || head === 'perl') && words.some(word => /^-[a-zA-Z]*i/.test(word) || word.startsWith('--in-place'))) return `${head} -i edits files in place`
  if (head === 'find' && words.some(word => FIND_ACTIONS.has(word))) return 'find with an action runs commands or deletes files'
  if (scope.readOnly && isCheckCommand(head, words)) return undefined
  if (head === 'perl' || RUNTIMES.has(head)) return `${head} runs code`
  if (head === 'gh') return scope.readOnly ? ghReadOnlyReason(words) : ghReason(words)
  if (head === 'curl' || head === 'wget') return curlReason(head, words)
  if (PACKAGE_TOOLS.has(head)) return packageReason(head, words)
  return undefined
}

const segmentReason = (segment: Segment, scope: Scope): string | undefined => {
  const isStrict = scope.role === 'planner' || scope.readOnly === true
  if (isStrict && segment.stdoutFile !== undefined) {
    const reason = redirectReason(segment.stdoutFile, scope)
    if (reason) return reason
  }
  if (scope.role === 'worker' && scope.owns && segment.stdoutFile !== undefined) {
    const reason = ownsReason(segment.stdoutFile, scope)
    if (reason) return reason
  }
  const { words } = unwrap(segment.words)
  const first = words[0]
  if (first === undefined) return undefined
  const head = baseName(first)
  if (scope.role === 'worker' && scope.owns) {
    const reason = writeTargets(head, words).map(target => ownsReason(target, scope)).find(Boolean)
    if (reason) return reason
    if (head === 'apply_patch') return patchPaths(segment.stdin.join('\n')).map(path => ownsReason(path, scope)).find(Boolean)
  }
  if (head === 'apply_patch' && isStrict) return patchReason(segment.stdin.join('\n'), scope)
  if (head === 'git') return gitReason(words, scope)
  if (head === 'herdr') return herdrReason(words, scope)
  if (head === 'claude' || head === 'codex') return sessionReason(head, words, scope)
  if (head === 'drove') return droveReason(words, scope)
  return isStrict ? plannerReason(words, scope) : undefined
}

const commandReason = (command: string, scope: Scope, depth: number): string | undefined => {
  if (depth > MAX_NESTING) return scope.role === 'planner' || scope.readOnly ? 'the command nests substitutions too deeply to check' : undefined
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
  commandReason(command, { role, roots: context.writableRoots, seats: context.openSeats, cwd: context.cwd ?? process.cwd(), ...(context.owns && context.owns.length > 0 ? { owns: context.owns } : {}), ...(context.readOnly ? { readOnly: true } : {}) }, 0)

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
  const isReviewer = role === 'worker' && input.seatRole === 'reviewer'
  if (EDIT_TOOLS.has(tool) && isReviewer) {
    const paths = editPathsOf(tool, input.input)
    if (paths.length === 0) return denied(role, `${tool} changes code and no path could be read from it`)
    const outside = paths.find(path => !isReviewerScratch(path, input.cwd))
    return outside === undefined ? ALLOW : denied(role, `${tool} on ${outside}: a reviewer seat is read-only and writes only scratch files under /tmp; put what you found in your report`)
  }
  if (EDIT_TOOLS.has(tool)) {
    const owns = role === 'worker' && input.owns && input.owns.length > 0 ? input.owns : undefined
    if (role === 'worker' && !owns) return ALLOW
    const paths = editPathsOf(tool, input.input)
    if (paths.length === 0) return denied(role, `${tool} changes code and no path could be read from it`)
    if (owns) {
      const outside = paths.find(path => !isOwned(path, owns, input.cwd))
      return outside === undefined ? ALLOW : denied(role, ownsText(outside, owns))
    }
    const outside = paths.find(path => !isInside(path, input.writableRoots, input.cwd))
    return outside === undefined ? ALLOW : denied(role, `${tool} on ${outside} changes code`)
  }
  if (!SHELL_TOOLS.has(tool)) return ALLOW
  const command = commandOf(input.input)
  if (command === undefined) return role === 'planner' || isReviewer ? denied(role, 'there is no command text to check') : ALLOW
  const reason = bashReason(command, role, {
    writableRoots: isReviewer ? TMP_ROOTS : input.writableRoots,
    openSeats: input.openSeats,
    cwd: workdirOf(input),
    ...(input.owns ? { owns: input.owns } : {}),
    ...(isReviewer ? { readOnly: true } : {}),
  })
  return reason ? denied(role, reason) : ALLOW
}
