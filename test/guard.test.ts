import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as guard from '../src/guard.ts'
import type { GuardInput, Role } from '../src/types.ts'
import { assertExports } from './helpers.ts'

const ROOTS = ['/tmp', '/private/tmp', '/Users/test/.claude/plans']
const SEATS = ['w-api', 'w-ui', 'thread-1234']

const planner = (command: string, seats: readonly string[] = SEATS) => guard.bashReason(command, 'planner', { writableRoots: ROOTS, openSeats: seats })
const worker = (command: string) => guard.bashReason(command, 'worker', { writableRoots: [], openSeats: [] })

const call = (role: Role, tool: string, input: Record<string, unknown>, extra: Partial<GuardInput> = {}) =>
  guard.decide({ agent: 'claude', role, tool, input, cwd: '/work/repo', writableRoots: ROOTS, openSeats: SEATS, ...extra })

test('guard exports its interface', () => {
  assertExports(guard, ['decide', 'bashReason', 'isInside', 'denyText', 'commandOf', 'editPathsOf'])
  assert.ok(guard.EDIT_TOOLS.has('apply_patch'))
  assert.ok(guard.SHELL_TOOLS.has('exec_command'))
})

test('planner: reading is allowed (ported from the mod)', () => {
  for (const command of [
    'git status',
    'git -C ../api diff --stat',
    'git log --oneline -5 | head',
    'git branch',
    'git branch -a',
    'git stash list',
    'rg "TODO" src | wc -l',
    'cat package.json 2>/dev/null',
    'ls -la && pwd',
    'gh pr view 12 --json title',
    'gh api repos/acme/api/pulls',
    'herdr agent list',
    'herdr agent read w-auth',
    'cairn note CCS-43 "x" --kind finding',
    'npm ls react',
    'docker ps',
    'curl -s https://example.com/health',
    'sed -n 1,20p src/a.ts',
    'echo hi > /tmp/plan.md',
    'make -n build',
    'git commit -m wip',
    'git -C ../api push origin HEAD',
    'git switch -c feature --no-track origin/main',
    'git merge --no-ff main',
    'git merge origin/main',
    'git merge --abort',
    'git worktree remove --force .claude/worktrees/w-slug',
    'git stash',
    'git push origin main',
    'wget -qO- https://example.com',
    'gh pr create --title x --body y',
    'gh pr checkout 12',
    'gh issue comment 3 --body ok',
    'gh release create v1 --notes x',
    'gh run rerun 1',
    'gh workflow run ci.yml',
    'gh label create x',
    'gh repo create foo --private',
    'gh repo create foo --internal',
    'gh repo clone acme/api',
  ]) {
    assert.deepEqual([command, planner(command)], [command, undefined])
  }
})

test('planner: writing, building and running are refused (ported from the mod)', () => {
  for (const command of [
    'echo x > src/a.ts',
    'cat >> notes.md <<EOF\nhi\nEOF',
    'sed -i "" s/a/b/ src/a.ts',
    'perl -pi -e s/a/b/ x',
    'rm -rf dist',
    'mv a b',
    'npm install',
    'npm test',
    'pnpm run build',
    'npx vitest',
    'node scripts/migrate.js',
    'python3 -c "print(1)"',
    './deploy.sh',
    'bash run.sh',
    'gh api -X POST repos/acme/api/issues -f title=x',
    'herdr pane split --pane w1:p1',
    'herdr agent prompt w-auth "go"',
    'claude -p hello',
    'curl -X POST https://x.test/api -d "{}"',
    'echo $(rm -rf build)',
    'docker compose up -d',
    'tee out.txt < in.txt',
  ]) {
    assert.deepEqual([command, typeof planner(command)], [command, 'string'])
  }
})

test('planner: gh pr merge is denied in any form and points at drove merge', () => {
  for (const command of ['gh pr merge 12', 'gh pr merge 12 --squash', 'gh -R acme/api pr merge 12 --auto']) {
    assert.match(planner(command) ?? '', /use drove merge <seat> --pr.*ask the human to merge other PRs/)
  }
  assert.equal(planner('gh pr create --title x --body y'), undefined)
  assert.equal(planner('drove goal "Release 0.3.0"'), undefined)
})

