import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as guard from '../src/guard.ts'
import type { GuardInput, Role } from '../src/types.ts'

// DROVE-71: a worker with owned globs may change only those files (under its worktree), and nothing else.
const OWNS = ['src/guard.ts', 'test/**/*.test.ts', 'mod/hooks/*.ts', 'docs', '{README,DESIGN}.md']
const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'drove-owns-')))
writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/w-owns\n')
mkdirSync(join(worktree, 'src', 'deep'), { recursive: true })

const call = (role: Role, tool: string, input: Record<string, unknown>, extra: Partial<GuardInput> = {}) =>
  guard.decide({ agent: 'claude', role, tool, input, cwd: worktree, writableRoots: [], openSeats: [], ...extra })
const owned = (tool: string, input: Record<string, unknown>, extra: Partial<GuardInput> = {}) => call('worker', tool, input, { owns: OWNS, ...extra })
const ownedBash = (command: string, cwd = worktree) => owned('Bash', { command }, { cwd })
const reasonOf = (decision: ReturnType<typeof call>) => (decision.allow ? undefined : decision.reason)

test('owns: edit tools are allowed inside the globs and denied outside, with the planner pointer', () => {
  for (const path of ['src/guard.ts', 'test/a.test.ts', 'test/deep/er/b.test.ts', 'mod/hooks/drove.ts', 'docs/readme.md', 'docs/a/b/c.md', 'README.md', 'DESIGN.md', './src/guard.ts']) {
    assert.equal(owned('Edit', { file_path: join(worktree, path) }).allow, true, path)
    assert.equal(owned('Write', { file_path: path }).allow, true, `relative ${path}`)
  }
  for (const path of ['src/launch.ts', 'src/deep/guard.ts', 'test/helpers.ts', 'mod/hooks/deep/x.ts', 'package.json', 'LICENSE']) {
    const decision = owned('Edit', { file_path: join(worktree, path) })
    assert.equal(decision.allow, false, path)
    assert.match(reasonOf(decision) ?? '', /^Drove worker: .*this file is outside the paths your brief gives you \(src\/guard\.ts, test\/\*\*\/\*\.test\.ts, .*\); ask the planner with the drove report tool\.$/)
  }
  assert.equal(owned('MultiEdit', { file_path: join(worktree, 'src/launch.ts') }).allow, false)
  assert.equal(owned('NotebookEdit', { notebook_path: join(worktree, 'n.ipynb') }).allow, false)
  assert.equal(owned('Write', {}).allow, false)
})

test('owns: paths resolve against the worktree even from a subdirectory, and escapes are denied', () => {
  const sub = join(worktree, 'src', 'deep')
  assert.equal(owned('Edit', { file_path: '../guard.ts' }, { cwd: sub }).allow, true)
  assert.equal(owned('Edit', { file_path: 'x.ts' }, { cwd: sub }).allow, false)
  assert.equal(owned('Edit', { file_path: '../../../other/src/guard.ts' }).allow, false)
  assert.equal(owned('Edit', { file_path: '/Users/test/elsewhere/src/guard.ts' }).allow, false)
  assert.equal(owned('Edit', { file_path: worktree }).allow, false)
})

test('owns: scratch space outside the worktree stays writable', () => {
  assert.equal(owned('Write', { file_path: '/tmp/scratch.txt' }).allow, true)
  assert.equal(owned('Write', { file_path: '/private/tmp/claude-501/x/notes.md' }).allow, true)
  assert.equal(owned('Write', { file_path: join(tmpdir(), 'x.txt') }).allow, true)
  assert.equal(owned('Write', { file_path: join(homedir(), '.claude/projects/-Users-cal-repo/memory/note.md') }).allow, true)
  assert.equal(owned('Write', { file_path: join(homedir(), '.claude/settings.json') }).allow, false)
})

test('owns: apply_patch paths are checked, move targets included', () => {
  const inside = '*** Begin Patch\n*** Update File: src/guard.ts\n@@\n-a\n+b\n*** End Patch'
  const mixed = '*** Begin Patch\n*** Update File: src/guard.ts\n@@\n-a\n+b\n*** Add File: src/new.ts\n+x\n*** End Patch'
  const moved = '*** Begin Patch\n*** Update File: src/guard.ts\n*** Move to: src/renamed.ts\n@@\n-a\n+b\n*** End Patch'
  assert.equal(owned('apply_patch', { command: inside }).allow, true)
  assert.equal(owned('apply_patch', { input: mixed }).allow, false)
  assert.equal(owned('apply_patch', { command: ['apply_patch', moved] }).allow, false)
  assert.equal(owned('apply_patch', { command: 'nonsense' }).allow, false)
  assert.equal(ownedBash(`apply_patch <<'EOF'\n${inside}\nEOF`).allow, true)
  assert.equal(ownedBash(`apply_patch <<'EOF'\n${mixed}\nEOF`).allow, false)
})

