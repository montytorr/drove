import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as shell from '../src/shell.ts'
import { assertExports } from './helpers.ts'

const subs = (src: string): string[] => shell.parseShell(src).flatMap(pipeline => pipeline.flatMap(segment => segment.substitutions))
const heads = (src: string): string[] => shell.parseShell(src).flatMap(pipeline => pipeline.map(segment => segment.words[0] ?? ''))

test('shell exports its interface', () => {
  assertExports(shell, ['parseShell', 'unwrap', 'baseName'])
})

test('pipelines, segments and redirects are split', () => {
  const [first, second] = shell.parseShell('git log | head -3 && cat a > out.txt; ls 2>/dev/null')
  assert.deepEqual(first?.map(segment => segment.words), [['git', 'log'], ['head', '-3']])
  assert.equal(second?.[0]?.stdoutFile, 'out.txt')
  assert.equal(shell.parseShell('ls 2>/dev/null')[0]?.[0]?.stdoutFile, '/dev/null')
  assert.equal(shell.parseShell('echo hi 2>&1')[0]?.[0]?.stdoutFile, undefined)
  assert.equal(shell.parseShell('> truncated.txt')[0]?.[0]?.stdoutFile, 'truncated.txt')
})

test('quotes build words and comments are skipped', () => {
  assert.deepEqual(shell.parseShell('echo "a b" \'c d\' e\\ f # rm x')[0]?.[0]?.words, ['echo', 'a b', 'c d', 'e f'])
  assert.deepEqual(shell.parseShell("echo $'a\\nb'")[0]?.[0]?.words, ['echo', 'a\nb'])
})

test('substitutions are recorded where a shell expands them', () => {
  assert.deepEqual(subs('echo "$(herdr pane split --current)"'), ['herdr pane split --current'])
  assert.deepEqual(subs('echo $(rm -rf x)'), ['rm -rf x'])
  assert.deepEqual(subs('x=`rm f`'), ['rm f'])
  assert.deepEqual(subs('echo "`rm f`"'), ['rm f'])
  assert.deepEqual(subs('diff <(cat a) >(tee b)'), ['cat a', 'tee b'])
  assert.deepEqual(subs('echo $(echo $(touch f))'), ['echo $(touch f)'])
  assert.deepEqual(subs('echo $((1 + 2))'), ['(1 + 2)'])
})

test('single quotes, ansi-c quotes and escapes are data (CCS-50)', () => {
  assert.deepEqual(subs("echo '$(rm -rf x)'"), [])
  assert.deepEqual(subs("echo '`rm f`'"), [])
  assert.deepEqual(subs("echo $'$(rm f)'"), [])
  assert.deepEqual(subs('echo \\$(rm f)'), [])
  assert.deepEqual(subs('echo "\\$(rm f)"'), [])
  assert.deepEqual(subs('grep -n "a<b" file'), [])
  assert.deepEqual(heads('grep -n "a<b" file'), ['grep'])
  assert.deepEqual(subs('echo "<(rm f)"'), [])
})

test('a quoted-delimiter heredoc body is data', () => {
  const src = 'cairn add "t" --body - <<\'EOF\'\nuse <ref> and `herdr pane split` and $(rm -rf x)\nit\'s fine\nEOF'
  const [pipeline] = shell.parseShell(src)
  assert.equal(pipeline?.length, 1)
  assert.deepEqual(pipeline?.[0]?.words, ['cairn', 'add', 't', '--body', '-'])
  assert.deepEqual(pipeline?.[0]?.substitutions, [])
  assert.match(pipeline?.[0]?.stdin[0] ?? '', /herdr pane split/)
  assert.deepEqual(subs('cat <<"EOF"\n$(touch f)\nEOF'), [])
  assert.deepEqual(subs('cat <<\\EOF\n$(touch f)\nEOF'), [])
})

