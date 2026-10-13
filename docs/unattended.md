# Unattended runs

A job outside herdr (cron, a webhook, a chat command; Bothy is the first) can start a run, watch it, hear what needs a person, and resume it, with four commands and no pane: `drove plan --detached`, `drove roster --json`, `drove attention --json` and `drove up --detached`. The JSON shapes below are meant to stay stable. Back to the [README](../README.md).

A detached run has been driven end to end by a scheduled job: Drove opened a herdr workspace nobody was looking at, started the planner in it, and the planner worked its Cairn task to the end. Treat a start that gets stuck as a bug to report, not a state to build on.

## Attached or detached

An attached planner (`drove plan`, `drove up` without `--detached`) needs stdin and stdout connected to a terminal, in a fresh herdr pane. Drove refuses with `no-terminal` when there is none, and with `pane-in-use` when the pane already hosts another agent or another live run's planner.

From inside another agent (including Claude Code's `!` shell command), or from a job, use `--detached`.

## Start

`--detached` makes Drove open its own herdr workspace for the run (without taking focus, in the repo's root), start the planner in it, and return at once:

```bash
drove plan --from-cairn APP-5 --detached --json     # the goal is a Cairn task
drove plan --next APP --detached --json             # the top task of a Cairn project
drove plan --goal "Ship the widget" --detached --json
drove up --run drove-20261009-1042-a3f1 --detached --json   # resume (the run may also be a bare argument)
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
  "goal": "APP-5: Detach the planner",
  "cairn": "APP-5",
  "resumed": ["w-api"],
  "lost": []
}
```

- `planner.state` is the seat state at return: `working`, `idle`, or `blocked` when the planner stopped on a startup dialog (then `planner.attention` has the reason).
- `resumed` and `lost` are there for `drove up`.
- The workers' tab opens in the same workspace, so the whole run is in one place in herdr.

## What the host needs

- **A running herdr server the command can reach.** Drove asks it for its workspaces first, and refuses with `herdr-down` and nothing created when it cannot. It never starts the server: that is a person's session, and its panes are theirs to lose.
- `HERDR_SOCKET_PATH` when the socket is not the default. The command needs no herdr pane around it, so `HERDR_PANE_ID` is not read.
- `herdr` on `PATH`, Node 22.18+, `git`, the planner's agent CLI (`claude` or `codex`) signed in, and `cairn` for `--from-cairn` and `--next`.
- The same `DROVE_HOME` in every command that touches the run (default `~/.drove`).
- **Dialogs answered once, by hand.** Drove never answers a dialog. A first launch in a folder may ask to trust it, a Claude planner on the development channel asks to confirm it, and a Codex planner may ask to approve Drove's hooks. Each shows as `planner.state: "blocked"` and as an attention item. Trust the repo and approve the hooks before leaving a job to run alone.

### Claude folder trust

Claude workers start at the repo root (`claude --worktree <seat>`), so Claude Code must trust the repo root itself: accept the trust prompt once in the root. A trusted parent folder does not count: Claude Code 2.1.296 looks for the repo's canonical root, then walks up from its cwd only as far as the git root, so a trusted folder above the repo never trusts it.

Drove's preflight reads `projects["<root>"].hasTrustDialogAccepted` in `~/.claude.json` (`CLAUDE_CONFIG_DIR` moves it) for the exact canonical root, and only reads that file. A trusted parent folder alone gives the warning and `untrusted-repo`, as Claude would show the prompt.

- When the root is not trusted, `drove plan` prints a warning and a Claude `spawn` is refused with `untrusted-repo`. Codex workers are unaffected.
- The one-time fix: run `claude` in the repo root, accept the trust prompt, quit.
- If a worker still stops at the prompt (a file Drove could not read, another Claude version), the seat goes `blocked` with a `trust` attention item naming the root, and keeps its pane.
- Drove holds the brief and delivers it once the prompt is accepted in the pane and the worktree appears. When trust is given elsewhere instead, or the pane dies, Drove relaunches the seat once with the same name, branch and brief.

## What needs a person

`drove attention` prints, as data, what the board shows red and what the planner's wake lists under "Needs the human":

```bash
drove attention --run ID --json          # one snapshot of one run
drove attention --all --json             # every run that is up
drove attention --run ID --json --follow # JSON lines: new and resolved items
```

A snapshot is `{"v":1,"at":"…","runs":["…"],"items":[…]}`. Each item:

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
| `gone` | a seat's pane is gone (or the planner's, while the run is `up`) | `command`: `drove up --run ID --seat SEAT` (the planner: `drove up --run ID`, or `--detached`) |
| `usage-limit` | the agent hit its plan limit | `pane`: it resumes when the limit resets |
| `review-loop`, `run-budget` | a seat keeps getting `changes` verdicts, or the run passed `runMaxCost` | `review-loop`: `pane`, with a command that reads it: re-scope the seat, promote it or take it over ([guard rules](guard-rules.md#limits)) |

`answer.type` is `command` (an exact command; `<answer>` is yours to fill in) or `pane` (answer it where the agent is; Drove will not). A forwarder can filter on `kind`.

What the planner handles (`idle-without-report`, `stalled`, `budget`, `guard-thrash`, `pending-delivery`) is not listed here and not counted on the web board. The planner reads those in `drove roster` and under "For you to act on" in its wake.

- **`id` is stable** while the item is open, across polls and processes: `<run>:<seat>:<kind>:<n>`, where `n` counts the episodes of the same thing. An item that went away and came back gets a new `id`. `since` is when it began.
- **`--follow`** prints one JSON line per change, `{"v":1,"event":"new"|"resolved","at":"…","item":{…}}`, polling every 3 seconds. It starts by announcing everything already open as `new`, so dedupe on `id`. A `resolved` line carries the item as last seen. It stops on Ctrl-C or SIGTERM.
- **Nothing is watched in between.** A snapshot is computed when you ask.
- **Resolved means:** a dialog when the pane is no longer at it; a report for the human when the worker is no longer owed an answer; a pane-budget request when the budget is raised, a slot frees or the seat starts; a `gone` item when the pane is back.

## What the run is doing

`drove roster --run ID --json` is the status read:

| Field | Values |
|---|---|
| `run.status` | `up` or `down` |
| `seats[]` | each with `state`, `owes`, `lastReport`, `attention` |
| `planner.state` | `idle`, `working`, `blocked`, `done`, `unknown`, `gone`, `unreachable` (herdr could not be asked) or `down` |
| `lastReport` | the latest report of any seat, with its `seat` |
| `updatedAt` | when the roster last changed |

A run that is `up` while `planner.state` is `gone` has lost its planner: relaunch it with `drove up --run ID` (or `--detached`). `drove reports --json` reads the reports themselves in full.

## Stop and resume

`drove down` saves every session id and stops the run. For a run started from a Cairn task it writes a summary note on that task: the seats, which are closed, their branches, cost and rework totals, and what is still open. A failure to write it never holds the run up.

`drove up` resumes a run: the seats with their saved sessions, then the planner with its own. `drove up --seat <seat>` relaunches one dead seat.

**A lost planner.** If the planner exits or its pane changes agent session, reports stay pending (Drove checks the pane's session before pasting) and one `gone` attention names `drove up --run ID`. Live workers keep working.

`drove up` then adopts the run: it relaunches the planner and any missing seats and keeps live workers in their panes. A planner pane now hosting another session counts as gone. It refuses while the run's own planner session is still alive.

After a crash or a reboot the same applies: `drove up --run ID --detached` reopens the run in a new workspace.

## Failure codes

With `--json`, a failure is one JSON object on stderr, `{"ok":false,"code":"herdr-down","error":"…"}`, with exit status 1; bad usage exits 2. A start that cannot finish closes the workspace it opened and marks a new run `down`, so `drove up --run ID --detached` can try again.

| Code | Meaning |
|---|---|
| `herdr-down` | no herdr server answered; nothing was created |
| `herdr` | herdr refused a step |
| `no-terminal` | an attached `plan` or `up` has no terminal; use `--detached` |
| `pane-in-use` | the pane already hosts another agent or a live run's planner |
| `no-run` | no such run |
| `no-task`, `task-closed` | the Cairn task does not exist, or is done or cancelled |
| `not-a-repo` | the directory is not a git repo |
| `not-down` | the run still has a live pane |
| `untrusted-repo` | a Claude spawn in a repo root Claude Code does not trust |
| `no-worktree` | a Claude worker's worktree did not appear, or its pane is not inside it ([isolation](isolation.md#the-worktree)) |
| `policy` | the spawn, promote, migrate, `owns` change or `up` breaks the `spawnPolicy` ([lean workers](lean-workers.md#spawn-policy)) |
| `policy-change` | a merge changes `spawnPolicy`; a human must merge it |
| `head-moved` | a merge's checked commit is no longer the branch tip ([merge gate](merge-gate.md#check-evidence)) |
| `usage` | bad arguments |

DESIGN.md §14 covers the interface and what it needs on the host.