test('planner: gh deletions, settings, public repos, secrets and production stay with the human', () => {
  for (const command of [
    'gh issue delete 1',
    'gh label delete x',
    'gh pr merge 12 --admin --squash',
    'gh pr merge 12 --squash',
    'gh -R acme/api pr merge 12',
    'gh pr merge 12 --auto --squash',
    'gh issue transfer 1 acme/other',
    'gh release delete v1',
    'gh run delete 1',
    'gh repo delete acme/api --yes',
    'gh repo rename new',
    'gh repo archive acme/api',
    'gh repo edit --visibility public',
    'gh repo create foo --public',
    'gh repo create foo',
    'gh repo create foo --private --public',
    'gh secret set X',
    'gh variable delete X',
    'gh api -X DELETE repos/acme/api',
    'gh pr create --base production',
    'gh pr create -B production',
    'gh pr create --base=production',
    'gh pr create --head production',
    'gh pr create --head fork:production',
    'gh release create v1 --target production',
    'gh workflow run x --ref production',
  ]) {
    assert.deepEqual([command, typeof planner(command)], [command, 'string'])
  }
  assert.match(planner('gh issue delete 1') ?? '', /ask the human/)
  assert.match(planner('gh repo create foo') ?? '', /ask the human/)
  assert.match(planner('gh pr create --base production') ?? '', /nobody pushes to the production branch/)
  assert.equal(planner('gh pr create --base main --head feature'), undefined)
})

test('planner: bypasses the mod missed are refused', () => {
  for (const command of [
    '> truncated.txt',
    'eval "rm x"',
    'source ./env.sh',
    '. ./env.sh',
    'find . -name x -delete',
    'find . -exec rm {} \\;',
    'ls | xargs rm',
    'a=rm; $a x',
    '$(echo rm) x',
    '/tmp/script.sh',
    'echo hi > $HOME/x',
    'echo hi > ../escape',
    'echo $(echo $(echo $(echo $(echo $(echo $(echo $(rm x)))))))',
  ]) {
    assert.deepEqual([command, typeof planner(command)], [command, 'string'])
  }
})

test('CCS-50: quoted text and quoted heredocs are data', () => {
  const allowed = [
    'cairn add "t" --body - <<\'EOF\'\nsee <ref> and `herdr pane split` and $(rm -rf x)\nit\'s fine\nEOF',
    'cairn add "t" --body "$(cat <<\'EOF\'\nsee <ref>\n`herdr pane split`\ndon\'t\nEOF\n)"',
    "echo '$(rm -rf x)'",
    'grep -n "a<b" file',
    "echo '`rm f`' $'$(rm f)'",
    'cat <<"EOF"\n$(touch f)\nEOF',
  ]
  for (const command of allowed) assert.deepEqual([command, planner(command)], [command, undefined])
})

test('CCS-50: expansions the shell performs are still checked', () => {
  const denied = [
    'echo "$(herdr pane split --current)"',
    'x=`rm f`',
    'cat <<EOF\n$(touch f)\nEOF',
    'echo "`rm f`"',
    'diff <(rm f) b',
    'cat <<EOF\nhello `touch f`\nEOF',
    'echo $((1 + $(touch f)))',
    'cat <<\'EOF\' && rm x\nbody\nEOF',
  ]
  for (const command of denied) assert.deepEqual([command, typeof planner(command)], [command, 'string'])
})

test('planner may prompt an open seat but not an unknown agent', () => {
  assert.equal(planner('herdr agent prompt w-api "go on"'), undefined)
  assert.equal(planner('herdr agent prompt w-api "go" --wait --timeout 8000'), undefined)
  assert.equal(planner('herdr agent prompt --timeout 8000 w-ui "go"'), undefined)
  assert.equal(planner('herdr agent wait w-api'), undefined)
  assert.match(planner('herdr agent prompt stranger "go"') ?? '', /not an open seat/)
  assert.match(planner('herdr agent prompt "go"') ?? '', /not an open seat/)
  assert.match(planner('herdr agent prompt w-api "go"', []) ?? '', /not an open seat/)
  assert.match(planner('herdr agent send-keys w-api Enter') ?? '', /changes panes/)
  assert.match(planner('herdr agent start w-api') ?? '', /changes panes/)
  assert.match(planner('herdr agent prompt $(echo w-api) go') ?? '', /not an open seat/)
})

