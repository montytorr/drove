# drove

[![CI](https://github.com/montytorr/drove/actions/workflows/ci.yml/badge.svg)](https://github.com/montytorr/drove/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Drove runs one planner and several worker agents side by side in [herdr](https://herdr.dev) panes. You choose the planner: Claude Code or Codex. It splits work into Cairn tasks, starts a worker for each, reviews their diffs and merges. The workers write the code, each in its own pane and its own git worktree, and they are Claude Code or Codex under either planner.

**Why the name.** A drove is a herd driven together, and the drover drives it: Drove runs on herdr and keeps one planner's workers moving. Drove roads were the old Scottish cattle routes the drovers walked to market, which fits the names in this family (Bothy, Cairn, Croft, Trig, Holloway).

Three ways to start a planner:

| Planner | Start it with | What you get |
|---|---|---|
| Claude Code, with the mod | `/orchestrate <goal>` in a session with `mod/` loaded | A board inside Claude, model and effort switched on each request, in-app dialogs |
| Claude Code, without the mod | `drove plan --kind claude` | Woken by a channel (a research preview in Claude Code) or by keystrokes |
| Codex | `drove plan --kind codex` | Woken by `codex queue`; the sixth-pane budget is asked through MCP elicitation |

There is no daemon. The planner's own MCP server (or, for a Claude planner with the mod, a child process of the mod) reads each worker's report file and wakes the planner. Run state is plain files under `~/.drove`.

[DESIGN.md](DESIGN.md) has the protocol, launch specs, guard rules and the reasons behind them.

## Requirements

- Node 22.18 or newer. Drove runs its TypeScript directly, so there is no build step.
- herdr 0.9 or newer. The planner runs inside a herdr pane (`HERDR_ENV=1`).
- `claude` and/or `codex` on `PATH`.
- [Cairn](https://cairn.montytorr.com), a task tracker and shared memory for agents. Drove has no work queue of its own: every worker is spawned with one Cairn task ref (`--cairn DROVE-12`), claims that task, records what it found and tried on it, and leaves it in review, so the work outlives the pane and the planner can see what each worker did.

## Install

```sh
npm install      # dev dependencies only: typescript, @types/node
ln -sf ~/src/drove/src/cli.ts ~/.local/bin/drove   # the path of your clone; any directory on PATH
```

Recommended: the symlink survives `nvm use`. `src/cli.ts` is executable and runs under whichever `node` is on PATH, which must be Node 22.18+.

Alternative: `npm link` from the repo. Under nvm a link exists for one Node version only, so `drove` disappears after switching versions. Use a link, not a global install: Node does not strip types from files under `node_modules`.

## Quick start

Pick the planner (the table above), then use one of these.

**Claude Code with the mod.** From a Claude Code session:

1. Start Claude in a herdr pane with `mod/` in `CLAUDE_CODE_PLUGIN_DIRS`.
2. Type `/orchestrate <goal>`. The session becomes the planner and gets the tools `spawn_worker`, `message_worker`, `review_verdict`, `promote_worker`, `demote_worker`, `close_worker` and `roster`. A board and a wake bridge run inside Claude. Typing `/orchestrate` again in the same session re-attaches to the run.

**Claude Code without the mod, or Codex.** From any herdr pane:

```sh
drove plan --kind claude    # Claude Code without the mod
drove plan --kind codex     # Codex; add --goal "..." to either for a first instruction
drove board                 # in a spare pane: live seats, states and what needs a human
```

`drove plan` creates a run, records the pane as the planner pane and replaces itself with `claude` or `codex`, with Drove's MCP server, guard hooks and role text attached.

## How a worker's life goes

1. **Spawn.** The planner calls `spawn` with a seat name, a kind, a Cairn ref and a brief. Drove opens a pane, waits for the shell prompt, then starts the agent. If the agent does not appear it resets the pane and tries once more. The brief is sent after the agent is up, never as a launch argument. For a Codex worker the worker role text rides at the top of the brief, and the agent runs under a `CODEX_HOME` Drove keeps for the run (see State and config).
2. **Work.** A Claude worker gets its worktree from `claude --worktree` (branch `worktree-<seat>`). A Codex worker gets one made by Drove (branch `drove/<seat>`). The worker never pushes; a hook denies it.
3. **Report.** The worker calls its `report` tool: `done`, `question`, `blocked`, `promote` or `progress`. Anything but `progress` wakes the planner.
4. **Verdict.** The planner reads the diff and sends `approve` or `changes`. After an approve the worker commits its own paths and reports `done` again.
5. **Close.** The planner merges, then closes the seat. A Claude seat is closed by closing its pane, never with `/exit`; Drove releases the worktree lock Claude leaves behind. Codex gets `/quit` first. A worktree is removed only on request and only when its branch is merged.

Planner messages are signed with a per-seat token. The signature covers the header fields that change what a worker does (`kind`, `to`, `run`, `model`, `effort`, `verdict`, `expects`) as well as the body, so editing any of them on a genuine message fails the check. A Claude worker with the mod marks a message that fails the check as unverified, and acts on a `promote` only when it verifies. A Codex worker's `UserPromptSubmit` hook (`drove guard user-prompt-submit`) runs the same check and, on a failure, hands Codex the same "not signed by your planner" notice as additional context and a warning, without blocking the turn. Text that follows a signed message in the same paste is shown under a "not signed by Drove" label.

`promote` changes a worker's model or effort, `demote` moves it back. `--model` is optional, so a Codex worker on Codex's default model can be promoted by effort alone. A Claude worker with the mod switches on its next request and is told its new model; otherwise, and for Codex, Drove restarts the agent with resume once it is idle.

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
| `drove board [--once] [--run ID]` | live plain-text board (this repo's latest run unless `--run` or `DROVE_RUN`) |
| `drove down [--run ID]` / `drove up [--run ID] [--seat SEAT]` | stop and resume a run |
| `drove budget <n> [--run ID]` | raise the pane budget (the human only; agents are denied) |
| `drove guard <event>`, `drove mcp`, `drove mod attach\|bridge\|report` | entry points for hooks, MCP and the mod |

`drove --help` prints the same list. A planner normally uses the MCP tools `spawn`, `send`, `verdict`, `prompt`, `promote`, `close`, `roster`, `capture` and `down`; a worker has one tool, `report`. They call the same functions as the CLI.

## Rules Drove enforces

- The planner does not edit code or run builds; a guard hook denies it. Workers never push, and nobody pushes to `production`. A worker may run `claude plugin test`, and no other `claude` command.
- At most 5 worker panes. A 6th needs the human's yes (`drove budget 6`, or a dialog in the mod).
- Drove never answers a dialog an agent shows. It reports it on the board instead.
- Drove never edits `~/.claude`, `~/.codex` or `~/.tmux.conf`, and never writes `AGENTS.md` or `CLAUDE.md` into a repo. Permissions are set per launch.
- Several runs can be open at once, for example one per herdr workspace. herdr agent names are shared across the server, so Drove names each agent `<seat>-<run tag>`. Two runs of one repo share the worktree folder, so a spawn that would reuse a seat another run still holds is refused.

## State and config

State lives in `~/.drove` (`DROVE_HOME` overrides it): one folder per run with `roster.json`, `events.jsonl`, a `codex-home/` and a folder per seat holding its token, its report file and its launch spec. `codex-home/` is the `CODEX_HOME` Drove gives Codex workers: Drove writes its `config.toml` (the MCP server, repo trust and hook trust) and `hooks.json`, and symlinks your `auth.json`, `AGENTS.md` and skills into it, so the launch line stays short and Codex asks no hook-review question. Your own `~/.codex` is read, never written. Optional settings go in `~/.drove/config.json`: `plannerModel`, `workerModel`, `promotedModel`, `plannerEffort`, `workerEffort`, `budget`, `humanName`, `codexWorkerSandbox`, `codexBypassHookTrust`, `claudeChannel`, `briefVia` and `workerEnv` (extra environment variables for worker launches, such as `{"MY_FLAG": "1"}`). Defaults are in `src/commands.ts`.

Codex workers run with approvals and the sandbox bypassed, like Claude workers with `--dangerously-skip-permissions`. Drove's guard hook still denies pushes. Set `codexWorkerSandbox` to `"workspace-write"` to turn that off.

## Known limits

- **Codex sessions of a Drove-owned run live under the run's `codex-home/`**, not `~/.codex`, so `codex resume` outside Drove does not see them. A Codex seat spawned before this change keeps the old launch line (about 1100 bytes) and relies on the shell-prompt wait; another shell that draws a prompt before its init has finished could still defeat that wait for such a seat.
- **Claude picks its own worktree base.** Claude creates its worktree from `origin/main`; `spawn` then fast-forwards it to the freshest of local `main` and `origin/main`, so unpushed local work is included. `--base` is ignored for Claude seats, and a worktree that diverged from the base is left as is, with a note in `spawn`'s result. Codex workers start from `--base` or the run base, resolved the same way.
- **Seen working live** (DROVE-49, 2026-10-10): a Codex planner with Codex workers woken by `codex queue`; the sixth-pane budget dialog in Claude (the mod) and in Codex (MCP elicitation); two runs side by side with the same seat name; a Claude planner without the mod woken by the channel; and message signatures in Claude and Codex workers (a forged promote is flagged). The fixes of 2026-10-10 passed a live run (DROVE-35).
- **The channel prints a cosmetic line.** A Claude planner launched with the dev channel shows `server:drove · no MCP server configured with that name` at launch, and the channel works anyway. An idle session does take a turn when a report arrives through it. The channel is a research preview in Claude Code and asks for one confirmation per launch.
- The Codex planner and a Codex seat that has no Drove-owned home may still ask once to approve Drove's hooks in the pane; Drove never answers that dialog, and shows it on the board.
- The mod cannot import Drove's code. It runs the CLI, so Node 22.18 or newer must be on `PATH` (or set the mod's `nodePath`).

## Develop

```sh
npm install
npm test            # node:test, test/**/*.test.ts
npm run typecheck   # tsc --noEmit
```

Run `npm test` in a normal shell. Inside a Drove worker `DROVE_*` is set in the environment, and `test/mod-protocol.test.ts` fails on it unless you unset those variables.

The mod's tests run only through Claude Code. A Drove worker's guard allows exactly this command and no other `claude`:

```sh
claude plugin test mod
```

If `claude` is a shell function or wrapper, call the real binary (for example `~/.local/bin/claude`); a wrapper that adds flags before `plugin` breaks it. The mod's type check needs the generated `mod/.claude-plugin/types`, which is not in the repo.

## License

[MIT](LICENSE). To report a security issue, see [SECURITY.md](SECURITY.md).
