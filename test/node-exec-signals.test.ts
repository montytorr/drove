import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const commandsUrl = new URL('../src/commands.ts', import.meta.url).href
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
const posix = { skip: process.platform === 'win32', timeout: 20_000 }
type GroupPids = { leader: number; grandchild: number }

const assertGroupsExited = (groups: GroupPids[]): void => {
  const ps = spawnSync('ps', ['-eo', 'pid=,pgid=,stat='], { encoding: 'utf8' })
  assert.equal(ps.status, 0, ps.stderr)
  for (const line of ps.stdout.trim().split('\n')) {
    const [pid, pgid, state] = line.trim().split(/\s+/)
    if (groups.some(group => Number(pgid) === group.leader || [group.leader, group.grandchild].includes(Number(pid)))) {
      assert.match(state!, /^Z/, `process still alive: ${line}`)
    }
  }
}

const fixture = async (t: TestContext, ownHandler = '', groupCount = 1) => {
  const dir = await mkdtemp(join(tmpdir(), 'drove-exec-signal-'))
  const files = Array.from({ length: groupCount }, (_, i) => join(dir, `${i}.json`))
  const restarted = join(dir, 'restarted')
  // The grandchild closes its pipes and ignores SIGTERM. Its leader exits on
  // SIGTERM, so cleanup must continue after the leader's close event.
  const grandchild = `
    const { writeFileSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    writeFileSync(process.argv[1], JSON.stringify({ leader: process.ppid, grandchild: process.pid }));
    setInterval(() => {}, 1000);
  `
  const leader = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, process.argv[1]], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `
  const script = `
    import { nodeExec } from ${JSON.stringify(commandsUrl)};
    import { readFile } from 'node:fs/promises';
    ${ownHandler}
    const runs = ${JSON.stringify(files)}.map(file => nodeExec([process.execPath, '-e', ${JSON.stringify(leader)}, file]));
    ${ownHandler === '' ? `void runs[0].then(() => nodeExec([process.execPath, '-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(restarted)}, 'started'); setInterval(() => {}, 1000);`)}])).then(result => process.send({ chained: result.code }));` : ''}
    const groups = await Promise.all(${JSON.stringify(files)}.map(async file => {
      for (;;) {
        try { return JSON.parse(await readFile(file, 'utf8')); } catch {}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }));
    process.send({ groups, listeners: ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal)) });
    await Promise.all(runs);
    process.send({ cleaned: true, listeners: ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal)) });
  `
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += chunk })
  const closed = once(child, 'close')
  let groups: GroupPids[] = []
  t.after(async () => {
    child.kill('SIGKILL')
    // Also recover fixture PIDs if readiness failed, to avoid leaking test processes.
    for (const file of files) {
      try { groups.push(JSON.parse(await readFile(file, 'utf8')) as GroupPids) } catch {}
    }
    for (const group of groups) {
      try { process.kill(-group.leader, 'SIGKILL') } catch {}
    }
    await rm(dir, { recursive: true, force: true })
  })
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message as { groups: GroupPids[]; listeners: number[] }),
    closed.then(result => { throw new Error(`fixture exited before readiness: ${result}; ${stderr}`) }),
  ])
  groups = ready.groups
  return { child, closed, groups, ready, restarted, stderr: () => stderr }
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  test(`nodeExec cleans all detached groups before exiting ${code} on ${signal} (DROVE-145)`, posix, async t => {
    const run = await fixture(t, '', 2)
    assert.deepEqual(run.ready.listeners, [1, 1, 1], 'one handler per signal across concurrent groups')
    const chained = once(run.child, 'message')
    run.child.kill(signal)
    assert.deepEqual((await chained)[0], { chained: code }, 'follow-on exec returns the signal code without launching')
    const [exitCode, exitSignal] = await run.closed
    assert.deepEqual([exitCode, exitSignal], [code, null], run.stderr())
    assertGroupsExited(run.groups)
    await assert.rejects(readFile(run.restarted), { code: 'ENOENT' }, 'interrupted callers cannot launch another group during shutdown')
  })
}

for (const registration of ['before', 'after', 'persistent'] as const) {
  test(`nodeExec preserves an application's SIGINT handler (${registration}) (DROVE-145)`, posix, async t => {
    const handler = `
      const keepAlive = setInterval(() => {}, 1000);
      const ownStop = () => { process.exitCode = 42; process.send({ owned: true }); };
      ${registration === 'before' ? "process.once('SIGINT', ownStop);" : registration === 'after' ? "setImmediate(() => process.once('SIGINT', ownStop));" : "process.on('SIGINT', ownStop);"}
      process.on('message', message => { if (message === 'exit') { clearInterval(keepAlive); process.disconnect(); } });
    `
    const run = await fixture(t, handler)
    const owned = once(run.child, 'message')
    run.child.kill('SIGINT')
    assert.deepEqual((await owned)[0], { owned: true })
    const [cleaned] = await once(run.child, 'message')
    assert.deepEqual(cleaned, { cleaned: true, listeners: [registration === 'persistent' ? 1 : 0, 0, 0] })
    assert.equal(run.child.exitCode, null, 'application still decides when to exit')
    assertGroupsExited(run.groups)
    run.child.send('exit')
    assert.deepEqual(await run.closed, [42, null], run.stderr())
  })
}

test('nodeExec removes signal handlers after successful, missing and timed-out commands (DROVE-145)', posix, async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { nodeExec } from ${JSON.stringify(commandsUrl)};
    const counts = () => ${JSON.stringify(signals)}.map(signal => process.listenerCount(signal));
    const before = counts();
    for (const [argv, options] of [
      [[process.execPath, '-e', ''], {}],
      [['definitely-not-a-binary-xyz'], {}],
      [[process.execPath, '-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }],
    ]) {
      await nodeExec(argv, options);
      assert.deepEqual(counts(), before);
    }
    process.kill(process.pid, 'SIGINT');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  assert.deepEqual(await once(child, 'close'), [null, 'SIGINT'], stderr)
})