test('planner may codex queue only to an open seat (by name or thread id)', () => {
  assert.equal(planner('codex queue --thread w-api --message "go"'), undefined)
  assert.equal(planner('codex queue --thread thread-1234 --message "go"'), undefined)
  assert.equal(planner('codex queue --message "go" --thread=w-ui'), undefined)
  assert.match(planner('codex queue --thread other --message "go"') ?? '', /not an open seat/)
  assert.match(planner('codex queue --message "go"') ?? '', /not an open seat/)
  assert.match(planner('codex exec "rm x"') ?? '', /another codex session/)
  assert.match(planner('codex') ?? '', /another codex session/)
})

test('worker may run claude plugin test; everything else claude stays denied', () => {
  for (const command of ['claude plugin test mod', 'claude plugin test', '~/.local/bin/claude plugin test mod', '/Users/x/.local/bin/claude plugin test mod', 'cd x && claude plugin test mod']) {
    assert.equal(worker(command), undefined, command)
  }
  for (const command of ['claude', 'claude -p hi', 'claude --resume x', 'claude plugin install foo', 'claude plugin', 'claude plugin test mod extra', 'claude plugin test --dangerously-skip-permissions', 'codex plugin test mod', '~/.local/bin/claude -p hi']) {
    assert.ok(worker(command), command)
  }
  assert.match(planner('claude plugin test mod') ?? '', /another claude session/)
  assert.match(planner('~/.local/bin/claude plugin test mod') ?? '', /another claude session|executes a script/)
})

test('claude and codex allow --help and --version for everyone', () => {
  for (const command of ['claude --help', 'claude --version', 'claude -v', 'codex --help', 'codex -V', 'codex queue --help', 'claude mcp add --help']) {
    assert.deepEqual([command, planner(command)], [command, undefined])
    assert.deepEqual([command, worker(command)], [command, undefined])
  }
  for (const command of ['claude -p hi', 'claude -p --help', 'codex exec "do it"', 'codex --model x']) {
    assert.deepEqual([command, typeof planner(command)], [command, 'string'])
    assert.deepEqual([command, typeof worker(command)], [command, 'string'])
  }
})

test('push to production is denied for everyone', () => {
  for (const command of [
    'git push origin production',
    'git push origin HEAD:production',
    'git push origin +main:refs/heads/production',
    'git push origin :production',
    'git push --delete origin production',
    'git -C ../api push origin production',
    'git push --all',
    'git push --mirror origin',
  ]) {
    assert.deepEqual([command, typeof planner(command)], [command, 'string'])
    assert.deepEqual([command, typeof worker(command)], [command, 'string'])
  }
  assert.equal(planner('git push origin main'), undefined)
  assert.equal(planner('git push origin main:master'), undefined)
})

test('a bare push from a production checkout is denied', () => {
  const repo = mkdtempSync(join(tmpdir(), 'drove-guard-'))
  mkdirSync(join(repo, '.git'))
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/production\n')
  const deny = guard.bashReason('git push', 'planner', { writableRoots: ROOTS, openSeats: [], cwd: repo })
  assert.match(deny ?? '', /production/)
  assert.match(guard.bashReason('git push origin HEAD', 'planner', { writableRoots: ROOTS, openSeats: [], cwd: repo }) ?? '', /production/)
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  assert.equal(guard.bashReason('git push', 'planner', { writableRoots: ROOTS, openSeats: [], cwd: repo }), undefined)
})

test('workers may do anything but push, drive panes or start sessions (ported from the mod)', () => {
  assert.equal(worker('npm test && git commit -m x'), undefined)
  assert.match(worker('git push origin feature') ?? '', /never push/)
  assert.match(worker('git -C ../x push') ?? '', /never push/)
  assert.match(worker('echo $(git push)') ?? '', /never push/)
  assert.ok(worker('herdr pane split'))
  assert.ok(worker('herdr agent prompt w-api go'))
  assert.equal(worker('herdr agent list'), undefined)
  assert.equal(worker('herdr agent wait w-api'), undefined)
  assert.ok(worker('claude -p hi'))
  assert.equal(worker('rm -rf dist && echo x > src/a.ts && node build.js && gh pr create'), undefined)
  assert.equal(worker('gh issue delete 1 && gh repo create foo'), undefined)
  assert.equal(worker('cairn add "t" --body - <<\'EOF\'\n`herdr pane split` <ref>\nEOF'), undefined)
})