test('owns: shell write targets the guard parses are checked', () => {
  for (const command of [
    'echo hi > src/guard.ts',
    'cat >> README.md <<EOF\nmore\nEOF',
    'tee test/a.test.ts < in.txt',
    'cp /tmp/draft.ts src/guard.ts',
    'mv test/a.test.ts test/b.test.ts',
    'rm test/old.test.ts',
    'touch docs/new.md',
    'mkdir -p docs/sub',
    'sed -i "" s/a/b/ src/guard.ts',
    'sed -n 1,5p src/launch.ts',
    'perl -pi -e s/a/b/ src/guard.ts',
    'chmod 755 src/guard.ts',
    'dd if=/dev/zero of=docs/x bs=1 count=1',
    'cp -t docs src/launch.ts',
    'truncate -s 0 src/guard.ts',
    'cat src/launch.ts | grep x',
    'echo ok > /dev/null',
    'echo $(date) > "$OUT"',
    'npm test',
    'git status',
  ]) {
    assert.equal(ownedBash(command).allow, true, command)
  }
  for (const command of [
    'echo hi > src/launch.ts',
    'echo hi >> package.json',
    'cat > LICENSE <<EOF\nx\nEOF',
    'tee src/launch.ts < in.txt',
    'cp src/guard.ts src/launch.ts',
    'mv src/guard.ts src/guard.old.ts',
    'mv src/launch.ts docs/launch.ts',
    'rm -rf dist',
    'rm -f src/launch.ts src/guard.ts',
    'touch package.json',
    'mkdir -p build/out',
    'sed -i "" s/a/b/ src/launch.ts',
    'sed -i.bak -e s/a/b/ package.json',
    'perl -pi -e s/a/b/ package.json',
    'chmod +x scripts/run.sh',
    'dd if=/dev/zero of=out.bin',
    'cp -t build src/guard.ts',
    'truncate -s 0 package.json',
    'echo hi > ../../escape.txt',
    'ls && echo x > nested/dir/file.txt',
    'echo "$(echo hi > src/launch.ts)"',
  ]) {
    const decision = ownedBash(command)
    assert.equal(decision.allow, false, command)
    assert.match(reasonOf(decision) ?? '', /this file is outside the paths your brief gives you/, command)
  }
})

test('owns: a worker with no owns keeps today, and the planner is unaffected by owns', () => {
  assert.equal(call('worker', 'Edit', { file_path: '/work/repo/src/anything.ts' }).allow, true)
  assert.equal(call('worker', 'Edit', { file_path: '/work/repo/src/anything.ts' }, { owns: [] }).allow, true)
  assert.equal(call('worker', 'Bash', { command: 'echo hi > /work/repo/x.ts' }).allow, true)
  assert.equal(call('worker', 'Bash', { command: 'echo hi > /work/repo/x.ts' }, { owns: [] }).allow, true)
  assert.equal(call('worker', 'Bash', { command: 'git push' }, { owns: OWNS }).allow, false)
  assert.equal(call('planner', 'Write', { file_path: '/tmp/plan.md' }, { owns: ['src/**'], writableRoots: ['/tmp'] }).allow, true)
  assert.equal(call('planner', 'Write', { file_path: '/work/repo/src/a.ts' }, { owns: ['src/**'] }).allow, false)
  assert.equal(guard.bashReason('echo hi > x.ts', 'worker', { writableRoots: [], openSeats: [] }), undefined)
})

test('owns: a glob that names a directory owns what is under it, ./ is ignored, a bad brace is literal', () => {
  assert.equal(guard.isOwned(join(worktree, 'docs/a/b.md'), ['docs'], worktree), true)
  assert.equal(guard.isOwned(join(worktree, 'documents/a.md'), ['docs'], worktree), false)
  assert.equal(guard.isOwned(join(worktree, 'src/a.ts'), ['./src/*.ts'], worktree), true)
  assert.equal(guard.isOwned(join(worktree, 'src/deep/a.ts'), ['src/*.ts'], worktree), false)
  assert.equal(guard.isOwned(join(worktree, 'a.ts'), ['**/*.ts'], worktree), true)
  assert.equal(guard.isOwned(join(worktree, 'src/deep/a.ts'), ['**/*.ts'], worktree), true)
  assert.equal(guard.isOwned(join(worktree, 'src/a.ts'), ['src/{a,b'], worktree), false)
  assert.equal(guard.isOwned(join(worktree, 'a-1.ts'), ['a-?.ts'], worktree), true)
})
