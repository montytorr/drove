# drove

[![CI](https://github.com/montytorr/drove/actions/workflows/ci.yml/badge.svg)](https://github.com/montytorr/drove/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Drove runs one planner and several worker agents side by side in [herdr](https://herdr.dev) panes. You choose the planner: Claude Code or Codex. It splits work into Cairn tasks, starts a worker for each, reviews their diffs and merges them once the repo's checks pass. The workers write the code, each in its own pane and its own git worktree, and they are Claude Code or Codex under either planner.

**Why the name.** A drove is a herd driven together, and the drover drives it: Drove runs on herdr and keeps one planner's workers moving. Drove roads were the old Scottish cattle routes the drovers walked to market, which fits the names in this family (Bothy, Cairn, Croft, Trig, Holloway).

Three ways to start a planner:

| Planner | Start it with | What you get |
|---|---|---|
| Claude Code, with the mod | `/orchestrate <goal>` in a session with `mod/` loaded | A board inside Claude, model and effort switched on each request, in-app dialogs |
| Claude Code, without the mod | `drove plan --kind claude` | Woken by a channel (a research preview in Claude Code) or by keystrokes |
| Codex | `drove plan --kind codex` | Woken by `codex queue`; the sixth-pane budget is asked through MCP elicitation |

There is no daemon. The planner's own MCP server (or, for a Claude planner with the mod, a child process of the mod) reads each worker's report file and wakes the planner. Run state is plain files under `~/.drove`.

[DESIGN.md](DESIGN.md) has the protocol, launch specs, guard rules and the reasons behind them.

## Watching a run

The same board, in three places. It lists each seat with its kind, model, state and what needs a human, and a timeline of the briefs, reports and verdicts between the planner and its workers.

- **In a spare pane:** `drove board` is a live, coloured board that uses your terminal's own background. Piped, or with `--once`, it prints one frame.
- **Inside Claude:** with the mod loaded, the planner session shows the same board, with pills and toasts, and the dialogs that need your answer.
- **In a browser:** `drove board --web` serves a read-only page on `127.0.0.1`, behind a token made at each start. It opens on a graph of the lead and its workers, with a dot labelled brief, report or verdict travelling along the edge when one arrives. A Graph | Board switch goes to the rows, a click on a seat opens its state, branch, worktree and the tail of its pane, and the timeline has chips to show only what needs you, only reports, or everything. It runs only while the command does: Drove has no daemon.

The [commands section](#commands) has the full reference for `drove board --web`.

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

Releases are listed on the [GitHub releases page](https://github.com/montytorr/drove/releases); [CHANGELOG.md](CHANGELOG.md) has what changed in each.

## Quick start

Pick the planner (the table above), then use one of these.

**Claude Code with the mod.** From a Claude Code session:

1. Start Claude in a herdr pane with `mod/` in `CLAUDE_CODE_PLUGIN_DIRS`.
2. Type `/orchestrate <goal>`. The session becomes the planner and gets the tools `spawn_worker`, `message_worker`, `review_verdict`, `promote_worker`, `demote_worker`, `migrate_worker`, `merge_worker`, `close_worker`, `set_goal` and `roster`. A board and a wake bridge run inside Claude. Typing `/orchestrate` again in the same session re-attaches to the run. With no goal, the first prompt you type becomes the run's goal (its first line, clipped to 120 characters) and is saved on the run; a Drove wake, a slash command or an empty prompt never is, and an existing goal is never replaced.

**Claude Code without the mod, or Codex.** From any herdr pane:

```sh
drove plan --kind claude    # Claude Code without the mod
drove plan --kind codex     # Codex; add --goal "..." to either for a first instruction
drove plan --from-cairn DROVE-12   # the goal is that Cairn task's title and body
drove plan --next DROVE            # the goal is the top task `cairn next --project DROVE` ranks
drove plan --from-cairn LAB-21     # the goal is a Lab subject; its open todos become the workers
drove board                 # in a spare pane: live seats, states and what needs a human
drove board --web           # the same board in a browser, read-only
```

`drove plan` creates a run, records the pane as the planner pane and replaces itself with `claude` or `codex`, with Drove's MCP server, guard hooks and role text attached.

A run started without `--goal` takes the first prompt you type to the planner as its goal, the same way, in the mod and in the planner's `user-prompt-submit` hook. The planner keeps the goal true afterwards: `set_goal` (`drove goal`) replaces it with one plain line of what the run is doing now when it is missing or vague, or when your ask moves on, and records a `goal.set` event. The board header (terminal and web) shows it. When the Claude mod is re-attached, a goal only the mod holds is written to the run, and a run goal fills an empty mod goal.

`--from-cairn REF` and `--next PROJECT` start a run from a Cairn task. The planner's first prompt carries the task's title and body and says it is the run's goal task, which the planner holds; Drove stores the ref as the run's `cairn`. The task must exist and be open (a done or cancelled one is refused), and `--goal` cannot be combined with either flag. `drove down` then writes a summary note on that task: the seats, which are closed, their branches and what is still open (best effort: a failure to write it never holds the run up).

`--from-cairn LAB-21` starts a run from a Lab subject. Drove reads it with `cairn --instance croft subject show LAB-21 --json` (set `labInstance` in `~/.drove/config.json` for another instance). The run's goal is "LAB-21: <title>" and `run.cairn` is `LAB-21`. The planner's first prompt carries the subject's write-up and its open todos as refs and titles (done and cancelled ones are left out), and tells it to run one worker per todo, each spawned with the todo's own ref, to note progress with `cairn --instance croft subject note LAB-21 "…" --kind finding|decision`, and never to close the subject, since closing it needs your conclusion. `drove down` writes its summary with `subject note`. `--next PROJECT` is unchanged.

## How a worker's life goes

1. **Spawn.** The planner calls `spawn` with a seat name, a kind, a Cairn ref and a brief. Drove first checks with `cairn show` that the task exists and is open, and refuses one that is done or cancelled (if `cairn` is missing or errors, it carries on and says it did not check). Drove opens a pane, waits for the shell prompt, then starts the agent. If the agent does not appear it resets the pane and tries once more. The brief is sent after the agent is up, never as a launch argument. For a Codex worker the worker role text rides at the top of the brief, and the agent runs under a `CODEX_HOME` Drove keeps for the run (see State and config).
2. **Work.** A Claude worker gets its worktree from `claude --worktree` (branch `worktree-<seat>`). A Codex worker gets one made by Drove (branch `drove/<seat>`). The worker never pushes; a hook denies it.
3. **Report.** The worker calls its `report` tool: `done`, `question`, `blocked`, `promote` or `progress`. Anything but `progress` wakes the planner.
4. **Verdict.** The planner reads the diff and sends `approve` or `changes`. After an approve the worker commits its own paths and reports `done` again.
5. **Merge, then close.** The planner merges with `drove merge <seat>` (see "The merge gate" below), then closes the seat. A Claude seat is closed by closing its pane, never with `/exit`; Drove releases the worktree lock Claude leaves behind. Codex gets `/quit` first. A worktree is removed only on request and only when its branch is merged.

### The merge gate

The planner never merges a worker's branch by hand: the guard denies `git merge` of a `worktree-*` or `drove/*` branch with "use drove merge <seat>: it runs the checks first". `drove merge <seat>` (the planner's `merge` tool, the mod's `merge_worker`) is the way in.

**Which checks.** The `checks` list in the repo's `.drove.json` (`{"checks": ["npm run typecheck", "npm test"]}`, run in order with `sh -c`; an empty list declares that there are none). Without one, the repo's own verify commands, as `drove spawn` already lists them in a worker's brief: the `typecheck`, `lint` and `test` scripts of `package.json`, else the `typecheck`, `lint`, `test` and `check` targets of its Makefile. A repo with none of these is refused until it declares some. The list is read from the main checkout (the base), not from the worker's branch, and run in the seat's worktree, so a branch cannot loosen its own gate; the human can still pass `--no-checks`.

**Local (default).** The seat's worktree must have no uncommitted changes (the checks would test what the merge does not carry). The main checkout must be on the run's base branch and clean. The checks run in the seat's worktree; the first failure refuses the merge and returns that check's output tail. When they pass, Drove merges `--no-ff` into the base with the message `merge: <the branch's last commit subject>` (`-m` overrides it). A conflict is aborted and refused, leaving the base untouched. The result is local and unpushed; the planner pushes when the work is done.

**`--pr`** (the repo needs a remote). Drove pushes the seat's branch to `origin` (never `production`, never forced), opens a pull request with `gh pr create` (title: the last commit's subject and the seat's Cairn ref; body: the commits, the Cairn ref, the run and seat), and reads `gh pr checks`. Failed checks refuse and name them. Checks still running, no check reported yet while the repo has workflows, or a review still required on GitHub return `pending: ... <PR URL>`: run `drove merge <seat> --pr` again later (it reuses the PR; do not poll). When everything is green it runs `gh pr merge` (`--squash` for one commit, else a merge commit), deletes the remote branch and fast-forwards the local base from `origin`. A repo with no CI counts as green only after the local checks pass (they run before anything is pushed); a repo with workflows whose PR shows no check ten minutes after it opened is treated the same way. A conflicting PR, requested changes and a `gh pr merge` that GitHub refuses are refused with the reason.

Every outcome is an event (`merge.passed`, `merge.refused`, `merge.pending`) and the last one shows on the seat's board line. `--no-checks` skips the local checks and is for the human, from their own terminal with `--run ID`: Drove refuses it inside a Drove session and the guard denies it to the planner.

A seat is an implementer unless the planner spawns it with a `role`; see "Reviewer and tester seats" below.

Planner messages are signed with a per-seat token. The signature covers the header fields that change what a worker does (`kind`, `to`, `run`, `model`, `effort`, `verdict`, `expects`) as well as the body, so editing any of them on a genuine message fails the check. A Claude worker with the mod marks a message that fails the check as unverified, and acts on a `promote` only when it verifies. A Codex worker's `UserPromptSubmit` hook (`drove guard user-prompt-submit`) runs the same check and, on a failure, hands Codex the same "not signed by your planner" notice as additional context and a warning, without blocking the turn. Text that follows a signed message in the same paste is shown under a "not signed by Drove" label.

`promote` changes a worker's model or effort, `demote` moves it back. `--model` is optional, so a Codex worker on Codex's default model can be promoted by effort alone. A Claude worker with the mod switches on its next request and is told its new model; otherwise, and for Codex, Drove restarts the agent with resume once it is idle.

A worker that hits its usage limit gets a `usage-limit` attention item and is never nudged. Drove sees it on the limit screen, and for Claude also through the `StopFailure` hook (`error: rate_limit` or `billing_error`), which keeps the item after the text has scrolled away, until the seat works again. The planner can then wait for the reset, close and respawn, or `migrate` the seat to the other kind: Drove stops the agent and starts the other kind fresh in the same worktree, without resume, with a handoff brief (the saved brief, the branch's commits, uncommitted changes, `git status` and the last three reports). The seat keeps its name, branch, token and Cairn task (Drove releases the old claim so the new agent can take it), and the roster records `migratedFrom`. The turn in flight is lost. A Claude seat moved from Codex runs in Drove's worktree with no `--worktree`, because Claude trusts a linked worktree through its main repo. If the new agent does not start, the seat goes back to its old kind, marked gone, and `drove up --seat` resumes the old session.

`drove down` saves every session id and stops the run (and, for a run started from a Cairn task, writes a summary note on that task, with the cost and rework totals and one line per seat). `drove up` resumes it, and `drove up --seat <seat>` relaunches one dead seat. After a crash or a reboot, `drove up` also adopts a run that is still `up` once its planner and seat panes are all gone; it refuses and names any pane that is still alive.

## Reviewer and tester seats

Review and testing can be seats of their own. They are optional: the planner reads the diffs itself unless a change is large or risky, touches security, or has logic it cannot easily check. Spawn one with `--role reviewer|tester --target <seat>` (the spawn tool's and the mod's `spawn_worker`'s `role` and `target`); a seat with no `--role` is an implementer, exactly as before. A reviewer or tester is a seat like any other: it takes one of the panes of the budget, and the planner closes it when it has reported.

| | `reviewer` | `tester` |
|---|---|---|
| For | reading another seat's diff against that seat's brief | writing and running tests for another seat's change |
| Worktree | its own, at the run base; it reads the target's worktree (`git -C <target worktree> diff <base>`, which holds uncommitted work) and the target's brief, both named in its brief | branched from the head of the target's branch, so the code under test is already there; Claude seats are fast-forwarded to it, Codex seats get a Drove worktree made from it |
| May change | nothing, except scratch files under `/tmp` | only its `--owns`, which defaults to `test/**`, `tests/**`, `**/*.test.*`, `**/*.spec.*` and `**/__tests__/**`; the planner can pass others |
| Guard | read-only: no `Edit`, `Write` or `apply_patch`, the planner's Bash rules (no writers, installs or scripts, no git that moves HEAD or a ref, no push, and `gh` reads only: `pr view|list|diff|checks|status`, `issue view|list`, `run view|list`, `gh api` GETs), with the repo's checks allowed: `npm test`, `npm run lint`, `typecheck`, `make test`, `tsc --noEmit`, `eslint`, `vitest`, `pytest`, `cargo test` and the like, without their `--fix`, `--write` or `-u` forms | the same owns guard as an implementer |
| Reports `done` with | `expects: review`: a recommendation (`approve` or `changes`), findings with file:line, most serious first, and the check results; the planner gives the verdict to the implementer | `expects: review`: the tests added, the output, and what they caught (defects with file:line and the failing test) |
| Then | the planner closes it; there is nothing to commit | the planner approves, it commits, and the planner merges its branch after the target's |

`--target` is required for both and names another seat of this run (a reviewer cannot be a target). A tester's target should have committed first: a tester branches from the committed head, and the spawn result warns when the target's worktree still holds uncommitted changes. `--owns` is refused for a reviewer. The role and target live on the seat, so `promote`, a restart, `up` and `migrate` keep them, and the board shows `R` or `T` beside a reviewer or tester while `drove roster` says `reviewer of <seat>`. Each role has one role text, the same for every seat of that role, so it caches; the target, its branch, worktree and brief file go in the brief's last line.

## Commands

| Command | Use |
|---|---|
| `drove plan [--kind claude\|codex] [--model M] [--effort E] [--goal TEXT \| --from-cairn REF \| --next PROJECT] [--run ID] [--detached [--json]]` | start a planner in this pane; `--from-cairn` makes a Cairn task the run's goal, `--next` the top task of a Cairn project; `--detached` opens a herdr workspace of its own instead and returns at once (see "Unattended runs") |
| `drove spawn <seat> --kind claude\|codex --cairn REF --brief TEXT\|- [--model M] [--effort E] [--base BRANCH] [--mcp NAME,NAME] [--plugins NAME,NAME] [--skills NAME,NAME] [--agents NAME,NAME] [--user-memory on\|off] [--user-hooks on\|off] [--role implementer\|reviewer\|tester --target SEAT] [--owns GLOB,GLOB] [--max-turns N] [--max-tokens N]` | open a worker and brief it; `--mcp`, `--plugins`, `--skills`, `--agents`, `--user-memory` and `--user-hooks` are under "Lean workers", `--role` and `--target` under "Reviewer and tester seats", `--owns` and the budgets under "Rules Drove enforces" |
| `drove send <seat> --kind message\|answer\|verdict [--verdict approve\|changes] [--expects review\|answer\|none] [--run ID] TEXT\|-` | send one control message; `--run` names the run when you send from outside it |
| `drove prompt <seat> TEXT\|-` | raw prompt into a seat of this run (guarded) |
| `drove promote <seat> [--model M] --effort E [--reason TEXT]` | change a worker's model or effort |
| `drove migrate <seat> --kind claude\|codex [--model M] [--effort E] [--reason TEXT]` | move a worker to the other kind in the same worktree, with a handoff brief |
| `drove init <dir> [--json]` | make a new git repo (branch `main`, one empty commit) in an empty or missing directory, then attach the run there; refuses a non-empty directory or an existing repo |
| `drove roster [--json] [--run ID]` | one line per seat; `--json` also gives the run's status, the planner pane's state and the latest report (see "Unattended runs") |
| `drove attention [--run ID \| --all] [--json] [--follow]` | what waits on a person, as data: dialogs, questions for the human, pane-budget requests, gone seats; `--follow` streams new and resolved items as JSON lines (see "Unattended runs") |
| `drove report [<run>] [--json]` | tokens, cost, wall time, time waiting on the human and rework, per seat and in total |
| `drove capture <seat> [--lines N] [--run ID]` | read a seat's recent output |
| `drove close <seat> [--remove-worktree]` | stop a worker and close its pane |
| `drove merge <seat> [--pr] [--squash] [-m MSG] [--run ID]` | integrate a worker's branch behind the repo's checks: they run in the seat's worktree, then the branch is merged `--no-ff` into the base; `--pr` goes through a GitHub pull request instead (see "The merge gate") |
| `drove board [--once] [--web [--port N]] [--run ID]` | live coloured board, the orchestrator mod's layout on your terminal's own background; one frame with `--once` or when piped; no colour when piped or with `NO_COLOR`; `--web` serves the same board read-only in a browser (see below); this repo's latest run unless `--run` or `DROVE_RUN` |
| `drove down [--run ID]` / `drove up [--run ID] [--seat SEAT] [--detached [--json]]` | stop and resume a run; the run may also be given as a bare argument, and `--detached` resumes it in a workspace of its own |
| `drove goal [--run ID] [--cairn REF] <text>\|-` | set the run's goal, one plain line of what it is doing now (the planner or the human; a worker is denied); `--cairn` also sets the run's goal task |
| `drove budget <n> [--run ID]` | raise the pane budget (the human only; agents are denied) |
| `drove guard <event>`, `drove mcp`, `drove mod attach\|bridge\|report` | entry points for hooks, MCP and the mod |

`drove board --web` serves the board to a browser on `127.0.0.1`, on a free port or the one you give with `--port N`. It prints a URL that ends in a token made at each start; open that URL. The page opens on a graph: the lead in the middle (or on top on a narrow screen) and each open seat a node around it, with its name, kind, model and effort, Cairn ref, current activity and a state colour; a seat that is working pulses, and one that asks, is blocked or has an attention item carries a "needs you" badge. When a new brief, report or verdict reaches the timeline, a dot labelled with its kind travels along the edge between the lead and the seat (nothing moves for entries already there at load, or with `prefers-reduced-motion`, where the edge only lights up). A Graph | Board switch next to the title goes to the terminal board's rows; the page remembers the choice. Click a seat (node or row) to open its detail: kind, model, effort, state and age, branch, worktree, Cairn ref and session id, and the last 40 lines of its pane as plain text, refreshed every few seconds while it is open. The commands to copy (`drove capture <seat>` and the worktree path) are shown as text. The timeline is one line per entry (time, icon, from → to, kind, summary clipped, newest first); click it, or press Enter or Space, to open its full text below, and again to close. Chips above it show only what needs you, only reports, or everything. The page follows your system's light or dark theme. It is read-only: only GET and HEAD are answered. A request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, whose `Origin` is another site, or that has no token, is refused. Ctrl-C stops it. Drove has no daemon, so the page is there only while the command runs.

`drove report [<run>] [--json]` is the number a factory improves against, for the latest run of this repo or the run you name, running or down (read only). Per seat, and for the run:

- **Tokens and cost**: input, cache reads, cache writes and output, summed once per message from the seat's own transcript (Claude: `~/.claude/projects/<worktree path with / and . as ->/<session>.jsonl`, found from the seat's session ids and its hook records; Codex: the rollout under the run's `codex-home/sessions`). Cost comes from a small price table in `src/report.ts` (Opus 5.5, Sonnet 5.5, Haiku 5.5 and the earlier 5.x models), priced per message on the model that wrote it; a model with no price (every Codex model) shows tokens only and marks the cost partial with a `+`. A seat whose transcript cannot be found is listed under the table. The planner has a row too, limited to the run's lifetime.
- **Wall time**: spawn to close, summed over a seat's incarnations (or to now for an open seat). **Human**: how long attention items that wait on the human (dialog, permission, trust, usage limit) stayed open.
- **Rework**: `chg/pro/dem/mig/rst` are the verdicts that asked for changes, promotions, demotions, migrations and restarts, counted from `events.jsonl`.

`drove --help` prints the same list. A planner normally uses the MCP tools `spawn`, `send`, `verdict`, `prompt`, `promote`, `migrate`, `close`, `roster`, `capture`, `run_report`, `set_goal` and `down`; a worker has one tool, `report`. They call the same functions as the CLI.

## Unattended runs

> **Unproven live.** This interface is built and tested against a fake herdr, not yet against a real herdr server and a job that wakes on its own. Every statement about a live run below is a design claim until the Bothy proof (DROVE-95) has run it. The JSON shapes are meant to stay stable; the proof may still change them.

A job outside herdr (cron, a webhook, a chat command; Bothy is the first) can start a run, watch it, hear what needs a person, and resume it, using four commands and no pane.

**Start.** `--detached` makes Drove open its own herdr workspace for the run and start the planner in it, then return at once:

```bash
drove plan --from-cairn DROVE-5 --detached --json     # the goal is a Cairn task
drove plan --next DROVE --detached --json             # the top task of a Cairn project
drove plan --goal "Ship the widget" --detached --json
drove up --run drove-20261009-1042-a3f1 --detached --json   # resume a stopped or crashed run (the run may also be a bare argument)
```

It prints one JSON object (without `--json`, one sentence with the same facts):

```json
{
  "run": "drove-20261009-1042-a3f1",
  "repo": "/Users/me/drove",
  "status": "up",
  "workspace": "w2",
  "tab": "w2:t7",
  "planner": { "kind": "claude", "pane": "w2:p7", "name": "planner-a3f1", "model": "claude-opus-5-5", "effort": "high", "state": "working", "sessionId": "…" },
  "goal": "DROVE-5: Detach the planner",
  "cairn": "DROVE-5",
  "resumed": ["w-api"],
  "lost": []
}
```

`planner.state` is the seat state at return: `working`, `idle`, or `blocked` when the planner stopped on a startup dialog (then `planner.attention` has the reason). `resumed` and `lost` are there for `drove up`. The workers' tab opens in the same workspace, so the whole run is in one place in herdr.

**What it needs on the host.**

- A running herdr server that the command can reach: Drove asks it for its workspaces first and refuses with code `herdr-down` and nothing created when it cannot. It never starts the server (that is a person's session, and its panes are theirs to lose). `HERDR_SOCKET_PATH` names the socket when it is not the default; the command needs no herdr pane around it, so `HERDR_PANE_ID` is not read.
- `herdr` on `PATH`, Node 22.18 or newer, `git`, the planner's agent CLI (`claude` or `codex`) on `PATH` and signed in, and `cairn` for `--from-cairn` and `--next`. The workspace is opened without taking focus, in the repo's root.
- The same `DROVE_HOME` in every command that touches the run (the default is `~/.drove`).
- Drove never answers a dialog. A first launch in a folder may ask to trust it, a Claude planner on the development channel asks to confirm it, a Codex planner may ask to approve Drove's hooks: each shows as `planner.state: "blocked"` and as an attention item for a person to answer in the pane. Trust the repo and approve the hooks once, by hand, before leaving a job to run alone.

**What needs a person.** `drove attention` prints the same things the board shows red and the planner's wake lists under "Needs the human", as data:

```bash
drove attention --run ID --json          # one snapshot of one run
drove attention --all --json             # every run that is up
drove attention --run ID --json --follow # JSON lines: new and resolved items
```

A snapshot is `{"v":1,"at":"…","runs":["…"],"items":[…]}`; each item:

```json
{
  "id": "drove-20261009-1042-a3f1:w-api:trust:1",
  "run": "drove-20261009-1042-a3f1",
  "seat": "w-api",
  "kind": "trust",
  "text": "Claude is asking to trust the folder",
  "since": "2026-10-09T09:20:00.000Z",
  "answer": { "type": "pane", "pane": "w2:p9", "inspect": "drove capture w-api --run drove-20261009-1042-a3f1", "note": "Answer it in the pane. Drove never answers a dialog or an approval." }
}
```

| `kind` | What it is | `answer` |
|---|---|---|
| `dialog`, `permission`, `trust`, `hook-trust`, `channel-confirm`, `codex-version-mismatch` | a seat (or the planner, `seat: "planner"`) is stopped at a dialog or an approval | `pane`: the pane id, and a command that reads the screen |
| `asking` | a worker asked a question in its pane (the mod's status line carries it) | `pane` |
| `question`, `blocked`, `promote` | a worker's report addressed to the human (`for: human`) that is still unanswered | `command`: `drove send <seat> --run ID --kind answer <answer>` (`-` reads stdin) |
| `pane-budget` | a spawn the pane budget refused (a 6th pane) | `command`: `drove budget <n> --run ID` |
| `gone` | a seat's pane is gone (or the planner's, while the run is `up`) | `command`: `drove up --run ID --seat SEAT` (the planner: `drove up --run ID --detached`) |
| `usage-limit` | the agent hit its plan limit | `pane`: it resumes when the limit resets |
| `stalled`, `idle-without-report`, `budget`, `pending-delivery` | the planner's to handle | `planner`: nothing for a person unless the planner asks |

`answer.type` is `command` (an exact command; `<answer>` is yours to fill in), `pane` (answer it where the agent is; Drove will not), or `planner`. Every item is something Drove itself calls "needs the human" or "needs you", so a forwarder can filter on `kind`.

- **`id` is stable** for as long as the item is open, across polls and across processes; it is `<run>:<seat>:<kind>:<n>`, where `n` counts the episodes of that same thing. An item that went away and came back is a new `id`. `since` is when it began and does not move.
- **`--follow`** prints one JSON line per change, `{"v":1,"event":"new"|"resolved","at":"…","item":{…}}`, and polls every 3 seconds. It starts by announcing everything already open as `new`, so a restarted follower repeats those: dedupe on `id`. A `resolved` line carries the item as last seen. It stops on Ctrl-C or SIGTERM. Drove has no daemon: a snapshot is computed when you ask, and nothing is watched in between.
- **What "resolved" means.** A dialog is resolved when the pane is no longer at it; a report for the human when the worker is no longer owed an answer (you answered it, or it sent a later report); a pane-budget request when the budget is raised, a slot frees or the seat starts; a `gone` item when the pane is back.

**What the run is doing.** `drove roster --run ID --json` is the status read: `run.status` (`up` or `down`), `seats[]` (each with `state`, `owes`, `lastReport`, `attention`), `planner.state` (`idle`, `working`, `blocked`, `done`, `unknown`, `gone`, `unreachable` when herdr could not be asked, or `down`), `lastReport` (the latest of any seat, with its `seat`) and `updatedAt`. A run that is `up` while `planner.state` is `gone` is a crash: resume it with `drove up --run ID --detached`.

**Resume.** `drove down` and a crash both leave the run resumable: `drove up --run ID --detached` reopens the seats with their saved sessions, then the planner with its own, in a new workspace. A run that is still `up` is resumed only when none of its panes is alive.

**Failure.** With `--json`, a failure is one JSON object on stderr, `{"ok":false,"code":"herdr-down","error":"…"}`, and the exit status is 1; bad usage exits 2. Codes a job should expect: `herdr-down` (no server), `herdr` (herdr refused a step), `no-run`, `no-task` and `task-closed` (Cairn), `not-a-repo`, `not-down` (the run still has a live pane), `usage`. A start that cannot finish closes the workspace it opened and marks a new run `down`, so `drove up --run ID --detached` can try it again.

**Not proven.** A real herdr server opening a workspace without a client attached; a planner started by `agent start` in a workspace nobody is looking at; the wake reaching it there; and the shapes above under a real poller. Until then treat a stuck start as a bug to report, not a state to build on.

## Rules Drove enforces

- The planner does not edit code or run builds; a guard hook denies it. It may still write inside its Claude Code session scratchpad (`/tmp/claude-*/…/scratchpad`), with `mkdir`, `touch`, `tee`, `cp`, `mv`, `rm` or a redirect, and nowhere else. Workers never push, and nobody pushes to `production`. The planner handles GitHub through `gh` (PRs, issues, releases, workflow runs, labels, `repo create --private`); deletions, secrets and variables, repo settings, public repos and `gh api` writes stay with the human, and a `gh` write that names `production` as a base, target, ref or head is denied. A worker may run `claude plugin test`, and no other `claude` command.
- A worker spawned with `--owns` (the spawn tool's `owns`) may change only files matching those globs, relative to its worktree: `*` stays in one directory, `**` crosses directories, `{a,b}` alternates, and a glob that names a directory owns what is under it (`docs` owns `docs/a/b.md`). The guard hook denies the worker's `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and `apply_patch` outside them, and shell redirects and the file writers it can read (`rm`, `mv`, `cp`, `tee`, `touch`, `mkdir`, `sed -i`, `chmod`, `dd of=` and the like), with "this file is outside the paths your brief gives you (…); ask the planner with the drove report tool". The globs live on the seat, so `promote`, a restart and `up` keep them; a seat with none is unchanged. It is a seatbelt against mistakes, not a sandbox: a script or an interpreter that writes elsewhere is not parsed, a target with a variable in it is not checked, and the temp directories and Claude's per-project memory stay writable.
- A reviewer seat (`--role reviewer`) is read-only: the guard hook denies its `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and `apply_patch`, and gives its Bash the planner's rules, so file writers, installs, scripts, a `git` that changes the repo and every `gh` write (the ones the planner may run included) are denied, with the repo's test, lint and typecheck commands allowed. Scratch under the temp directories stays writable, except a worktree that itself sits under them. Like `--owns`, it reads arguments and is a seatbelt, not a sandbox: a test still runs the repo's code.
- A worker spawned with `--max-turns N` (or the `maxTurns` setting, for every worker) is flagged at its Nth turn, counted as one Stop hook each, so a long autonomous turn counts once. `--max-tokens N` bounds the tokens the model processed (input, cached input and output), read from the agent's own transcript: the path Claude's hooks report, or the rollout Codex writes under the run's `codex-home/`. At the limit the board shows a `budget` attention and the worker is sent one notice asking it to report `progress` or `promote` and stop. Drove does not kill it; the planner decides.
- At most 5 worker panes. A 6th needs the human's yes (`drove budget 6`, or a dialog in the mod).
- Drove never answers a dialog an agent shows. It reports it on the board instead.
- Drove never edits `~/.claude`, `~/.codex` or `~/.tmux.conf`, and never writes `AGENTS.md` or `CLAUDE.md` into a repo. Permissions are set per launch.
- Several runs can be open at once, for example one per herdr workspace. herdr agent names are shared across the server, so Drove names each agent `<seat>-<run tag>`. Two runs of one repo share the worktree folder, so a spawn that would reuse a seat another run still holds is refused.

## State and config

State lives in `~/.drove` (`DROVE_HOME` overrides it): one folder per run with `roster.json`, `events.jsonl`, a `codex-home/` and a folder per seat holding its token, its report file and its launch spec. `codex-home/` is the `CODEX_HOME` Drove gives Codex workers: Drove writes its `config.toml` (the MCP server, repo trust and hook trust) and `hooks.json`, and symlinks your `auth.json`, `AGENTS.md` and skills into it, so the launch line stays short and Codex asks no hook-review question. Your own `~/.codex` is read, never written. Optional settings go in `~/.drove/config.json`: `plannerModel`, `workerModel`, `promotedModel`, `plannerEffort`, `workerEffort`, `budget`, `humanName`, `codexWorkerSandbox`, `codexBypassHookTrust`, `claudeChannel`, `briefVia`, `labInstance` (the Cairn instance that holds Lab subjects, `croft` by default), `maxTurns` (a default turn budget for every worker; unset by default) `workerEnv` (extra environment variables for worker launches, such as `{"MY_FLAG": "1"}`), and `workerPorts` and `workerCopy` (see "Isolating workers"). Defaults are in `src/commands.ts`.

### Lean workers

A worker loads your whole Claude setup unless you trim it: every MCP server, Claude in Chrome, every enabled plugin, your skills, your agent types, your own memory files and the hooks in your `settings.json`. Each trim has a run-wide key in `~/.drove/config.json` and, for a Claude worker, an option on one spawn (`drove spawn`, the planner's `spawn` tool, or the mod's `spawn_worker`). The planner chooses the options for each worker: its role text has a short "Lean spawns" paragraph that says what a worker loads under your config and lists your MCP server, plugin, skill and agent names, read from your Claude and Codex files (names only, never written).

| A worker loads | Run-wide key | Per spawn | Default | Saves per worker |
|---|---|---|---|---|
| your MCP servers | `workerMcp`: a list of names | `--mcp a,b` / `mcp` | all of them | the tools of each server left out |
| Claude in Chrome | the same list: a lean worker runs `--no-chrome` unless the list names `claude-in-chrome` | the same option | loaded | about 2.2k tokens |
| plugins and mods | `workerPlugins`: a list of names, with or without `@marketplace` | `--plugins a,b` / `plugins` | every enabled one | about 0.2k tokens |
| your memory files | `workerUserMemory`: `false` to leave them out | `--user-memory on\|off` / `userMemory` | loaded | about 5.3k tokens |
| skills: yours, your commands and your claude.ai ones (Claude); the skills linked into the run's Codex home (Codex) | `workerSkills`: a list of names; `[]` loads none | `--skills a,b` / `skills` (Claude) | all of them | about 5k tokens with `[]` (up to about 6.5k with the claude.ai ones named), about 0.1k per skill left out |
| your agent types (`~/.claude/agents`) | `workerAgents`: a list of names; `[]` hides all of yours | `--agents a,b` / `agents` | all of them | about 2.3k tokens for 28 agents |
| the hooks in your `settings.json` | `workerUserHooks`: `false` to leave them out | `--user-hooks on\|off` / `userHooks` | run | about 2.8k tokens of hook output; with it your skills, agents and commands (see below), about 10k |

- Lists add up: a worker gets the run's list plus its own. A list on a spawn makes that worker lean even when the config key is unset, and `[]` means Drove's server (or Drove's mod) alone. Left out, the run's setting decides, and with neither set nothing is trimmed.
- `userMemory` on a spawn wins over `workerUserMemory`, in both directions: `true` loads your memory files for one worker of a lean run, `false` leaves them out of one worker of a normal run. Memory files are your `~/.claude/CLAUDE.md` and any `CLAUDE.md` in the folders above the repo; the repo's own files always stay.
- The options belong to the seat, so `promote`, a restart, `up` and `migrate` keep them. A name that matches nothing you have is reported in the spawn result, and the worker runs without it.
- Skills (Claude): the names are the folders in `~/.claude/skills`, the files in `~/.claude/commands`, and your claude.ai skills as `anthropic-skills:<name>` (a name without the prefix matches too). A skill the list leaves out is switched off for that worker only, and `[]` starts it with `--disable-slash-commands`, which drops every skill including the plugin and bundled ones. Plugin skills follow `workerPlugins`; Claude's own bundled skills (`/debug`, `/simplify`) stay, because switching them off made the first request bigger (checked on Claude Code 2.1.296). `workerSkills` was Codex-only before; set today, it now trims Claude workers too.
- Agents: an agent the list leaves out is hidden from the worker's Agent tool with a `permissions.deny` rule `Agent(<name>)`. Claude's built-in agents (`Explore`, `Plan`, `general-purpose`), plugin agents and the repo's own `.claude/agents` stay.
- User hooks: Claude has no switch for the hooks in your `settings.json` alone (`disableAllHooks` also turns Drove's own off). The one lever is to start the worker without the `user` setting source, which Drove does with `--setting-sources project,local`. That also takes away what Claude reads from the same place: your own skills, agents and commands (so `workerSkills` and `workerAgents` have nothing left to trim) and your user-scope MCP servers. Drove puts back what it can: your `settings.json` minus its hooks (env, permissions, plugins, the bypass consent) goes into the worker's own settings, your user-scope MCP servers go into its `mcp.json` (an allowlist still narrows them), and `CLAUDE.md` is untouched, because memory has its own switch. Project and local hooks, and the hooks of the plugins you leave enabled, stay. For Codex the key leaves your `hooks.json` out of the run's `CODEX_HOME`, and Drove's own hooks stay.
- Drove's own report tool, `mcp__drove__report`, is the worker's one report tool, and Drove's own mod is never trimmed.
- Codex: `mcp` works per seat, and `workerSkills`, `workerUserMemory` and `workerUserHooks` apply to the run. A Codex worker reads your `AGENTS.md` from its `CODEX_HOME`, which every seat of a run shares, and Codex has no per-launch switch for it (checked on Codex 0.162.0: `project_doc_max_bytes` only limits the repo's own `AGENTS.md`). So `userMemory`, `userHooks`, `plugins`, `skills` and `agents` on a Codex spawn change nothing, and the spawn result says so; set `workerUserMemory: false` or `workerUserHooks: false` for the whole run instead.

A run-wide setting, in `~/.drove/config.json`:

```json
{ "workerMcp": ["notion"], "workerPlugins": ["context7"], "workerSkills": ["cairn"], "workerAgents": [], "workerUserMemory": false }
```

One worker that needs a browser and your own coding rules, on top of that:

```sh
drove spawn w-ui --kind claude --cairn APP-12 --brief - --mcp claude-in-chrome --user-memory on
```

A mechanical edit can drop everything: `--mcp '' --plugins '' --skills '' --agents '' --user-memory off --user-hooks off`.

Codex workers run with approvals and the sandbox bypassed, like Claude workers with `--dangerously-skip-permissions`. Drove's guard hook still denies pushes. Set `codexWorkerSandbox` to `"workspace-write"` to turn that off.

### Isolating workers

A git worktree gives each worker its own files and branch. It does not give it its own ports, database or untracked config. These keys in `~/.drove/config.json` cover the common cases; each applies at launch, and the seat keeps its slot through restart, promote, `up` and migrate.

| Need | Key | What a worker gets |
|---|---|---|
| its own dev-server port | `workerPorts`: `{ "base": 4100, "stride": 10 }` | `PORT` (= base + slot × stride), `DROVE_PORT_BASE` (the same) and `DROVE_PORT_COUNT` (= stride) in its env, and a line in its brief. Each open seat takes the lowest free slot, so a closed seat's slot is reused. |
| its own database or paths | `workerEnv` values may use `{seat}`, `{run}`, `{slot}` and `{port}` | `DATABASE_URL=postgres://localhost/app_{seat}` becomes `app_w-api` for that seat. An unknown `{name}` is left as written and the spawn result says so. |
| your untracked config | `workerCopy`: globs relative to the repo root, such as `[".env", ".env.local"]` | Files git ignores that a worktree lacks, copied from the main checkout at spawn. An existing file is never overwritten, and a file git does not ignore is refused with a note, so a copy never shows up as a change. |

A container or VM per seat is not built; DESIGN's "Isolation" section says when it is worth it.

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