test('drove subcommands are allowed or denied per role', () => {
  for (const sub of ['spawn w-x', 'send w-x hi', 'prompt w-x hi', 'promote w-x', 'merge w-x', 'merge w-x --pr --squash -m "merge: x"', 'roster --json', 'attention --run r --json', 'capture w-x', 'close w-x', 'board --once', 'down']) {
    assert.equal(planner(`drove ${sub}`), undefined, sub)
  }
  for (const sub of ['budget 6', 'plan', 'up', 'guard pre-tool-use', 'mcp', 'board', 'nonsense', '']) {
    assert.ok(planner(`drove ${sub}`), sub)
    assert.ok(worker(`drove ${sub}`), sub)
  }
  assert.match(planner('drove budget 6') ?? '', /ask the human/)
  assert.equal(worker('drove roster'), undefined)
  assert.equal(worker('drove capture w-api --lines 5'), undefined)
  assert.equal(worker('drove doctor --json'), undefined)
  for (const sub of ['spawn w-x', 'send w-x hi', 'close w-x', 'down', 'board --once', 'merge w-x', 'attention']) assert.ok(worker(`drove ${sub}`), sub)
})

test('drove diagnose is read only and the planner\'s: allowed there, denied to a worker (DROVE-131)', () => {
  assert.equal(planner('drove diagnose'), undefined)
  assert.equal(planner('drove diagnose --json'), undefined)
  assert.match(worker('drove diagnose') ?? '', /not available to a worker/)
  assert.ok(worker('drove diagnose drove-20261009-1042-a3f1 --json'))
})

test('drove owns is the planner\'s: allowed there, denied to a worker even with the env cleared or set to planner (DROVE-119)', () => {
  assert.equal(planner('drove owns w-x --add mod/types/index.d.ts'), undefined)
  assert.equal(planner('drove owns w-x --set "src/**,test/**"'), undefined)
  for (const command of [
    'drove owns w-x --add src/a.ts',
    'env -u DROVE_ROLE drove owns w-x --add src/a.ts',
    'DROVE_ROLE=planner drove owns w-x --add src/a.ts',
    'env DROVE_ROLE=planner drove owns w-x --set a',
  ]) assert.ok(worker(command), command)
})

