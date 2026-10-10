# drove

Drove runs one planner and several worker agents side by side in [herdr](https://herdr.dev) panes. The planner (Claude Code or Codex) splits work into Cairn tasks, starts a worker for each, reviews their diffs and merges. The workers (Claude Code or Codex) write the code, each in its own pane and its own git worktree.

There is no daemon. The planner's own MCP server (or, for a Claude planner with the mod, a child process of the mod) reads each worker's report file and wakes the planner. Run state is plain files under `~/.drove`.

[DESIGN.md](DESIGN.md) has the protocol, launch specs, guard rules and the reasons behind them.

## Requirements

- Node 22.18 or newer. Drove runs its TypeScript directly, so there is no build step.
- herdr 0.9 or newer. The planner runs inside a herdr pane (`HERDR_ENV=1`).
- `claude` and/or `codex` on `PATH`.
- Cairn for the tasks. Each worker is spawned with one Cairn ref.

## Install

```sh
npm install      # dev dependencies only: typescript, @types/node
npm link         # puts `drove` on PATH, pointing at src/cli.ts
```

Use `npm link`, not a global install: Node does not strip types from files under `node_modules`.

## Quick start

From a Claude Code session, with the mod:

1. Start Claude in a herdr pane with `mod/` in `CLAUDE_CODE_PLUGIN_DIRS`.
2. Type `/orchestrate <goal>`. The session becomes the planner and gets the tools `spawn_worker`, `message_worker`, `review_verdict`, `promote_worker`, `demote_worker`, `close_worker` and `roster`. A board and a wake bridge run inside Claude. Typing `/orchestrate` again in the same session re-attaches to the run.

From any herdr pane, without the mod:

```sh
drove plan --kind claude    # or --kind codex; add --goal "..." for a first instruction
drove board                 # in a spare pane: live seats, states and what needs a human
```

`drove plan` creates a run, records the pane as the planner pane and replaces itself with `claude` or `codex`, with Drove's MCP server, guard hooks and role text attached.

## How a worker's life goes

1. **Spawn.** The planner calls `spawn` with a seat name, a kind, a Cairn ref and a brief. Drove opens a pane, waits for the shell prompt, then starts the agent. If the agent does not appear it resets the pane and tries once more. The brief is sent after the agent is up, never as a launch argument. For a Codex worker the worker role text rides at the top of the brief.
2. **Work.** A Claude worker gets its worktree from `claude --worktree` (branch `worktree-<seat>`). A Codex worker gets one made by Drove (branch `drove/<seat>`). The worker never pushes; a hook denies it.
3. **Report.** The worker calls its `report` tool: `done`, `question`, `blocked`, `promote` or `progress`. Anything but `progress` wakes the planner.
4. **Verdict.** The planner reads the diff and sends `approve` or `changes`. After an approve the worker commits its own paths and reports `done` again.
5. **Close.** The planner merges, then closes the seat. A Claude seat is closed by closing its pane, never with `/exit`; Drove releases the worktree lock Claude leaves behind. Codex gets `/quit` first. A worktree is removed only on request and only when its branch is merged.

Planner messages are signed with a per-seat token. A Claude worker with the mod marks any message that fails the check as unverified, and acts on a `promote` only when it verifies.

`promote` changes a worker's model or effort, `demote` moves it back. `--model` is optional, so a Codex worker on Codex's default model can be promoted by effort alone. A Claude worker with the mod switches on its next request; otherwise, and for Codex, Drove restarts the agent with resume once it is idle.

`drove down` saves every session id and stops the run. `drove up` resumes it, and `drove up --seat <seat>` relaunches one dead seat.

## Commands

| Command | Use |
|---|---|
| `drove plan [--kind claude\|codex] [--model M] [--effort E] [--goal TEXT] [--run ID]` | start a planner in this pane |
| `drove spawn <seat> --kind claude\|codex --cairn REF --brief TEXT\|- [--model M] [--effort E] [--base BRANCH]` | open a worker and brief it |
| `drove send <seat> --kind message\|answer\|verdict [--verdict approve\|changes] [--expects review\|answer\|none] TEXT\|-` | send one control message |
| `drove prompt <seat> TEXT\|-` | raw prompt into a seat of this run (guarded) |
| `drove promote <seat> [--model M] --effort E [--reason TEXT]` | change a worker's model or effort |
| `drove roster [--json] [--run ID]` | one line per seat |
| `drove capture <seat> [--lines N] [--run ID]` | read a seat's recent output |
| `drove close <seat> [--remove-worktree]` | stop a worker and close its pane |
| `drove board [--once] [--run ID]` | live plain-text board |
| `drove down [--run ID]` / `drove up [--run ID] [--seat SEAT]` | stop and resume a run |
| `drove budget <n> [--run ID]` | raise the pane budget (the human only; agents are denied) |
| `drove guard <event>`, `drove mcp`, `drove mod attach\|bridge\|report` | entry points for hooks, MCP and the mod |

`drove --help` prints the same list. A planner normally uses the MCP tools `spawn`, `send`, `verdict`, `prompt`, `promote`, `close`, `roster`, `capture` and `down`; a worker has one tool, `report`. They call the same functions as the CLI.

## Rules Drove enforces

- The planner does not edit code or run builds; a guard hook denies it. Workers never push, and nobody pushes to `production`.
- At most 5 worker panes. A 6th needs the human's yes (`drove budget 6`, or a dialog in the mod).
- Drove never answers a dialog an agent shows. It reports it on the board instead.
- Drove never edits `~/.claude`, `~/.codex` or `~/.tmux.conf`, and never writes `AGENTS.md` or `CLAUDE.md` into a repo. Permissions are set per launch.

## State and config

State lives in `~/.drove` (`DROVE_HOME` overrides it): one folder per run with `roster.json`, `events.jsonl` and a folder per seat holding its token, its report file and its launch spec. Optional settings go in `~/.drove/config.json`: `plannerModel`, `workerModel`, `promotedModel`, `plannerEffort`, `workerEffort`, `budget`, `humanName`, `codexWorkerSandbox`, `codexBypassHookTrust`, `claudeChannel` and `briefVia`. Defaults are in `src/commands.ts`.

Codex workers run with approvals and the sandbox bypassed, like Claude workers with `--dangerously-skip-permissions`. Drove's guard hook still denies pushes. Set `codexWorkerSandbox` to `"workspace-write"` to turn that off.

## Known limits

- **The Codex launch line is still over 1024 bytes** ([DROVE-34](https://tasks.montytorr.com/projects/DROVE/tasks/34)). macOS cuts a typed line at 1024 bytes until the shell is reading input. Drove shrinks the line, starts every pane with `POWERLEVEL9K_INSTANT_PROMPT=off` so powerlevel10k does not draw a prompt before its init is done, and waits for a settled shell prompt before it types. Another shell that draws a prompt before its init has finished could still defeat the wait. The fix is a Drove-owned `CODEX_HOME`.
- **A Claude worker may start from a base without your unpushed work.** Claude creates its own worktree (`claude --worktree`) and Drove cannot set its base: `--base` is ignored for Claude seats, and `spawn` only adds a note when the main checkout's HEAD is not at the run base. Claude branches the worktree from `origin/main`, not from the local `main` or the main checkout's HEAD, so work merged locally but not pushed is missing. Push, or run `git merge --ff-only main` in the worker's worktree, before you give it work that needs that code. Codex workers start from the run base.
- **Not yet run live**: a Codex planner with a Codex worker, the budget dialog in both clients, and the fixes of 2026-10-10 in a real run, including the message check of [DROVE-24](https://tasks.montytorr.com/projects/DROVE/tasks/24) ([DROVE-35](https://tasks.montytorr.com/projects/DROVE/tasks/35), [DROVE-19](https://tasks.montytorr.com/projects/DROVE/tasks/19)).
- Codex may ask once to approve Drove's hooks in the pane; Drove never answers that dialog, and shows it on the board.
- The mod cannot import Drove's code. It runs the CLI, so Node 22.18 or newer must be on `PATH` (or set the mod's `nodePath`).

## Develop

```sh
npm install
npm test            # node:test, test/**/*.test.ts
npm run typecheck   # tsc --noEmit
```

Run `npm test` in a normal shell. Inside a Drove worker `DROVE_*` is set in the environment, and `test/mod-protocol.test.ts` fails on it unless you unset those variables.

The mod's tests run only through Claude Code, from a normal shell (a Drove worker's guard blocks `claude`):

```sh
claude plugin test mod
```

If `claude` is a shell wrapper, call the real binary. The mod's type check needs the generated `mod/.claude-plugin/types`, which is not in the repo.
