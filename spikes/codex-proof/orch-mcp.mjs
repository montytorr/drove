#!/usr/bin/env node
// Minimal stdio MCP server (newline-delimited JSON-RPC) exposing one tool: report.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';
const KINDS = ['done', 'question', 'blocked', 'progress'];
const EXPECTS = ['review', 'answer', 'none'];

const TOOL = {
  name: 'report',
  description:
    'Report to the orchestrator. Call this to deliver results or ask for a decision; it is the only way the orchestrator hears from you.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KINDS, description: 'done | question | blocked | progress' },
      expects: { type: 'string', enum: EXPECTS, description: 'What you expect back: review | answer | none' },
      body: { type: 'string', description: 'The report text' },
    },
    required: ['kind', 'expects', 'body'],
  },
};

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const fail = (id, code, message) => send({ id, error: { code, message } });
const toolError = (text) => ({ isError: true, content: [{ type: 'text', text }] });

const handleReport = (args = {}) => {
  const { kind, expects, body } = args;
  if (!KINDS.includes(kind)) return toolError(`kind must be one of ${KINDS.join('|')}`);
  if (!EXPECTS.includes(expects)) return toolError(`expects must be one of ${EXPECTS.join('|')}`);
  if (typeof body !== 'string' || !body) return toolError('body must be a non-empty string');
  const outbox = process.env.ORCH_OUTBOX;
  if (!outbox) return toolError('ORCH_OUTBOX is not set');
  const line = {
    ts: new Date().toISOString(),
    worker: process.env.ORCH_WORKER ?? null,
    token: process.env.ORCH_TOKEN ?? null,
    kind,
    expects,
    body,
  };
  appendFileSync(outbox, `${JSON.stringify(line)}\n`);
  return { content: [{ type: 'text', text: `report recorded (${kind}, expects ${expects})` }] };
};

const handle = (msg) => {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'orch', version: '0.1.0' },
      },
    });
  }
  if (id === undefined) return; // notifications (e.g. notifications/initialized)
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: [TOOL] } });
  if (method === 'tools/call') {
    if (params?.name !== 'report') return fail(id, -32602, `unknown tool ${params?.name}`);
    return send({ id, result: handleReport(params.arguments) });
  }
  return fail(id, -32601, `method not found: ${method}`);
};

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (error) {
    fail(null, -32700, `parse error: ${error.message}`);
  }
});