test('a worker may read Drove\'s run state through Bash but not write it (DROVE-119)', () => {
  for (const command of [
    'cat ~/.drove/runs/r1/roster.json',
    'jq .seats "$HOME/.drove/runs/r1/roster.json"',
    'grep owns /home/u/.drove/runs/r1/events.jsonl',
    'tail -n 5 "$DROVE_HOME/runs/r1/events.jsonl" | wc -l',
    'ls ~/.drove/runs',
    'git commit -m "feat(checks): ledger in ~/.drove/runs/<id>/checks.jsonl"',
    'cairn note DROVE-122 "ledger lives in ~/.drove/runs" --kind finding',
    'echo "see ~/.drove"',
    'env -u DROVE_HOME -u DROVE_RUN npm test',
    'DROVE_HOME=/tmp/x node --test test/a.test.ts',
  ]) assert.equal(worker(command), undefined, command)
  for (const command of [
    'echo "{}" > "$HOME/.drove/runs/r1/roster.json"',
    'cat x > ~/.drove/runs/r1/roster.json',
    `node -e "require('fs').writeFileSync(process.env.HOME + '/.drove/runs/r1/roster.json', '{}')"`,
    `python3 -c "open('/home/u/.drove/runs/r1/roster.json','w').write('{}')"`,
    "sed -i 's/src/**/' ~/.drove/runs/r1/roster.json",
    'cp /tmp/r.json $DROVE_HOME/runs/r1/roster.json',
    'sed -i s/a/b/ ${DROVE_HOME}/runs/r1/roster.json',
    'echo x > ~/.drove/runs/r/roster.json',
    'env -u X sed -i s/a/b/ ~/.drove/runs/r1/roster.json',
  ]) assert.match(worker(command) ?? '', /run state is the planner's/, command)
})

test('a worker with owns is denied a write to Drove\'s run state too, and the planner is unaffected', () => {
  const owned = (command: string) => guard.bashReason(command, 'worker', { writableRoots: [], openSeats: [], owns: ['src/**'] })
  assert.match(owned('node -e "x" ~/.drove/runs/r1/roster.json') ?? '', /run state is the planner's/)
  assert.equal(owned('cat ~/.drove/runs/r1/roster.json'), undefined)
  assert.equal(planner('cat ~/.drove/runs/r1/roster.json'), undefined)
})

test('planner: a git merge of a seat branch is denied and points at drove merge, in any spelling', () => {
  for (const command of [
    'git merge worktree-w-gate',
    'git merge --no-ff worktree-w-slug',
    'git merge --no-ff -m "merge: x" drove/w-cx',
    'git merge origin/worktree-w-api',
    'git merge refs/heads/drove/w-api~1',
    'git -C ../repo merge -s ours worktree-w-api',
    'git merge main worktree-w-api',
    'git merge --squash drove/w-api && git commit -m x',
    'echo $(git merge worktree-w-api)',
  ]) {
    assert.match(planner(command) ?? '', /use drove merge w-[a-z]+: it runs the checks first/, command)
  }
  assert.match(planner('git merge --no-ff worktree-w-slug') ?? '', /use drove merge w-slug: it runs the checks first/)
  assert.match(planner('git merge drove/w-cx') ?? '', /use drove merge w-cx: it runs the checks first/)
  assert.equal(worker('git merge worktree-w-api'), undefined)
  assert.equal(planner('git merge --no-ff -m "merge worktree-w-api notes" main'), undefined)
  assert.equal(planner('git log worktree-w-api..main'), undefined)
  const denied = call('planner', 'Bash', { command: 'git merge worktree-w-gate' })
  assert.equal(denied.allow, false)
})

test('drove merge --no-checks is for the human: denied to the planner and the worker', () => {
  for (const command of ['drove merge w-x --no-checks', 'drove merge --no-checks w-x --pr', 'drove merge w-x --no-checks=true']) {
    assert.match(planner(command) ?? '', /--no-checks .* for the human/, command)
    assert.ok(worker(command), command)
  }
  assert.equal(planner('drove merge w-x --pr'), undefined)
})

test('planner may write inside a Claude session scratchpad and nowhere else', () => {
  const pad = '/private/tmp/claude-501/-Users-cal-proj/abc-123/scratchpad'
  const strict = (command: string) => guard.bashReason(command, 'planner', { writableRoots: [], openSeats: [] })
  for (const command of [
    `mkdir -p ${pad}/x`,
    `cat > ${pad}/f <<EOF\nhi\nEOF`,
    `echo hi >> ${pad}/f`,
    `tee ${pad}/f`,
    `touch ${pad}/a ${pad}/b`,
    `cp /Users/test/plan.md ${pad}/plan.md`,
    `mv ${pad}/a ${pad}/b`,
    `rm -rf ${pad}/x`,
    'mkdir -p /tmp/claude-501/p/s/scratchpad/y',
  ]) {
    assert.equal(strict(command), undefined, command)
  }
  for (const command of [
    'mkdir /Users/x/foo',
    'mkdir /tmp/other',
    'mkdir -p /tmp/claude-501/p/s/notpad',
    `mkdir ${pad}/../../other`,
    `mkdir ${pad}/x /tmp/other`,
    `mv ${pad}/a /Users/x/a`,
    'rm -rf /tmp/claude-*/p/s/scratchpad/x',
    'rm -rf $TMPDIR/claude-501/p/s/scratchpad/x',
    'cat > /Users/x/f <<EOF\nhi\nEOF',
    'cat > /tmp/other',
    'node -e "1"',
    `chmod +x ${pad}/a`,
  ]) {
    assert.ok(strict(command), command)
  }
})

test('worker rules are unchanged by the planner scratchpad rule', () => {
  assert.equal(worker('mkdir -p /Users/x/foo && rm -rf dist && git init'), undefined)
})

test('drove init is for the planner only', () => {
  assert.equal(planner('drove init /Users/test/new-repo'), undefined)
  assert.ok(worker('drove init /Users/test/new-repo'))
})

test('isInside compares real paths (ported from the mod)', () => {
  assert.equal(guard.isInside('/tmp/claude-501/x/scratchpad/plan.md', ROOTS), true)
  assert.equal(guard.isInside('/Users/test/.claude/plans/p.md', ROOTS), true)
  assert.equal(guard.isInside('/Users/test/.claude/plansx/p.md', ROOTS), false)
  assert.equal(guard.isInside('/work/repo/src/a.ts', ROOTS), false)
  assert.equal(guard.isInside('/tmp/../work/repo/a.ts', ROOTS), false)
  assert.equal(guard.isInside('notes.md', ROOTS, '/tmp/x'), true)
  assert.equal(guard.isInside('../notes.md', ROOTS, '/work/repo'), false)
})

test('isInside follows symlinks out of a writable root', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'drove-root-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'drove-out-')))
  symlinkSync(outside, join(root, 'link'))
  assert.equal(guard.isInside(join(root, 'plain', 'a.md'), [root]), true)
  assert.equal(guard.isInside(join(root, 'link', 'a.md'), [root]), false)
  assert.equal(guard.isInside(join(root, 'link', 'a.md'), [outside]), true)
})

test('decide: edit tools are limited to the writable roots for the planner', () => {
  assert.equal(call('planner', 'Write', { file_path: '/tmp/claude-501/plan.md' }).allow, true)
  assert.equal(call('planner', 'Edit', { file_path: '/Users/test/.claude/plans/p.md' }).allow, true)
  assert.equal(call('planner', 'NotebookEdit', { notebook_path: '/work/repo/n.ipynb' }).allow, false)
  const denied = call('planner', 'Edit', { file_path: '/work/repo/src/a.ts' })
  assert.equal(denied.allow, false)
  assert.match(denied.allow ? '' : denied.reason, /Drove planner: Edit on \/work\/repo\/src\/a.ts changes code/)
  assert.equal(call('planner', 'Write', {}).allow, false)
  assert.equal(call('worker', 'Write', { file_path: '/work/repo/src/a.ts' }).allow, true)
  assert.equal(call('worker', 'apply_patch', { command: '*** Begin Patch\n*** End Patch' }).allow, true)
})

test('decide: apply_patch paths are read from the patch', () => {
  const inTmp = '*** Begin Patch\n*** Add File: /tmp/notes.md\n+hi\n*** End Patch'
  const mixed = '*** Begin Patch\n*** Add File: /tmp/notes.md\n+hi\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch'
  assert.equal(call('planner', 'apply_patch', { command: inTmp }).allow, true)
  assert.equal(call('planner', 'apply_patch', { command: ['apply_patch', inTmp] }).allow, true)
  assert.equal(call('planner', 'apply_patch', { command: mixed }).allow, false)
  assert.equal(call('planner', 'apply_patch', { input: mixed }).allow, false)
  assert.equal(call('planner', 'apply_patch', { command: 'nonsense' }).allow, false)
  assert.equal(call('planner', 'Bash', { command: `apply_patch <<'EOF'\n${mixed}\nEOF` }).allow, false)
  assert.equal(call('planner', 'Bash', { command: `apply_patch <<'EOF'\n${inTmp}\nEOF` }).allow, true)
})

test('decide: shell tools accept strings and argv arrays', () => {
  assert.equal(call('planner', 'Bash', { command: 'git status' }).allow, true)
  assert.equal(call('planner', 'shell', { command: ['bash', '-lc', 'git status'] }).allow, true)
  assert.equal(call('planner', 'shell', { command: ['bash', '-lc', 'rm -rf dist'] }).allow, false)
  assert.equal(call('planner', 'shell', { command: ['git', 'status'] }).allow, true)
  assert.equal(call('planner', 'shell', { command: ['rm', '-rf', 'dist'] }).allow, false)
  assert.equal(call('planner', 'shell', { command: ['echo', 'a b; rm x'] }).allow, true)
  assert.equal(call('planner', 'exec_command', { cmd: 'rm x' }).allow, false)
  assert.equal(call('planner', 'exec_command', { cmd: 'echo hi > out.txt', workdir: '/tmp' }).allow, true)
  assert.equal(call('planner', 'exec_command', { cmd: 'echo hi > out.txt', workdir: '/work/repo' }).allow, false)
  assert.equal(call('planner', 'Bash', {}).allow, false)
  assert.equal(call('worker', 'Bash', {}).allow, true)
  assert.equal(call('worker', 'shell', { command: ['git', 'push'] }).allow, false)
})

test('decide: other tools pass through', () => {
  assert.equal(call('planner', 'Read', { file_path: '/work/repo/a.ts' }).allow, true)
  assert.equal(call('planner', 'mcp__drove__roster', {}).allow, true)
})

test('denyText names the role and the reason', () => {
  assert.match(guard.denyText('planner', 'rm changes files'), /^Drove planner: rm changes files\. .*never change code/)
  assert.equal(guard.denyText('worker', 'workers never push'), 'Drove worker: workers never push.')
})
