# Changelog

All notable changes to Drove are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Lean spawns
- A lean Claude worker (`workerMcp` or `--mcp` set) starts with `--no-chrome`, so Claude in Chrome's 22 tools are not loaded. Name `claude-in-chrome` in the list to keep it.
- A Claude worker no longer gets a second report tool from the mod: `mcp__drove__report` is the one.
- New `workerPlugins` config key: a Claude worker loads only the plugins and mods you list, plus Drove's own mod.
- New `workerUserMemory: false` config key: a worker skips your `~/.claude/CLAUDE.md` and the `CLAUDE.md` files above the repo (Claude), and your `AGENTS.md` and `AGENTS.override.md` (Codex). It stays on by default.
- A spawn can trim one worker: `plugins` (`--plugins a,b`) adds to `workerPlugins` and makes that worker plugin-lean even when the key is unset, and `userMemory` (`--user-memory on|off`) overrides `workerUserMemory` for that worker. They work in `drove spawn`, the spawn tool and the mod's `spawn_worker`, and a promote, restart or migrate keeps them. They are Claude-only: Codex has no per-launch switch for your `AGENTS.md`, so a Codex worker follows `workerUserMemory` and the spawn result says so.
- The planner's role text has a "Lean spawns" paragraph: what a worker loads under your config, when to pass `mcp`, `plugins` and `userMemory`, and the MCP server and plugin names it can choose from (read from your Claude and Codex files, names only).
- A spawn reports a `plugins` name that matches no plugin you have enabled, as it already does for MCP servers.
- The README has a "Lean workers" section with a table of each switch, its default and what it saves.

## [0.2.0] - 2026-10-11

The first public release. Drove runs one planner and several worker agents side by side in [herdr](https://herdr.dev) panes, each worker in its own git worktree, tracked on Cairn tasks.

### Planner and workers
- The planner is Claude Code or Codex, started three ways: `/orchestrate` with the mod, `drove plan --kind claude`, or `drove plan --kind codex`.
- Workers are Claude Code or Codex under either planner, each in its own herdr pane and git worktree.
- A planner can `spawn`, `send`, give a `verdict`, `promote` and `demote` a worker's model or effort, `migrate` it to the other provider, and `close` it.
- A run started with no goal takes the first prompt you type as its goal.
- `drove down` saves every session, and `drove up` resumes the run or relaunches one dead seat. After a crash or a reboot, `drove up` adopts the run again.
- Several runs can be open at once, one per herdr workspace.

### Messages and safety
- Planner messages are signed per seat, so a forged or edited message is flagged by the worker.
- A guard hook stops the planner editing code, stops workers pushing, and never answers a dialog for an agent.
- `--owns` limits a worker to the files matching its globs.
- Turn and token budgets (`--max-turns`, `--max-tokens`) raise a `budget` attention instead of killing the worker.
- At most 5 worker panes; a 6th needs a human yes (`drove budget 6`).

### Board
- `drove board` draws live seats, states and what needs a human, in your terminal.
- `drove board --web` serves the same board read-only in a browser, on 127.0.0.1 and behind a token made at each start.
- The web board has a graph view with a dot for each brief, report or verdict, a one-line timeline, and a seat detail with the tail of its pane.

### Cairn integration
- Every worker is spawned with one Cairn ref, and `spawn` checks that the task exists and is open.
- `drove plan --from-cairn REF` starts a run from a task, and `--next PROJECT` from the top task a project ranks.
- `drove down` writes a summary note on the run's Cairn task: the seats, their branches and what is still open.
- `close` releases the seat's Cairn claim.

### Limits
- A worker that hits its usage limit gets a `usage-limit` attention item and is never nudged into it.
- `drove migrate` moves that worker to the other provider in the same worktree, with a handoff brief: the saved brief, the branch's commits and the last reports.

### Lean spawns
- A worker can load only the MCP servers and skills you name (`workerMcp` and `workerSkills` in config, or `--mcp` per spawn), so it starts lighter.
- Codex workers share a Drove-owned `CODEX_HOME` per run, which keeps the launch line short.

### Known limits
See [Known limits](README.md#known-limits) in the README.

Full history: see the commit log.

[0.2.0]: https://github.com/montytorr/drove/releases/tag/v0.2.0
