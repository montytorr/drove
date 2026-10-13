# Guard rules

Drove's guard hook runs before every tool call of the planner and the workers, in Claude Code and in Codex. It keeps each agent in its lane: the planner plans, workers edit only their own paths, nobody pushes where they should not, and every refusal says what to do next. Alongside it sit signed messages, seat limits and steering. These are seatbelts against mistakes, not a sandbox. Back to the [README](../README.md).

## The planner

- The planner does not edit code or run builds. It may write only inside its Claude Code session scratchpad (`/tmp/claude-*/…/scratchpad`), with `mkdir`, `touch`, `tee`, `cp`, `mv`, `rm` or a redirect.
- It may not `git merge` a seat branch: that goes through [`drove merge`](merge-gate.md), and `--no-checks` is denied to it.
- It handles GitHub through `gh`: PRs, issues, releases (`create`, `edit`, `upload`), workflow runs, labels, and `repo create --private|--internal`, `clone`, `fork`, `sync`.
- Deletions, transfers, secrets and variables, repo `edit`/`rename`/`archive`, public repos and `gh api` writes stay with the human. A `gh` write that names `production` as a base, target, ref or head is denied.

## Workers

- Workers never push, and nobody pushes to `production`.
- A worker may run `claude plugin test`, and no other `claude` command.
- A worker's Bash cannot write Drove's run state (rule `run-state`).
- `drove budget` is the human's: agents are denied.

### Owned paths

A worker spawned with `--owns` (the spawn tool's `owns`) may change only files matching those globs, relative to its worktree:

- `*` stays in one directory, `**` crosses directories, `{a,b}` alternates.
- A glob that names a directory owns what is under it (`docs` owns `docs/a/b.md`).

The guard denies the worker's `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and `apply_patch` outside them, and shell redirects and the file writers it can read (`rm`, `mv`, `cp`, `tee`, `touch`, `mkdir`, `sed -i`, `chmod`, `dd of=` and the like).

The refusal says: "this file is outside the paths your brief gives you (…); if you need it, send a question report asking the planner to add it to your owns with the set_owns tool".

The globs live on the seat, so `promote`, a restart and `up` keep them. The planner widens or replaces them mid-run with `drove owns <seat> --add|--set` (the `set_owns` tool); the guard reads the roster at each call and the worker is told. A reviewer and an empty list are refused. A seat with no `owns` is unrestricted.

**Not a sandbox.** A script or interpreter that writes elsewhere is not parsed, a target with a variable in it is not checked, and the temp directories and Claude's per-project memory stay writable.

### Reviewer seats

A reviewer seat (`--role reviewer`) is read-only:

- No `Edit`, `Write`, `MultiEdit`, `NotebookEdit` or `apply_patch`.
- Its Bash gets the planner's rules: no file writers, installs or scripts, no `git` that moves HEAD or a ref, no push, and `gh` reads only (`pr view|list|diff|checks|status`, `issue view|list`, `run view|list`, `gh api` GETs). The planner's own `gh` writes are denied too.
- The repo's checks are allowed: `npm test`, `npm run lint`, `typecheck`, `make test`, `tsc --noEmit`, `eslint`, `vitest`, `pytest`, `cargo test` and the like, without `--fix`, `--write` or `-u`.
- Scratch under the temp directories stays writable, except a worktree that itself sits under them.

Like `--owns`, it reads arguments: a test still runs the repo's code. See [reviewer and tester seats](merge-gate.md#reviewer-and-tester-seats).

## Refusals and thrash

Every refusal is a `guard.denied` event with a stable rule id (`owns`, `push`, `herdr`, `run-state` and so on), and its text ends with `Next step:`.

A worker that meets the same rule three times in ten minutes without reporting raises a `guard-thrash` item for the planner, not the human; its next report clears it. `guardThrash` in `~/.drove/config.json` (`{"count": 3, "minutes": 10}`) changes the limits.

If the guard itself fails, the planner and a reviewer seat are refused (recorded as `guard-error`) and other workers carry on.

## Signed messages

Planner messages are signed with a per-seat token. The signature covers the body and the header fields that change what a worker does (`kind`, `to`, `run`, `model`, `effort`, `verdict`, `expects`), so editing any of them on a genuine message fails the check.

- A Claude worker with the mod marks a message that fails the check as unverified, and acts on a `promote` only when it verifies.
- A Codex worker's `UserPromptSubmit` hook (`drove guard user-prompt-submit`) runs the same check and, on a failure, adds a "not signed by your planner" notice and a warning, without blocking the turn.
- Text that follows a signed message in the same paste is shown under a "not signed by Drove" label.

A brief longer than `briefPointerLines` (default 40) goes out as a signed pointer to the seat's `brief.md`. A brief whose paste never reached the input is sent once more as that pointer.

## Limits

- **Pane budget.** At most 5 worker panes. A 6th needs the human's yes: `drove budget 6`, or a dialog in the mod (MCP elicitation in Codex).
- **Turns.** `--max-turns N` (or `maxTurns` for every worker) flags a worker at its Nth turn, counting one Stop hook each, so a long autonomous turn counts once.
- **Tokens.** `--max-tokens N` bounds the tokens the model processed (input, cached input and output), read from the agent's own transcript.
- **Time and cost.** `--max-minutes N` bounds wall clock since spawn, including time the seat was down. `--max-cost USD` bounds transcript cost using the [run report's price table](observability.md#prices); unpriced models never trip it.

At a limit the board shows a `budget` attention and the worker is sent one notice asking it to report `progress` or `promote` and stop. Drove does not kill it; the planner decides. The bounds survive promote, `up` and migrate.

- **Review loops.** After `reviewLoopLimit` (default 3) `changes` verdicts to one seat, a human `review-loop` attention asks to re-scope, promote or take over the seat. Approval, promotion, migration or closing clears it.
- **Run cost.** `runMaxCost` raises one durable human `run-budget` attention when the run's total cost passes the USD bound.

## Steering

Steering reads each seat's own transcript (the same one the token count uses) as a ledger of its tool calls, and two deterministic rules act on it.

| Rule | Trigger | Effect |
|---|---|---|
| R1 | the same shell command fails three times in a row | the worker gets one message: "Drove: `<cmd>` has failed 3 times with the same result. Change approach, or send a blocked or question report." At most once in ten minutes per seat. |
| R2 | a `done` report arrives with no check passed since the worker's last edit | the planner's view of the report gets "Drove: no check ran after the last edit (last edit …, last check …)"; the worker is told nothing |

A check here is any of the repo's `.drove.json` checks, package.json scripts or Makefile targets, or the usual test, typecheck and lint commands. Each nudge is a `steer.nudged` event, and `drove report` counts them per seat (`nudge`).

`steering` in `~/.drove/config.json` changes the limits, adds check commands, or turns it off:

```json
{ "steering": { "enabled": true, "repeatFailures": 3, "cooldownMinutes": 10, "checkCommands": [] } }
```

`"enabled": false` makes the watcher read nothing.

## What Drove never does

- It never answers a dialog an agent shows; it reports it on the board instead.
- It never edits `~/.claude`, `~/.codex` or `~/.tmux.conf`, and never writes `AGENTS.md` or `CLAUDE.md` into a repo. Permissions are set per launch.

DESIGN.md §6 has the full rule set and the shell parser behind it.
