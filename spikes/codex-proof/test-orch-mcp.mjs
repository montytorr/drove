// Unit test for orch-mcp.mjs over stdio: node test-orch-mcp.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const outbox = join(mkdtempSync(join(tmpdir(), 'orch-')), 'outbox.jsonl');
const child = spawn('node', [join(here, 'orch-mcp.mjs')], {
  env: { ...process.env, ORCH_OUTBOX: outbox, ORCH_WORKER: 'w-test', ORCH_TOKEN: 'tok-1' },
});

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report', arguments: { kind: 'done', expects: 'review', body: 'hello' } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'report', arguments: { kind: 'nope', expects: 'review', body: 'x' } } },
];
child.stdin.end(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');

let raw = '';
child.stdout.on('data', (d) => (raw += d));
await new Promise((resolve) => child.on('close', resolve));

const replies = Object.fromEntries(raw.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m]));
assert.equal(replies[1].result.serverInfo.name, 'orch');
assert.equal(replies[2].result.tools[0].name, 'report');
assert.equal(replies[3].result.isError, undefined);
assert.equal(replies[4].result.isError, true);

const lines = readFileSync(outbox, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.equal(lines.length, 1);
assert.deepEqual({ ...lines[0], ts: undefined }, { ts: undefined, worker: 'w-test', token: 'tok-1', kind: 'done', expects: 'review', body: 'hello' });
console.log('ok: initialize, tools/list, tools/call (valid + invalid), outbox line');
console.log(readFileSync(outbox, 'utf8').trim());