test('a command substitution that wraps a quoted heredoc stays data inside', () => {
  const src = 'cairn add "t" --body "$(cat <<\'EOF\'\nsee <ref> and `herdr pane split`\ndon\'t stop\nEOF\n)"'
  const found = subs(src)
  assert.equal(found.length, 1)
  assert.deepEqual(subs(found[0] ?? ''), [])
  assert.deepEqual(heads(found[0] ?? ''), ['cat'])
  assert.deepEqual(shell.parseShell(src)[0]?.[0]?.words.slice(0, 3), ['cairn', 'add', 't'])
})

test('an unquoted-delimiter heredoc body expands', () => {
  assert.deepEqual(subs('cat <<EOF\nhello $(touch f)\nEOF'), ['touch f'])
  assert.deepEqual(subs('cat <<EOF\nhello `touch f`\nEOF'), ['touch f'])
  assert.deepEqual(subs('cat <<EOF\nhello \\$(touch f)\nEOF'), [])
  assert.deepEqual(subs('cat <<-EOF\n\tx $(touch f)\n\tEOF'), ['touch f'])
})

test('commands after a heredoc are still parsed', () => {
  assert.deepEqual(heads('cat <<EOF\nbody\nEOF\nrm x'), ['cat', 'rm'])
  assert.deepEqual(heads("cat <<'EOF' && rm x\nbody\nEOF"), ['cat', 'rm'])
})

test('arithmetic shifts are not heredocs', () => {
  assert.deepEqual(heads('echo $((1<<2))\nrm x'), ['echo', 'rm'])
})

test('a substitution in a bare redirect or heredoc is kept', () => {
  assert.deepEqual(subs('> $(touch f)'), ['touch f'])
  assert.deepEqual(subs('<<EOF\n$(touch f)\nEOF'), ['touch f'])
  assert.deepEqual(subs('cat <<< "$(touch f)"'), ['touch f'])
})

test('an unterminated substitution reads to the end', () => {
  assert.deepEqual(subs('echo $(rm x'), ['rm x'])
  assert.deepEqual(subs('echo `rm x'), ['rm x'])
})

test('subshells and groups split commands', () => {
  assert.deepEqual(heads('(cd x && rm y)'), ['cd', 'rm'])
  assert.deepEqual(shell.unwrap(shell.parseShell('{ rm x; }')[0]?.[0]?.words ?? []).words, ['rm', 'x'])
})

test('unwrap strips assignments, keywords and wrappers', () => {
  assert.deepEqual(shell.unwrap(['FOO=1', 'BAR=2', 'rm', 'x']), { words: ['rm', 'x'], env: { FOO: '1', BAR: '2' } })
  assert.deepEqual(shell.unwrap(['then', 'rm', 'x']).words, ['rm', 'x'])
  assert.deepEqual(shell.unwrap(['sudo', '-u', 'root', 'rm', 'x']).words, ['rm', 'x'])
  assert.deepEqual(shell.unwrap(['env', '-i', 'A=1', 'rm', 'x']).words, ['rm', 'x'])
  assert.deepEqual(shell.unwrap(['timeout', '-s', 'KILL', '5', 'rm', 'x']).words, ['rm', 'x'])
  assert.deepEqual(shell.unwrap(['nice', '-n', '5', 'rm', 'x']).words, ['rm', 'x'])
  assert.deepEqual(shell.unwrap(['xargs', '-I', '{}', 'rm', '{}']).words, ['rm', '{}'])
  assert.deepEqual(shell.unwrap(['command', 'exec', 'rm']).words, ['rm'])
  assert.deepEqual(shell.unwrap(['watch', '-n', '2', 'rm x']).words, ['rm', 'x'])
  assert.deepEqual(shell.unwrap([]).words, [])
})

test('baseName keeps the last path part', () => {
  assert.equal(shell.baseName('/usr/bin/rm'), 'rm')
  assert.equal(shell.baseName('rm'), 'rm')
})
