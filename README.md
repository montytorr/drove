# drove

A small cross-agent orchestrator on [herdr](https://herdr.dev). One planner session (Claude Code or Codex) plans, delegates, reviews diffs and merges. Workers (Claude Code or Codex) write the code, each in its own herdr pane and its own git worktree. Drove has no daemon: the planner's own stdio MCP server watches the workers' outboxes and wakes the planner.

**Status:** this is the design and a typed skeleton. Every function is a stub that throws `not implemented`. Read [DESIGN.md](DESIGN.md) for the decisions, protocol, launch specs, guard rules and build plan.

## Requirements

- Node 22.18 or newer. Drove runs its TypeScript directly through type stripping, so there is no build step.
- herdr 0.9 or newer. The planner runs inside a herdr pane (`HERDR_ENV=1`).
- `claude` and/or `codex` on `PATH`.

## Install (from a checkout)

```sh
npm install      # dev dependencies only: typescript, @types/node
npm link         # puts `drove` on PATH, pointing at src/cli.ts
```

Node does not strip types from files under `node_modules`, so use `npm link` rather than a global install.

## Use

```sh
drove plan --kind claude          # or --kind codex: starts the planner in this herdr pane
drove roster                      # what is running
drove board                       # live board, for a spare pane
drove down / drove up             # stop and resume a run, with session ids
```

The planner drives `spawn`, `send`, `promote`, `close` and the rest through its `drove` MCP tools. `drove --help` lists every command.

## Develop

```sh
npm test            # node:test, test/**/*.test.ts
npm run typecheck   # tsc --noEmit
```

State lives in `~/.drove` (override it with `DROVE_HOME`). Drove never edits `~/.claude`, `~/.codex` or `~/.tmux.conf`, and never writes `AGENTS.md` or `CLAUDE.md` into a repo.
