# Changelog

All notable changes to Drove are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Drove borrows from [Strands Agents](https://github.com/strands-agents): evidence ledgers for what a run did, steering that reads a seat's tool calls, acceptance criteria a worker answers, and a loop that checks work before a person reads it. Most of this is about the planner's review: fewer rounds, and a record of why one was needed.

### Merge gate and checks (DROVE-122)
- New `drove checks <seat> [--fresh] [--run ID]`, the planner's `run_checks` tool and the mod's `run_checks`: runs the merge plan's checks in a seat's worktree and answers pass or fail per command with the failing output tail, the commit and whether the tree was clean. It never writes to the repo, and a worker cannot call it.
- Every run of the checks is a line per command in the run's `checks.jsonl`: seat, command, worktree, HEAD sha, `clean`, exit code, duration and the output tail. A `checks.ran` event and a `chk✓` / `chk✗` / `chk~` column on the boards show the last result at the seat's HEAD.
- The merge gate reuses a passing record when every command of the plan passed at the seat's exact HEAD on a clean tree (`checks reused: passed at <sha7> <time>`); a new commit, a dirty tree, a missing or failing record, an unreadable ledger line or `--fresh` runs them again.
- The gate merges (or, with `--pr`, pushes) exactly the sha it checked, and refuses with `head-moved` when the branch has moved since.

### Planner's review (DROVE-123, DROVE-126, DROVE-127, DROVE-131)
- New `acceptance` on spawn (`--acceptance TEXT`, repeatable) (DROVE-123): Given-When-Then criteria, numbered AC1…ACn in the brief, which the worker answers one by one in `criteria` of its done report (`{ id, met, evidence }`). The planner's wake shows them.
- Worker role texts are SOP-style MUST / MUST NOT / SHOULD / MAY lists (DROVE-123), the same text for every seat of a role.
- GoalLoop (DROVE-126): Drove checks an implementer's `done` report itself before the planner wakes, with `autoChecks` of the repo's `.drove.json` (else the merge plan). A failure goes back to the worker as a `changes` verdict with the failing command and its tail; the planner is woken on a pass, or after `autoCheckAttempts` (default 2) failures. `autoCheck: false` turns it off. Events `autocheck.passed` and `autocheck.failed`. A repo should give a fast `autoChecks`, because the default is the whole merge plan.
- Steering (DROVE-127): a tool ledger per seat, read from the agent's own transcript. R1 (the same shell command failing 3 times in a row) sends the worker one message; R2 (a done report with no check after the last edit) adds a line to the planner's view of the report. Config key `steering`; each nudge is a `steer.nudged` event.
- New `drove diagnose [<run>] [--json]` (DROVE-131): deterministic detectors (`scope-too-narrow`, `checks-failed-at-done`, `review-loop`, `no-acceptance`, `merge-conflict`, `ci-only-failure`, `brief-not-delivered`, `budget-hit`, `usage-limit`, `guard-thrash`, `steering`) name why a run needed rework and where the fix belongs: brief, role text, config, repo, planning or Drove.

### Seat limits and policy (DROVE-120, DROVE-128)
- New `maxMinutes` and `maxCost` per seat (`--max-minutes`, `--max-cost`; the spawn tool and the mod's `spawn_worker`): wall clock since spawn and transcript cost. At the bound the board shows a `budget` attention and the worker is sent one notice; Drove does not kill it.
- A `review-loop` attention after `reviewLoopLimit` (default 3) `changes` verdicts to one seat.
- New `runMaxCost` config key: one `run-budget` attention when the run's cost passes it.
- New `spawnPolicy` in `~/.drove/config.json` and the repo's committed `.drove.json` (DROVE-128): `fixed`, `choice`, `required` and `max` rules limit the settings the planner may give a worker. When both files set a rule, the narrower one wins. Both planners show the merged policy and any policy errors before spawning.
- Once a policy names `mcp`, `plugins`, `skills` or `agents`, those seat lists replace the run-wide worker trims instead of adding to them.
- The CLI enforces the policy on spawn, promote and demote (`model` and `effort`), migrate (`kind`), `drove owns` and seats relaunched by `drove up`, including the defaults each seat would use. Refusals have code `policy`; local and `--pr` merges that change `spawnPolicy` have code `policy-change` and require a human merge. `drove doctor` checks unknown keys, wrong types, empty choices, fixed values outside choices and maximums on non-number settings.

### Guard (DROVE-119, DROVE-121)
- A denial carries a stable rule id and is a `guard.denied` event in the run's `events.jsonl`; every denial text ends with `Next step:` (DROVE-121).
- A seat that meets one rule `guardThrash.count` times (default 3) within `guardThrash.minutes` (default 10) with no report raises a `guard-thrash` item for the planner.
- An explicit fail mode: when the guard itself fails, the planner and a reviewer seat are refused and other workers carry on, with the refusal recorded as `guard-error`.
- New `set_owns` tool and `drove owns <seat> --add|--set GLOBS` (DROVE-119) widen an open seat's `owns` mid-run; the guard reads `owns` from the roster at each call. A worker's Bash cannot write Drove's run state (rule `run-state`).

### Observability (DROVE-130, DROVE-121, DROVE-127)
- New `drove trace [<run>] [--json] [--otlp URL]` (DROVE-130): the run as an OpenTelemetry span tree, printed, as OTLP/JSON or posted to `/v1/traces`. The `otlpEndpoint` config key exports it after `drove down`.
- `drove report` gains guard denials by rule (`deny`), steering nudges by rule (`nudge`) and checks run and failed (`chk run/fail`) per seat and in total (DROVE-121, DROVE-122, DROVE-127).

### Fixes (DROVE-116, DROVE-124, DROVE-125, DROVE-136, DROVE-140, DROVE-142)
- Timed-out commands terminate their whole process group, escalating from SIGTERM to SIGKILL after 3 seconds; checks record `timedOut: true` in their ledger and outcome text while keeping exit 124 (DROVE-140).
- The mod's guard spawns in the repo and names a missing session cwd instead of failing obscurely; `close` refuses to remove the planner's own cwd (DROVE-116).
- A brief left as `[Pasted text]` in an idle agent's input is submitted with one Enter (DROVE-124).
- A brief longer than `briefPointerLines` (new config key, default 40) goes out as a signed pointer to the seat's `brief.md`, and a brief whose paste never reached the input is sent once more as that pointer (DROVE-136).
- `merge --pr` reuses an open PR, trusts a MERGED PR only when its head is the branch tip, retries the read after merging, and treats `gh` outages and empty JSON as pending (DROVE-125).
- `merge --pr` answers pending, not `push-failed`, when GitHub refuses the push with a 5xx or a network error, and shares one 300 s budget between its `gh` calls (45 s each) and the push, fetch and branch delete (90 s each), so a slow GitHub ends in `pending` before the mod's 600 s cap aborts `merge_worker`; the mod reports a merge it still had to cut off as pending too (DROVE-142).

## [0.4.0] - 2026-10-12

Drove becomes a small software factory: a merge gate that runs your checks before a worker's branch lands, reviewer and tester seats beside the implementers, and unattended runs that a job such as Bothy can start and watch. Workers also get more isolation (ports, env, copied files), a report of what a run cost, and runs that start from a Lab subject.

### The merge gate (DROVE-92, DROVE-105)
- New `drove merge <seat> [--pr] [--squash] [-m MSG] [--run ID]`, the planner's `merge` tool and the mod's `merge_worker`: a worker's branch is merged only after the repo's checks pass. Locally, Drove runs them in the seat's worktree (the `checks` list in the repo's `.drove.json`, else the `typecheck`, `lint` and `test` scripts or Makefile targets) and merges `--no-ff` into the base in the main checkout, which must be on the base and clean; a failure is refused with the failing check's output tail.
- `--pr` pushes the seat's branch to `origin` (never `production`), opens a PR with `gh pr create` from the commits and the seat's Cairn ref, and reads `gh pr checks`: pending returns the PR URL to call again, failed checks are refused by name, and green runs `gh pr merge` (`--squash` or a merge commit), deletes the remote branch and fast-forwards the local base. A repo with no CI counts as green only after the local checks pass.
- `merge.passed`, `merge.refused` and `merge.pending` events, and the last gate result on the seat's board line.
- The guard denies the planner a `git merge` of a seat branch (`worktree-*`, `drove/*`) with "use drove merge <seat>: it runs the checks first", and denies `drove merge --no-checks` to the planner; `--no-checks` is for the human.
- The planner's role text, in both planners, says to integrate with `drove merge <seat>` (`--pr` when the repo has a remote with CI), never a plain `git merge`.

### Reviewer and tester seats (DROVE-98)
- New `role` on spawn: `implementer` (the default, unchanged), `reviewer` or `tester`, with `--target <seat>` for the last two. It works in `drove spawn --role R --target SEAT`, the spawn tool (`role`, `target`) and the mod's `spawn_worker`, and is stored on the seat, so `promote`, a restart, `up` and `migrate` keep it. They are optional: a planner that never sets `role` sees no change, and the implementer's role text is the same text as before.
- A **reviewer** is read-only. The guard denies its `Edit`, `Write` and `apply_patch` (scratch under `/tmp` excepted) and gives its Bash the planner's rules, with the repo's checks allowed (`npm test`, lint, typecheck, `make test`, `tsc --noEmit`, `eslint`, `pytest` and the like, without `--fix`, `--write` or `-u`) only reading `git` and only reading GitHub (`gh pr view|list|diff|checks`, `gh api` GETs: none of the planner's `gh` writes). Its role text has it review the target's diff against the target's brief and report `done` with a recommendation, findings with file:line and the check results. It reads the target's worktree and stored brief, which its brief names.
- A **tester** branches from the head of the target's branch and writes tests only: `--owns` defaults to `test/**`, `tests/**`, `**/*.test.*`, `**/*.spec.*` and `**/__tests__/**`, which the planner can override. It reports the tests added and what they caught; the planner merges its branch after the target's. The spawn result warns when the target has uncommitted changes the tester's branch will not hold.
- One role text per role, the same for every seat of that role, so the prompt prefix still caches. The planner's role text, in the CLI and in the mod, has a "Reviewer and tester seats" paragraph: when to use them and that they take a pane of the budget.
- The board shows `R` or `T` beside a reviewer or tester, and `drove roster` says `reviewer of <seat>`.
- New env `DROVE_SEAT_ROLE` (set for a reviewer or tester only).

### Unattended runs (DROVE-95, DROVE-96)
- Proven live on 2026-10-12: Bothy's at-job ran `drove plan --from-cairn DROVE-110 --detached --json`; Drove opened a herdr workspace, started the planner in it, and the run finished on its own (DROVE-110). The herdr `workspace create --no-focus` flags below worked as written.
- New `--detached` on `drove plan` and `drove up` (DROVE-95): Drove opens a herdr workspace of its own for the run, through its herdr adapter (`herdr workspace create --no-focus`), starts the planner in its root pane and returns at once, so a job outside herdr needs no pane. It works with `--goal`, `--from-cairn REF`, `--next PROJECT` and `drove up --run ID` (the run may also be a bare argument). With `--json` it prints the run id, the workspace, the planner pane and the planner's state; a planner stopped at a startup dialog is reported as `blocked`, not as a failure. When no herdr server is reachable it refuses with `herdr-down` and creates nothing: Drove never starts the server. A start that fails closes its workspace and puts a new run back `down`.
- New `drove attention [--run ID | --all] [--json] [--follow]` (DROVE-96): the board's needs-a-person items as data. Each has a stable `id` (across polls and processes, new per episode), `run`, `seat`, `kind`, `text`, `since` and `answer` (the exact command, or "answer in the pane"). It covers seat dialogs and approvals, workers asking in their pane, reports addressed to the human, pane-budget requests (a 6th pane), gone seats, and the planner's own dialog or absence. `--follow` prints `new` and `resolved` items as JSON lines.
- A spawn the pane budget refuses now records an `attention` event (`reason: pane-budget`), so the request outlives the planner's dialog.
- `drove roster --json` also gives `planner.state` (whether the planner pane is alive), `lastReport` (the latest of any seat) and `updatedAt`.
- `drove send` takes `--run ID`, for an answer sent from outside the run's folder. With `--json`, a failure of `plan --detached`, `up --detached` or `attention` is one JSON object on stderr.
- The README has an "Unattended runs" section and DESIGN a §14 on the interface and what it needs on the host.

### Isolation beyond a worktree (DROVE-93)
- New `workerPorts: { base, stride }` config key: each open seat takes the lowest free slot and launches with `PORT` (= base + slot × stride), `DROVE_PORT_BASE` and `DROVE_PORT_COUNT` (= stride). A closed seat's slot is reused, and the slot is kept through restart, promote, `up` and migrate.
- `workerEnv` values may use `{seat}`, `{run}`, `{slot}` and `{port}`, filled per seat at launch; an unknown placeholder is left as written and the spawn result says so.
- New `workerCopy` config key: globs of files git ignores (such as `.env`) that are copied from the main checkout into a worker's worktree at spawn. It never overwrites a file and refuses a file git does not ignore, with a note.
- The brief footer gives a worker its ports and the files copied for it, only when set.
- DESIGN has an "Isolation" section: what a worktree isolates, what these keys add, and when a container or VM per seat is worth it (not built).

### Run reports (DROVE-106)
- New `drove report [<run>] [--json]` and planner tool `run_report`: tokens (input, cache read, cache write, output), cost, wall time, time waiting on the human, and rework (verdicts with changes, promotions, demotions, migrations, restarts), per seat and for the run. Tokens come from the seat's Claude transcript or Codex rollout; cost from a small price table (Opus, Sonnet and Haiku 5.x), tokens only for a model without a price; seats whose transcript is not found are named.
- The summary note `drove down` writes on the run's goal task now carries the totals and one line per seat.
- The `control.sent` event of a verdict now records the verdict (`approve` or `changes`); older events are read from the report that followed.

### Runs from a Lab subject (DROVE-94)
- `drove plan --from-cairn LAB-n` starts a run from a Lab subject, read with `cairn --instance croft subject show LAB-n --json`. The goal is "LAB-n: <title>" and `run.cairn` is `LAB-n`. The planner's first prompt gives the write-up, the open todos (closed ones omitted) and the rules: one worker per todo spawned with the todo's own ref, progress noted with `subject note`, the subject never closed by the run.
- New `labInstance` config key (default `croft`) names the Cairn instance that holds Lab subjects.
- `drove down` writes its summary with `cairn --instance <labInstance> subject note` when the run's `cairn` is a LAB ref. `--next PROJECT` is unchanged.

### Leaner workers: skills, agents and your settings hooks (DROVE-91)
- `workerSkills` now trims Claude workers too (it was Codex-only): a worker loads only the skills you list of your own `~/.claude/skills`, `~/.claude/commands` and claude.ai skills, and `[]` starts it with `--disable-slash-commands`. Plugin skills follow `workerPlugins`. If you already set `workerSkills` for Codex, Claude workers now follow it too.
- New `workerAgents` config key: your own agent types (`~/.claude/agents`) the list leaves out are hidden from a Claude worker's Agent tool; the built-in agents stay.
- New `workerUserHooks: false` config key: a Claude worker starts without the `user` setting source (`--setting-sources project,local`), so the hooks in your `settings.json` do not run in it, and neither do your own skills, agents and commands, which Claude reads from the same place. Your settings (env, permissions, plugins) and user-scope MCP servers are handed over by Drove, and Drove's own hooks stay. A Codex worker leaves your `hooks.json` out of the run's `CODEX_HOME`.
- A spawn can set each one for one worker: `skills` (`--skills a,b`) and `agents` (`--agents a,b`) add to the run's lists and make that worker lean even when the key is unset, and `userHooks` (`--user-hooks on|off`) overrides `workerUserHooks`. They work in `drove spawn`, the spawn tool and the mod's `spawn_worker`, and a promote, restart, `up` or migrate keeps them. They are Claude-only per seat: a Codex seat follows `workerUserHooks`, and the spawn result says so.
- The planner's "Lean spawns" text names the new options and lists your skill and agent names (read from your Claude folders, names only).

### Running Drove on another machine (DROVE-97)
- New `drove doctor [--json]`: checks Node 22.18+, git and the repo's remote, herdr and its server (listed, never started), `claude` (at least 2.1.296) and `codex`, `gh` and its sign-in, `cairn` and one read, `DROVE_HOME`, and the mod's `nodePath`. Each check is `ok`, `warn` or `fail` with a one-line fix; the exit status is 1 when one fails. The planner and workers may run it.
- README: "Running Drove on another machine" (install, Cairn sign-in, herdr on a headless host, unattended starts, how reports come back, and a client-project checklist).

### Planner (DROVE-104, DROVE-107)
- The run's goal is the planner's to keep: new `drove goal [--run ID] [--cairn REF] <text>|-` and a `set_goal` tool (`mcp__orchestrator__set_goal` in the mod) set `run.goal` (and optionally `run.cairn`), record a `goal.set` event the timeline shows, and update the mod's goal. The planner role text says when: the goal is missing or vague, or the human's ask moved on. On restore the mod writes a goal only it holds to the run, and an empty mod goal takes the run's; the bridge now follows a changed run goal (DROVE-107).
- The planner handles GitHub itself through `gh`: PRs (all), issues, releases (`create`, `edit`, `upload`), workflow runs, labels, and `repo create --private|--internal`, `clone`, `fork`, `sync`. Deletions, transfers, secrets and variables, repo `edit`/`rename`/`archive`, public repo creation and `gh api` writes stay with the human, and any `gh` write naming a `production` branch (`--base`, `-B`, `--target`, `--ref`, or the head of `pr create`) is denied. Worker rules are unchanged (DROVE-104).

### Fixes: a working seat is not idle, and idle-without-report is the planner's (DROVE-108)
- A seat whose last hook is a prompt with no `Stop`, `StopFailure` or new `SessionStart` after it is **working**, whatever herdr says. herdr flips a busy Claude seat to idle after a prompt is typed into it, and the old 10 s hook window then read it as idle and raised `idle-without-report` every few minutes. The open turn is trusted while the seat shows life (the prompt or the transcript's last write is under 5 minutes old, `OPEN_TURN_QUIET_MS`); an interrupted turn fires no `Stop`, so one that has gone quiet is read as idle again. A seat that owes an answer or a review counts only a prompt that came after its report.
- What the planner handles (`idle-without-report`, `stalled`, `budget`, `pending-delivery`) is no longer "needs you": not an item of `drove attention` (so a forwarder such as Bothy gets only a person's items), not a "needs you" badge on the web board, not under "Needs the human" in the planner's wake (it has its own "For you to act on" lines), and its timeline row is a muted `notice` to the planner, not an `attention` row addressed to the human. The one list is `isForHuman` in `mod/hooks/roster.ts`. The planner still reads these in `drove roster`.
- A `message` or `answer` the planner sends after a seat's question or blocked report, or a `verdict`, clears what the seat is owed (`owes`) when it is delivered, not only when it goes through `drove send`. A report that arrived while the answer was being typed keeps its own debt.
- Wording: the planner owes the seat, so the planner's board says "waiting for your answer" (or review), `drove roster` says "waiting for your review", and `drove board` and the web board, which a person reads, say "waiting for the planner".
- The replay test (`test/idle-replay.test.ts`) feeds two seats of run `seal-20261011-2029-c080` through the real watcher from that run's `events.jsonl`, `hooks.jsonl` and transcript write times.

### Fixes: an approved permission clears needs-input (DROVE-109)
- A `permission_prompt` notification (or a Codex permission request) used to hold the seat at **needs-input** until a `Stop`, a new prompt or a new session. No hook fires when the permission is approved, so with herdr reporting idle a seat that had gone on stayed needs-input until its next `Stop`. It is now also cleared by a transcript write more than 2 s after the notification (`ASK_TRANSCRIPT_GRACE_MS`): a seat that is waiting for an approval writes nothing. The same transcript mtime the open-turn check reads, no new hook: a `PostToolUse` hook would spawn a process on every tool call of every seat.
- The replay test (`test/permission-replay.test.ts`) runs the real watcher over a notification, transcript writes and no `Stop`.

### Fixes: `drove down` closes a detached run's workspace (DROVE-111)
- A detached start records `run.workspace`; `drove down` clears it and closes that herdr workspace with the run, so a detached run leaves nothing open.

## [0.3.0] - 2026-10-11

Leaner workers the planner trims per spawn, a more reliable `/orchestrate`, and `drove init` for starting a goal in a new repo.

### The mod's /orchestrate
- `/orchestrate <goal>` checks that the goal (and each worker report) reached the planner: it retries once, then toasts and sends it with your next prompt, also after a reload or restart; it names the repo it attached to, asks before attaching when a shell `cd` moved the session out of where it started, and takes `/orchestrate --repo <dir> [goal]` to attach to (or, with no open workers, switch to) another repo.

### Lean spawns
- A lean Claude worker (`workerMcp` or `--mcp` set) starts with `--no-chrome`, so Claude in Chrome's 22 tools are not loaded. Name `claude-in-chrome` in the list to keep it.
- A Claude worker no longer gets a second report tool from the mod: `mcp__drove__report` is the one.
- New `workerPlugins` config key: a Claude worker loads only the plugins and mods you list, plus Drove's own mod.
- New `workerUserMemory: false` config key: a worker skips your `~/.claude/CLAUDE.md` and the `CLAUDE.md` files above the repo (Claude), and your `AGENTS.md` and `AGENTS.override.md` (Codex). It stays on by default.
- A spawn can trim one worker: `plugins` (`--plugins a,b`) adds to `workerPlugins` and makes that worker plugin-lean even when the key is unset, and `userMemory` (`--user-memory on|off`) overrides `workerUserMemory` for that worker. They work in `drove spawn`, the spawn tool and the mod's `spawn_worker`, and a promote, restart or migrate keeps them. They are Claude-only: Codex has no per-launch switch for your `AGENTS.md`, so a Codex worker follows `workerUserMemory` and the spawn result says so.
- The planner's role text has a "Lean spawns" paragraph: what a worker loads under your config, when to pass `mcp`, `plugins` and `userMemory`, and the MCP server and plugin names it can choose from (read from your Claude and Codex files, names only).
- A spawn reports a `plugins` name that matches no plugin you have enabled, as it already does for MCP servers.
- The README has a "Lean workers" section with a table of each switch, its default and what it saves.

### New repos and the planner scratchpad
- New `drove init <dir> [--json]`: makes a repo on `main` with one empty commit in an empty or missing directory, so a planner can start a goal that needs a new repo. It refuses a non-empty directory, an existing repo and a directory inside a repo. The guard allows it for the planner.
- The guard lets the planner write inside its Claude Code session scratchpad (`/tmp/claude-*/…/scratchpad`): `mkdir`, `touch`, `tee`, `cp`, `mv`, `rm` and redirects, when every target is inside one. Writes anywhere else, interpreters and unresolved variables stay denied; worker rules are unchanged.
- The planner's role text mentions `drove init <dir>` and attaching the run there.

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

[0.4.0]: https://github.com/montytorr/drove/releases/tag/v0.4.0
[0.3.0]: https://github.com/montytorr/drove/releases/tag/v0.3.0
[0.2.0]: https://github.com/montytorr/drove/releases/tag/v0.2.0
