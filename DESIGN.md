# Drove v1: design

Cairn DROVE-2 (parent DROVE-1). Date: 2026-10-09. Inputs: `spikes/codex-proof/RESULT.md` (CCS-48), CCS-47 findings, CCS-50, and the earlier Claude orchestrator mod. Brought up to date with `main` on 2026-10-10 (DROVE-36): where this file and the code disagree, the code is right. Refs such as DROVE-49 or CCS-48 are this project's own task ids in its Cairn tracker; they are cited for history, and nothing here depends on reading them.

Drove is a small cross-agent orchestrator on herdr. One **planner** plans, delegates, reviews diffs and merges. **Workers** write the code. Either side can be Claude Code or Codex: you choose the planner, and the workers are Claude Code or Codex under either one. A planner starts three ways: `/orchestrate` in Claude Code with the mod (§10), `drove plan --kind claude` without it, or `drove plan --kind codex` (§1). Both planners were seen working live (DROVE-49). Every agent runs in its own herdr pane, and each worker has its own git worktree.

Markers used below: **[proven]** was seen working in a spike or in the mod. **[docs]** is stated in official docs but not yet run by us. **[verify]** is a guess that a human-run launch must confirm before we rely on it.

## 0. Decisions taken (not reopened)

- No daemon. The planner's own Drove MCP server (stdio, lives as long as the planner session) is the event loop. It watches the worker outboxes and wakes the planner. As a fallback, pending reports also ride on every planner tool result.
- herdr is the only pane layer. One herdr tab per run for the workers, laid out as a grid, with a budget of 5 worker panes. A 6th needs the human's OK.
- Permissions are set per launch only. Drove never edits `~/.codex/config.toml`, `~/.claude/settings.json`, `~/.tmux.conf` or skills, and never writes `AGENTS.md` or `CLAUDE.md` into a repo. A Codex worker's own config is the exception that proves it: Drove writes a `CODEX_HOME` of its own inside `$DROVE_HOME` and points Codex at it (§5), and reads, but never writes, the user's `~/.codex`.
- Work items are Cairn tasks, one ref per worker. Drove has no queue of its own.
- A run may start from a Lab subject (`drove plan --from-cairn LAB-n`, DROVE-94). A `LAB-n` ref is read with `cairn --instance <labInstance> subject show LAB-n --json` (`labInstance` in `~/.drove/config.json`, default `croft`; `--full` is refused on `subject`, and `--json` already carries the write-up and todos). The run's goal is "LAB-n: <title>" and `run.cairn` is `LAB-n`; the planner's first prompt carries the write-up and the open todos (refs and titles; done and cancelled ones are left out) and tells it to spawn one worker per todo with the todo's own ref, to note progress with `subject note`, and never to close the subject, since a conclusion is the human's. `drove down` writes its summary with `subject note` instead of `note` when `run.cairn` is a LAB ref. A subject is not an exclusive claim target, so no claim is taken on it; workers claim the todos.
- Claude Code and Codex are both supported as planner and as worker in v1.
- The planner never edits code and never runs builds; a guard enforces this. Workers never push.
- Branches Drove creates (Codex workers' `drove/<seat>`) are made with `--no-track` from `origin/main` when a remote exists, from `main` otherwise. A Claude worker's branch is made by Claude (§5). Nobody pushes to a `production` branch.
- Several runs can be open at once, one per herdr workspace. Run state is per run; what they share is the herdr server (agent names, §2) and, in one repo, the worktree folder and branch names (a clash is refused at spawn).
- Workers get any extra environment named in `workerEnv` in `~/.drove/config.json` (default none). Drove's own variables always win over it.
- TypeScript run directly by Node 22.18+ (type stripping), ESM, zero runtime dependencies, tests on `node:test`.

## 1. CLI surface

One binary, `drove` (`src/cli.ts`). Each subcommand is a thin wrapper over a function in `src/commands.ts`. The planner's MCP tools call the same functions, so the CLI and MCP paths cannot drift apart.

| Command | Who runs it | Why it exists |
|---|---|---|
| `drove plan [--kind claude\|codex] [--model M] [--effort E] [--goal TEXT \| --from-cairn REF \| --next PROJECT] [--run ID] [--detached [--json]]` | human, in a herdr pane; a job with `--detached` | Creates a run (or attaches to `--run`), records this pane as the planner pane, then `exec`s `claude` or `codex` with the planner MCP server, the planner guard and the planner role attached. This is the only way a planner starts outside the mod. With `--detached` it needs no pane: it opens a herdr workspace of its own and starts the planner there (§14). |
| `drove spawn <seat> --kind claude\|codex --cairn REF --brief TEXT\|-  [--model M] [--effort E] [--base BRANCH] [--role implementer\|reviewer\|tester --target SEAT]` | planner | Opens a pane in the run's worker tab (grid), launches the agent with its launch spec, and delivers the first brief. A Codex worker gets a worktree and branch made by Drove (`git worktree add`); a Claude worker creates its own through `claude --worktree <seat>` (§5). `--base` applies to Codex only. `--role` and `--target` make a reviewer or tester seat (§8, Seat roles). Enforces the 5-pane budget. |
| `drove send <seat> --kind message\|answer\|verdict [--verdict approve\|changes] [--expects E] TEXT` | planner | Sends one enveloped control message through the best transport for that seat (see §4), with a guarded send and a retry queue. Verdicts and answers are kinds of `send`. |
| `drove owns <seat> --add GLOB,GLOB \| --set GLOB,GLOB` | planner, human | Widens (`--add`) or replaces (`--set`) an open seat's `owns` (DROVE-119; the `set_owns` tool in both planners). The roster holds the globs and the guard hook reads the seat's `owns` from it on every call, so the worker's next edit sees the change with no restart; `up`, promote and migrate rebuild `DROVE_OWNS` from the same roster entry. It records a `seat.owns` event and sends the worker a message ("you may now also edit …"). A reviewer seat, an empty list, a bad glob and a seat that has no `owns` (nothing to widen: use `--set`) are refused. |
| `drove prompt <seat> TEXT` | planner, human | Raw `herdr agent prompt` into a seat the run owns, with no envelope. This is the escape hatch for a re-brief after a restart, or when `codex queue` is unavailable. It still refuses a `blocked` pane. |
| `drove promote <seat> [--model M] --effort E [--reason TEXT]` | planner | Changes a worker's model or effort (§8). `--model` is optional: a Codex seat is promoted by effort alone and keeps its model (or Codex's default when none is recorded). It is a separate command because it can restart the agent; demote is the same command with a lower setting. |
| `drove migrate <seat> --kind claude\|codex [--model M] [--effort E] [--reason TEXT]` | planner | Moves a worker to the other agent kind in the same worktree, with a handoff brief and no resume (§8, Migrate). Also the `migrate` MCP tool and the mod's `migrate_worker`. |
| `drove init <dir> [--json]` | planner, human | Makes a new git repo (`main`, one empty commit) in an empty or missing directory; see §6. |
| `drove checks <seat> [--fresh] [--run ID]` | planner, human | Runs the merge plan's checks in a seat's worktree, or reuses a passing record at its HEAD, and records them (§6, Check evidence). Also the `run_checks` MCP tool and the mod's `run_checks`. |
| `drove merge <seat> [--pr] [--squash] [--fresh] [-m MSG] [--no-checks] [--run ID]` | planner, human | Integrates a seat's branch behind the repo's checks (§6, Merge gate). Also the `merge` MCP tool and the mod's `merge_worker`; neither can pass `--no-checks`, which is the human's. |
| `drove roster [--json] [--run ID]` | anyone | One line per seat: state, kind, model, effort, Cairn ref, age, last report, and what the planner owes it. |
| `drove attention [--run ID \| --all] [--json] [--follow]` | human, a poller | The things that wait on a person, as data: a dialog or approval, a report for the human, a refused 6th pane, a gone seat. One snapshot, or JSON lines of new and resolved items with `--follow` (§14). |
| `drove report [<run>] [--json]` | anyone | Read-only run report (DROVE-106): per seat and in total, tokens (input, cache read, cache write, output) from the agent's own transcript, cost from a price table, wall time (spawn to close), time waiting on the human, rework (verdicts with changes, promotions, demotions, migrations, restarts) and guard denials (`deny`: per seat, in total and by rule, from the `guard.denied` events, §6). Also the `run_report` MCP tool, and the totals and per-seat lines `drove down` adds to the goal task's summary note. |
| `drove capture <seat> [--lines N]` | planner, human | Read-only `herdr agent read` of a seat's recent output. |
| `drove close <seat> [--remove-worktree]` | planner | Stops the agent and closes its pane (and the tab when it is empty), and marks the seat closed. A Claude seat is stopped by closing the pane, never with `/exit` (§5), and its stale worktree lock is cleared afterwards, as in `up` and `promote`; a Codex seat is sent `/quit` first. It removes the worktree only when asked and only when the branch is merged into the base. |
| `drove board [--once] [--web [--port N]]` | human | A live coloured board for a herdr pane, drawn from the orchestrator mod's board model (`mod/hooks/board.ts`) on the terminal's own background: the lead and what it owes, seats with state stripes, gauges and a spinner, and the timeline. It uses the alternate screen, redraws in place only while something moves, and fits the pane. `--once` or a non-TTY stdout prints a single frame; it has no colour escapes when piped or under `NO_COLOR`. `--web` serves the same model to a browser (see the web board below). |
| `drove down [--run ID]` | human, planner | Saves every session id, quits the agents, closes the panes and marks the run `down`. |
| `drove up [--run ID] [--seat SEAT] [--detached [--json]]` | human, a job with `--detached` | Reopens the worker tab and resumes each worker by session id, then `exec`s the planner with its resume argument in the current pane. With `--seat`, it relaunches only that one `gone` or `down` seat. Each relaunch records a `seat.relaunch` event (§9). |
| `drove goal [--run ID] [--cairn REF] <text>\|-` | planner, human | Sets `run.goal` (one line, whitespace collapsed) and, with `--cairn`, `run.cairn`; records a `goal.set` event (`goal`, `cairn`, `previous`). A worker is refused. The MCP tool is `set_goal`, the mod's `mcp__orchestrator__set_goal`. The goal is the planner's to keep true, so a plan or mod attach that passes a different goal also records `goal.set`. |
| `drove budget <n>` | human only | Raises the pane budget for the current run. The guard denies it to every agent, so it is the human's OK for a 6th pane when the client cannot show a dialog (§3). |
| `drove guard <event>` | hooks only | The hook entry point for Claude and Codex. For `pre-tool-use` it prints the guard's decision. For `session-start`, `stop`, `stop-failure`, `notification`, `permission-request` and `user-prompt-submit` it records state in the seat's `hooks.jsonl`. Identity comes from the env, so the command string is identical across launches (this matters for Codex hook trust, §5). A Codex hook reaches it through one `g-<hash>` shim in `$DROVE_HOME` (§5). |
| `drove mcp` | agents only | The stdio MCP server. Its role comes from `DROVE_ROLE`: the planner gets the planner tools plus the outbox watcher, and a worker gets `report`. |
| `drove mod attach\|bridge\|report` | the Claude orchestrator mod only | The mod's entry points (§10): `attach` makes the calling Claude session the planner of a run (`viaMod`, no exec) and prints JSON; `bridge` runs the outbox watcher for that session and streams wakes, the roster and events as JSON lines; `report` records a worker's report from stdin (the mod's progress report after a promote). The guard denies `drove mod` to agents. |

Not in v1: a queue command (Cairn is the queue), workflows, snapshots beyond session ids, `send-keys`.

## 2. State layout and identity

```
$DROVE_HOME (default ~/.drove), mode 700
  config.json           # optional settings (§5)
  g-<hash>              # the Codex hook shim, one per drove entry point (§5)
  runs/<run-id>/
    run.json            # RunMeta. Written by plan/up/down/budget (atomic)
    roster.json         # Roster. Atomic: write tmp + fsync + rename, under roster.lock
    roster.lock/        # mkdir lock (stale after 10 s, then stolen)
    events.jsonl        # append-only DroveEvent log, one write() per line, lines capped at 8 KiB
    checks.jsonl        # the check ledger (DROVE-122): one line per command run, with the worktree HEAD it ran at
    codex-home/         # the run's Drove-owned CODEX_HOME for Codex workers (§5)
    planner/
      pending.jsonl     # reports a wake transport could not deliver yet (piggyback source)
      cursors.json      # byte offset per outbox already consumed (exactly-once reading)
      settings.json     # Claude planner --settings (guard + state hooks)
      mcp.json          # Claude planner --mcp-config
      role.md           # Claude planner --append-system-prompt-file
      bridge.json       # the mod bridge's lock: pid and planner session (§10)
    seats/<seat>/
      token             # 32 random bytes, hex, mode 600
      outbox.jsonl      # Reports. Single writer: the worker's MCP server
      hooks.jsonl       # HookRecord lines. Writer: drove guard <event>
      pending.jsonl     # Controls waiting for a deliverable pane (guarded send)
      sent.jsonl        # ids of delivered controls (idempotence)
      settings.json     # Claude worker --settings
      mcp.json          # Claude worker --mcp-config
      role.md           # Claude worker --append-system-prompt-file (Codex: the role rides in the brief)
      mod.json          # status a Claude worker's mod writes for the board (§10)
      brief.md          # the full brief as the seat received it, mode 600 (a migration hands it to the next agent)
      start-failure.txt # pane output saved when an agent start failed (§7)
      launch.json       # the LaunchSpec used (token redacted), for relaunch and debugging
  worktrees: <repo>/.claude/worktrees/<seat>   (Codex: made by Drove on drove/<seat>; Claude: made by Claude on worktree-<seat>; see Open question 1)
```

- **Run id**: `<repo-basename>-<yyyymmdd>-<hhmm>-<4 hex>`, e.g. `drove-20261009-1042-a3f1`.
- **Seat names**: `[a-z][a-z0-9_-]{0,31}`, which is herdr's agent-name rule. The seat name is the branch suffix (`drove/<seat>` for Codex, `worktree-<seat>` for Claude) and the worktree directory. The roster's `worktree` and `branch` fields hold the real values, and `close`, `up`, `launch.json` and the board read them from there. The planner's seat name is `planner`. Seat names stay as written in the roster, the tools and the reports.
- **herdr agent names** (DROVE-43): herdr agent names are unique per herdr server, not per workspace [docs: `herdr --skill` says "unique among live agents"], so two runs that each have a seat `w-core` would reach each other's worker by the bare name. The name Drove gives herdr is `<seat>-<run tag>`, where the run tag is the last 4 hex characters of the run id (a digest of the id when it has none), e.g. `w-core-a3f1`. A name that would pass 32 characters becomes `<seat prefix>-<4 hex of the seat's digest>-<tag>`. One helper (`herdr.agentName`) is used everywhere. A seat that has a pane is addressed by its pane id instead (`herdr.agentTarget`): the id is unique, and it also reaches an agent that was started under a bare name before names carried a tag. Only a seat with no pane yet is addressed by name.
- **Same repo, several runs** (DROVE-43): runs of one repo share `<repo>/.claude/worktrees/<seat>` and the `worktree-<seat>` and `drove/<seat>` branches. `spawn` refuses, with code `seat-taken`, a seat whose worktree or branch an open seat of another run of the same repo already holds, and says which run to stop or which name to pick. Nothing is namespaced there, because Claude names its own worktree.
- **Writers**: `roster.json` and `run.json` are written only by planner-side code (the planner MCP server and `drove` commands run by the planner or the human), always under the lock. Workers never write the roster; they only append to their own `outbox.jsonl`. Hooks append only to `hooks.jsonl`.
- **Identity env** (set on the pane with `herdr pane split --env` and inherited by the agent, its hooks and its MCP servers):

| Var | Value |
|---|---|
| `DROVE_HOME` | state root |
| `DROVE_RUN` | run id |
| `DROVE_ROLE` | `planner` or `worker` |
| `DROVE_SEAT` | seat name (`planner` for the planner) |
| `DROVE_TOKEN` | the seat token (workers only) |
| `workerEnv` names | extra variables from `~/.drove/config.json`, for Claude and Codex workers only |
| `CODEX_HOME` | the run's `codex-home/`, for Codex workers that have one (§5) |

The token is not a security boundary against the worker itself: its shell can read its own env. It does three jobs. It rejects a stale worker's reports after a respawn under the same name (a new token is minted each time). It rejects text that only looks like a Drove envelope, such as a pasted report. And it keys the message MAC (§3). The real boundary is file permissions: `$DROVE_HOME` is 700 and token files are 600.

## 3. Protocol

### Acceptance and criteria (DROVE-123)

A spawn takes `acceptance`, a list of testable statements (Given-When-Then or any other); the CLI repeats `--acceptance`. Drove numbers them AC1…ACn and writes them into the seat's `brief.md` as an `## Acceptance` section ahead of the footer, and keeps the list on the seat, so `up`, `promote` and `migrate` carry them (the handoff quotes the saved brief). An empty statement is refused by `drove spawn`, the spawn tool and the mod alike, with one message. A reviewer or tester with a `--target` and no criteria of its own gets its target's, under the same heading; one given its own sees only those. The three worker role texts are short SOPs after Strands' Agent SOPs: Overview, Steps, and Constraints under `### MUST`, `### MUST NOT`, `### SHOULD` and `### MAY`; the rules are the old ones plus two: a worker MUST NOT report `done` while the repo's checks fail (it reports `blocked` or a `question`, naming what fails; a reviewer's failing check on the target is a finding, a tester's failing test of a defect is a result), and MUST address every acceptance criterion in its done report.

A `done` report takes an optional `criteria: [{ "id": "AC1", "met": true, "evidence": "…" }]` (only on `done`; at most 40, each id once, evidence at most 1000 characters). When the report is stamped, Drove adds `acceptance: <n>`, the number of criteria its seat has. `drove reports` (and the wake text) lists `Criteria: k of n met` with each id as met or UNMET with its evidence, and adds a `Drove:` line when a `done` that expects a review has no criteria, or leaves some ids unanswered. Neither field changes the kinds or the envelope.

### Reports (worker to planner)

The worker calls the MCP tool `report` (server `drove`). The server validates the call, stamps it, and appends one line to `seats/<seat>/outbox.jsonl`:

```json
{"v":1,"id":"r-<seat>-<ms>-<4hex>","run":"…","seat":"w-api","token":"…","kind":"done","expects":"review","summary":"one line","details":"branch, files, test output","at":"2026-10-09T10:20:53.000Z"}
```

| kind | default expects | meaning |
|---|---|---|
| `done` | `review` | Finished and verified. With `expects: none`, it confirms a commit after approval. |
| `question` | `answer` | Needs a decision. `for: "human"` means only the human can decide it. |
| `blocked` | `answer` | Something outside the worker's control stops it. |
| `promote` | `answer` | Asks for a stronger model or more effort. |
| `progress` | `none` | Updates the roster only; it never wakes the planner. |

These are the mod's kinds without `hello` and `status`. Those two become hook records (§7), because they are state, not conversation. The mod's `for: cal` becomes `for: human`, and the rendered text uses the human's display name from config.

### Controls (planner to worker)

Each control is recorded in the event log and rendered as text into the worker's input. The header is machine-parseable, and stays readable for a model that does not know the format. It merges the mod's `⟦orch v1 …⟧` with openrig's From/To/Reply idea:

```
⟦drove v1 run=drove-20261009-1042-a3f1 from=planner to=w-api id=c-17 kind=verdict verdict=approve expects=none mac=9f2c0d1e⟧
Approved. Commit only your own paths now …
↩ Reply with the drove report tool (server drove): kind done, expects none, with the branch and the commit sha.
```

- `kind`: `brief | message | answer | verdict | promote | demote | nudge`.
- `mac`: the first 16 hex characters of `HMAC-SHA256(seat token, signed text)`. The signed text is `drove v1`, then one `key=value` line for each of `id`, `run`, `from`, `to`, `kind`, `verdict`, `model`, `effort` and `expects` in that fixed order (an absent field is an empty value, and a value is taken as it appears in the header: whitespace and `⟧` already replaced by `_`), then a blank line, then the canonical body. The **canonical body** is the body with CR and CRLF turned into LF, trailing spaces and tabs stripped from every line, and the whole trimmed: `herdr agent prompt` types multi-line text as a paste, and a terminal turns LF into CR and drops trailing blanks, so Drove sends the canonical body and both ends mac the same text. So an edit to any header field that changes behaviour (the model or effort of a `promote`, the `kind`, the `verdict`, the `expects`, the target `to`, the `run`), or adding or dropping one, fails the MAC, exactly as an edit to the body does. Keys outside that list are not signed and receivers ignore them. `src/protocol.ts` (`MAC_FIELDS`, `macInput`, `macOf`) and `mod/hooks/protocol.ts` mirror each other and are pinned by the same test vector. A worker-side checker marks a header with a bad MAC as unverified. In a Claude worker that is the mod's `prompt.submit` hook, which computes the HMAC on `crypto.subtle.digest` and acts on a `promote` only when it verifies. In a Codex worker it is Drove's `UserPromptSubmit` hook (`drove guard user-prompt-submit`, through the same `g-<hash>` shim): it finds the envelope in the hook's `prompt` field (the same locate, split and wrapper handling as the mod), takes the seat token from `DROVE_TOKEN` or the seat's `token` file, and on a bad MAC returns the mod's "not signed by your planner" notice as `additionalContext` (what the model sees) and `systemMessage` (what the human sees as a warning). It never blocks the turn, because Codex cannot rewrite a prompt and a block would stop genuine work. A verified envelope and a prompt with no envelope pass unchanged. The mac was over `id` and the body only until DROVE-47, so envelopes made by an older planner process do not verify in a newer worker.
- The reply line is generated from `kind` and `expects`, so the receiver always knows how to answer: openrig's best idea, and it is free.
- Verdict `approve` carries the mod's `APPROVED` text: commit only your own paths, do not push, then confirm with `done` and `expects: none`. Verdict `changes` requires notes and expects `review`.
- `promote` and `demote` carry `model=` and `effort=`. `answer` and `message` differ only in how the board labels them.

### Delivery semantics

- Each control has an id. `sent.jsonl` makes delivery idempotent, and a retry happens only after an explicit failure. This fixes the mod's double send (CCS-50).
- Each report has an id. The planner server reads each outbox from its cursor, so every report is processed exactly once. A `report.delivered` event marks a successful wake, with the transport in `via`. A report whose wake failed goes to `planner/pending.jsonl`, and the next planner tool result carries it (piggyback).
- **Reports of a seat the planner closed are dropped** (DROVE-25). A report that was not yet delivered when its seat reached `closing` or `closed` is acknowledged and not sent: `report.delivered` with `via: "dropped-seat-closed"`. The planner closed that seat itself, so a late `done` would only wake it for nothing. A seat that is `gone` or `down` still delivers: it may have filed its last report just before, and the planner needs it.
- **A mod wake is a handoff** (DROVE-25). The mod only queues the text until its session is idle, so the bridge's wake is recorded with `via: "mod-handoff"`, not as a delivery. The roster's `lastReport` is already set when the report is read.
- **A prompt refused mid-turn waits, then queues** (DROVE-82). `herdr agent prompt` can exit 1 with no output while the seat is working. The adapter then asks `agent get`: a working seat is polled for up to 45 s (`workingWait`) and the prompt is retried once it is idle; if it stays working the control goes to `pending.jsonl` with the reason `<seat> is working; herdr would not take the text. It will be sent when the seat is idle`, and the flush delivers it. Every other failure reason is plain words (pane gone, timeout, refused with the exit code and herdr's text), never a bare `exit_1`. Envelopes and the mac are unchanged.
- Over budget: `spawn` asks the human through MCP elicitation when the client declared that capability [proven live in both clients: the mod's dialog in Claude, the MCP elicitation in Codex and in a Claude planner without the mod, DROVE-49]. Otherwise it refuses with: "ask the human to run `drove budget 6`".

## 4. Delivery matrix

### Planner to worker

| Planner \\ Worker | Claude worker | Codex worker |
|---|---|---|
| **First brief** (both planners) | `herdr agent start` with **no prompt argument**, which returns once the agent is ready (idle); then the brief goes as the first control by `herdr agent prompt <seat> --wait` [proven in the mod and in the first real runs]. The launch-argument path (`claude … "<brief>"`) stays behind `briefVia: "launch-arg"` / `DROVE_BRIEF_VIA=launch-arg`, but a first turn longer than the start timeout makes `agent start` time out (§13 Q7). | Same: `codex …` with no prompt, then `herdr agent prompt --wait`. The thread id appears when the first turn ends, so messages sent before that go by `herdr agent prompt` too (`codex queue` needs the thread). |
| **Later messages, Claude planner with the mod** | `herdr agent prompt <seat>`: the mod runs `drove send`, so Drove's guarded send applies (§10; `$.session.send` is not a transport) | `codex queue --thread <thread> --message <text>` [proven] |
| **Later messages, Claude planner without the mod** | `herdr agent prompt <seat>` [proven] | `codex queue` [proven] |
| **Later messages, Codex planner** | `herdr agent prompt <seat>` [proven transport] | `codex queue` [proven] |

The Codex thread id is the seat's `sessionId`. It comes from the Drove `session-start` hook record, or else from `herdr agent get <seat>` → `.result.agent.agent_session.value` [proven; null until the first turn ends, which is now the normal case because the brief is not a launch argument]. The watcher copies the hook's session id into the roster (DROVE-30; before, only `roster` and `drove down` did), and `promote` falls back to the hook record when the roster has none, so a Codex seat spawned and promoted without a refresh in between is still resumable. A seat with a Drove-owned `CODEX_HOME` (§5) has its thread under that home, so `codex queue` runs with `CODEX_HOME` set to the seat's recorded home.

**Addressing.** A seat with a pane is addressed by pane id in every herdr call (`agent get`, `read`, `prompt`); its namespaced agent name (§2) is used only before it has a pane. A seat with no pane is not deliverable ("has no pane yet"). The guard accepts a seat name, its namespaced agent name, its pane id or its session id as the target of an allowed `herdr agent prompt` (§6).

**Guarded send.** Before any keystroke-based delivery (`herdr agent prompt`), check `herdr agent get <seat>`. If the state is `blocked`, or the seat's hooks report needs-input, do not type: append the control to `seats/<seat>/pending.jsonl`, raise an attention item, and retry on every watcher tick (3 s) until the pane is not blocked. herdr itself also rejects with `agent_blocked` [proven], and that error takes the same queue path. `codex queue` does not type into the pane, so it is allowed while the pane is busy (mid-turn messages queue [proven]). It is still deferred while the pane is `blocked`, because the queued turn would sit behind a dialog that nobody sees. `agent_pane_busy` from a fresh pane is retried for up to 45 s, as in the mod's `retryWhileBusy`. `agent_prompt_stalled` is not resent blindly: the mod's rule applies (check the state first).

**First-brief timeout.** The brief is the first `herdr agent prompt --wait` after `agent start` has returned, so a long first turn can only hit the prompt wait, never the start wait. A prompt `timeout` is delivered-unconfirmed (below): the spawn succeeds, the seat is `working`, and the result says the brief was typed but not confirmed.

**Unconfirmed delivery.** `herdr agent prompt --wait` types the text and then waits for the agent's status to change. When that wait fails with `timeout` ("timed out waiting for agent status"), the text was already typed, so Drove records it as delivered-unconfirmed and does not queue it or retry: `control.sent` gets `unconfirmed: true`, and a worker-to-planner wake emits `report.delivered` with `via: "herdr-prompt-unconfirmed"` (and the report leaves the pending ledger, so the piggyback does not repeat it). Only failures before anything is typed queue: `agent_blocked`, `agent_not_found`, and a pane that stays `agent_pane_busy` past the retry window. (Seen in an early live run, where a timed-out wake was queued and then delivered a second time by piggyback.)

### Worker to planner

All reports go through the outbox. Only the wake differs:

| Planner | Wake transport, in order |
|---|---|
| Codex | `codex queue --thread <planner thread> --message <rendered report>` [proven transport]. The planner thread is known because `drove plan` launches Codex with an initial prompt, and the session id comes from the planner's `session-start` hook or herdr. While the planner is mid-turn, the message queues as its next turn [proven]. |
| Claude with the mod | `drove mod bridge` runs the watcher with the `mod` wake transport: it writes the rendered reports to its stdout as a `wake` line, and the mod submits them with `$.prompt.submit`, a turn of their own once the session is idle (§10). The event says `via: "mod-handoff"` (§3): the text is handed to the mod, not yet typed |
| Claude without the mod | (1) A channel: `notifications/claude/channel` from the planner's own MCP server, when `drove plan` launched it with `--dangerously-load-development-channels server:drove` [proven live, DROVE-49: research preview; one confirmation prompt at launch; an idle session does take a turn when a report arrives through the channel; Claude prints a cosmetic "no MCP server configured with that name" line at launch and the channel works anyway]. (2) Else `herdr agent prompt <planner pane>` when the planner pane is `idle` or `done`, and never while it is `blocked` [proven transport]. |
| Any | Piggyback: every planner tool result ends with any reports still pending. |

`progress` reports never wake the planner. Several reports that arrive within 2 s go out as one wake message.

Risk with keystroke wake (2): it types into the human's own pane, and could land in a half-written prompt. Mitigation: wake only when the planner pane has been `idle` or `done` for 5 s or more. The channel is better, which is why it comes first.

## 5. Launch specs

All launches follow the same steps. Create or reuse the run tab: `herdr tab create … --env …` for the first worker, then `herdr pane split` into the grid slot (the mod's `gridSlot`). Then run `herdr agent start <agent name> --kind <kind> --pane <pane> --timeout 60000 -- <argv>`, where the agent name is the seat's namespaced name (§2). Files are written under `seats/<seat>/` first.

**Readiness gate** (DROVE-23). herdr types the launch line into the pane's shell. Until the shell's line editor owns the terminal the kernel is in canonical mode and cuts a typed line at 1024 bytes on macOS, and a Codex line used to be about 1300. Two things keep the line whole:
- Every pane Drove opens has `POWERLEVEL9K_INSTANT_PROMPT=off` in its env, because powerlevel10k's instant prompt draws a finished-looking prompt while `.zshrc` is still loading, which is exactly when the line would be cut.
- `awaitShellPrompt` reads the pane's last 5 visible lines every `timing.pollMs` (500 ms) for up to `timing.promptWaitMs` (4 s) and returns once the text has stopped changing and ends in a prompt character (`% $ # > ❯ ➜ »`). It does not fail the launch when the wait runs out: it types anyway.
If `agent start` then fails and no agent of the right kind is up in the pane (the adoption check below), Drove records `seat.state` with `startRetry: true`, closes that pane (or the tab it just created), places a fresh pane and tries once more. The same gate and one retry apply in `spawn`, `promote` and `up`. For Codex workers the line is also short on its own, with the config in a Drove-owned `CODEX_HOME` (below), so the gate is the second safeguard there, and the only one for a legacy seat.

**Brief after start.** By default (`briefVia: "prompt"` in `~/.drove/config.json`; `DROVE_BRIEF_VIA=prompt|launch-arg` overrides it) the worker is launched with no prompt argument, so `agent start` returns as soon as herdr sees the agent idle, and the brief follows as the first control. With `briefVia: "launch-arg"` a single-line brief is the last launch argument as before; a brief that is not shell-safe always goes by prompt. A Claude worker's role text is a file (`role.md`, `--append-system-prompt-file`); a Codex worker's rides at the top of its first brief, ahead of the brief and its footer, since no line of the typed launch carries it.

**Start timeout safety net.** If `agent start` still fails (typically `timeout`), `spawn` looks before it rolls back: `herdr agent list` for an agent in that pane (or named for the seat) of the expected kind with status `working`, `idle` or `done`, and a visible screen with no known dialog; failing that, a screen that shows the agent's own UI (`Claude Code v…`, `OpenAI Codex`) and no dialog. If so the seat is registered (state from herdr, or `starting` when only the screen shows it, for the watcher to judge), `seat.spawn` carries `startTimeout: true`, and the result says so. It rolls back (closing the pane or tab, deleting the fresh Codex worktree) only when the agent is absent or a dialog matched, and then it saves the pane output as before.

Launch argv must be free of control characters (newline, C0, DEL): herdr types it into the pane's shell and refuses it otherwise (`invalid_agent_argument`). Drove checks every worker spec (`assertShellSafeArgs`); a multi-line brief, or any unsafe prompt, is launched without the prompt argument and goes through `herdr agent prompt` automatically. A planner is exec-ed directly, so its goal may span lines.

### Claude worker

```
env:  <workerEnv> DROVE_HOME=… DROVE_RUN=… DROVE_ROLE=worker DROVE_SEAT=<seat> DROVE_TOKEN=…
cwd:  <repo>              (fresh launch; the main checkout, which Claude already trusts)
argv: --dangerously-skip-permissions                      [proven]
      --model <model> --effort <effort>                   [proven]
      -n <seat>                                           [proven]
      --worktree <seat>                                   [proven in the mod; fresh launch only]
      --session-id <uuid minted by drove>                 [docs] (so resume needs no discovery)
      --mcp-config <run>/seats/<seat>/mcp.json            [docs]
      --settings <run>/seats/<seat>/settings.json         [docs: launch-only, merged, writes no file]
      --append-system-prompt-file <run>/seats/<seat>/role.md  [docs: works interactively; no role text in argv]
      (no prompt argument by default; the brief follows by herdr agent prompt. Launch-arg mode appends "<brief + footer>")
```

**Branch.** The worker role text says which branch the seat is on: "You are already on your own branch (`worktree-<seat>`) in your own worktree. Commit there. Do not create, switch or rebase branches unless the planner asks." (Codex: `drove/<seat>`.) In an early live run a Claude worker had been told to branch with `--no-track` and made `w-cl2-hello` beside its worktree branch; the planner role no longer tells briefs to do that.

**Why `--worktree` and not `git worktree add`.** Claude Code asks "Do you trust the files in this folder?" in a folder made by `git worktree add`, even under a trusted repo, because trust is per folder in `~/.claude.json`. `claude --worktree <seat>` creates `<repo>/.claude/worktrees/<seat>` itself, on branch `worktree-<seat>` with no upstream, and does not ask (proven by the orchestrator mod). So a Claude seat is launched from the repo root with `--worktree <seat>`; Drove runs no `git worktree add` for it and records worktree `<repo>/.claude/worktrees/<seat>` and branch `worktree-<seat>` in the roster. Pre-trusting by writing `~/.claude.json` is rejected: it is global config that live sessions rewrite. Claude Code 2.1.296 no longer behaves this way: it trusts a linked worktree through its main repo, which `drove migrate` relies on to start Claude in a Drove-made worktree (§8, Migrate). Spawn keeps `--worktree`.

**Base branch.** Claude creates the `--worktree` branch itself, from `origin/main` (its reflog says `branch: Created from origin/main`), not from the local `main` and not from the main checkout's HEAD, and never sets an upstream; on its own a Claude worker would miss anything merged locally but not pushed [proven: runs of 2026-10-10 started a worker at 749c116 while local `main` was at af21622]. So `spawn` corrects it (DROVE-50): it resolves the run base to the freshest of the local branch and its remote counterpart (`freshestBase`: the local `main` when it contains `origin/main`, else `origin/main`, with a note when the two diverged), waits up to `timing.worktreeWaitMs` for Claude's worktree to appear, and fast-forwards the worktree branch to that base (`git merge --ff-only`) before the brief goes in. A branch already at the base is left alone; one that is not an ancestor of the base, or a fast-forward that fails, is left as is and noted. `--base` is ignored for Claude seats, with a note. Every note goes into `spawn`'s result and the `seat.spawn` event. Drove does not switch the main checkout, because the planner works in it. Codex workers are created with `git worktree add` from the freshest form of `--base`, or of the run base.

**Resume.** A resumed Claude worker runs `claude --resume <id>` with cwd = the seat's worktree and **without** `--worktree`: the session was recorded while Claude's working directory was the worktree, Claude finds sessions by working directory, and `--worktree` on a resume would try to create or re-enter a worktree instead of continuing the session [docs/inference; verify with a real resume, DROVE-8]. `up` and `up --seat` open the new pane with cwd = the worktree. `promote` for a Claude seat does the same: it closes the old pane and places a new one with cwd = the worktree, since the old pane's shell sits in the repo root (Claude's move into the worktree is inside its own process); see §8.

**Stopping a Claude worker.** Drove never sends `/exit` to a Claude seat. A session started with `--worktree` answers `/exit` with an "Exiting worktree session" dialog (1. Keep worktree, 2. Remove worktree), and Drove must never answer a dialog: left alone it stalls the restart, and a wrong answer deletes the worktree and its commits (seen in the DROVE-18 lifecycle test). A Claude seat is stopped by closing its pane (`herdr pane close`). Claude writes its transcript as it goes, so `claude --resume <session id>` from the worktree restores the conversation; what a closed pane loses is only the turn in flight, which `up` covers with the resume notice. The same applies to a resumed seat (no `--worktree`), because Claude may restore the worktree session from the transcript and show the same dialog. Codex has no such dialog and is still sent `/quit`.

**Worktree lock.** Claude locks its worktree with `git worktree lock --reason "claude session <name> (pid <pid> start <time>)"` and unlocks on a clean exit, so a closed pane leaves a stale lock. Claude itself clears a lock of that shape whose pid is dead when it takes the lock [claude 2.1.296 binary], so a resume is not blocked by it. Drove still clears it defensively (`releaseStaleLock`): before it starts a resumed Claude seat (`up`, `up --seat`, `promote`), and after it closes a Claude seat's pane in a plain `close` (DROVE-26; without `--remove-worktree` the lock used to stay until the next `up`), it reads `git worktree list --porcelain` and, when the lock reason has Claude's shape and the pid is no longer alive (it waits up to `timing.lockWaitMs` for a pane that was just closed), runs `git worktree unlock <path>`. A lock whose pid is alive, and any lock not of that shape, is left alone; `promote`, `close` and `up --seat` say so in their result. `close --remove-worktree` also unlocks and retries the removal.

`mcp.json`: `{"mcpServers":{"drove":{"command":"node","args":["<drove>/src/cli.ts","mcp"]}}}`. The env is inherited [docs]. `settings.json` holds `hooks.PreToolUse` with matcher `Bash|Edit|Write|MultiEdit|NotebookEdit` running `drove guard pre-tool-use`, plus `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure` and `Notification` hooks running `drove guard <event>`. The `user-prompt-submit` record is how Drove confirms that a typed brief or message reached the session when `herdr agent prompt --wait` timed out (DROVE-60). With no allowlist there is no `--strict-mcp-config`: the user's own MCP servers stay available, and so does Claude in Chrome.

**Lean worker** (DROVE-72, DROVE-88, DROVE-89, DROVE-98). Each switch below is probed on Claude Code 2.1.296 and has a run-wide key in `~/.drove/config.json` and, for a Claude seat, a per-spawn option stored on the `Seat` (`mcp`, `plugins`, `skills`, `agents`, `userMemory`, `userHooks`), so promote, resume, `up` and migrate rebuild the same launch from the seat. The merge lives in `launchExtrasOf` (`src/commands.ts`): a list is the run's list plus the seat's (`seatMcpAllow`, `seatPluginAllow`), a list on the seat alone makes it lean, and the seat's `userMemory` wins over `workerUserMemory`. A worker is MCP-lean when `workerMcp` is set or the spawn has `--mcp`.
- *MCP.* `--strict-mcp-config` and an `mcp.json` with Drove's server plus the allowed user servers.
- *Chrome.* `--no-chrome`, unless the allowlist names `claude-in-chrome`. `--strict-mcp-config` does not remove Claude in Chrome (a `dynamic` server, 22 tools, on by default in an interactive session), and `--settings` cannot set the global `claudeInChromeDefaultEnabled`; the flag does remove it.
- *Report tool.* Drove's own server, `mcp__drove__report`, is the one report tool; the mod no longer registers `mcp__orchestrator__report` for a worker.
- *Plugins* (`workerPlugins`, or a seat's `--plugins`, lists of names, with or without `@marketplace`; with neither set nothing changes, and `[]` keeps Drove's mod alone). `settings.json` gets `enabledPlugins: {"<key>": false}` for every plugin the user's `settings.json` enables that is not listed, and `env.CLAUDE_CODE_PLUGIN_DIRS` cut to the user's mod dirs whose plugin name (`.claude-plugin/plugin.json`, else the dir's basename) is listed. A value in `--settings` replaces the user's, per key. Drove's own mod (`orchestrator`) is always kept. Plugins Claude Code ships itself (`cc-plugin-*` in the init event) cannot be turned off. Drove only reads the user's `settings.json` (under `CLAUDE_CONFIG_DIR` or `~/.claude`).
- *User memory* (`workerUserMemory: false`, or a seat's `--user-memory off`; the default is on, and `--user-memory on` loads it for one seat of a lean run). `settings.json` gets `claudeMdExcludes` for the user's `CLAUDE.md` and every `CLAUDE.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md` in the folders above the repo root. `claudeMdExcludes` from `--settings` skips `~/.claude/CLAUDE.md` too. The repo's own files stay, and `CLAUDE_CODE_DISABLE_CLAUDE_MDS` is not used because it would drop them. A Codex worker's `CODEX_HOME` stops linking `AGENTS.md` and `AGENTS.override.md` and removes a link an earlier spawn made (a real file there is left). The Codex home is shared by the run, so the planner's next launch links them again; a Codex session reads them at its start.
- *Skills* (`workerSkills`, or a seat's `--skills`; the same merge, and `[]` is a list). `readClaudeSkills` names what Claude lists for the user: `~/.claude/skills/<d>/SKILL.md` (the frontmatter `name`, else the folder), the claude.ai skills Claude syncs into `~/.claude/skills/synced/<account>/<d>/` as `anthropic-skills:<d>`, and `~/.claude/commands/**.md` (`folder:name`). `settings.json` gets `skillOverrides: {"<name>": "off"}` for each one the list leaves out (an entry may drop the `anthropic-skills:` prefix). Probed on 2.1.296: exact names only (`anthropic-skills:*` and `*` do nothing), the init event's `skills` list shrinks, and the prompt does too. It does not reach plugin skills (`ccc-skills:*`, `supabase:*`), which follow `enabledPlugins`. `disableBundledSkills`, or the bundled names switched off, made the first request bigger (44.0k against 39.1k), so Drove leaves Claude's bundled skills alone. `[]` adds `--disable-slash-commands` (skills 0, the Skill tool gone, hooks and plugins still run): 34.2k against 39.1k. Measured with `claude -p --model haiku`, the whole first request: 28 user skills off 35.6k (-3.5k), the 13 claude.ai ones 36.8k (-2.3k), both 32.5k (-6.6k).
- *Agents* (`workerAgents`, or a seat's `--agents`). `readClaudeAgents` names `~/.claude/agents/**.md` (frontmatter `name`, else the file). `settings.json` gets `permissions.deny: ["Agent(<name>)"]` for each one the list leaves out; deny arrays merge with the user's. Probed on 2.1.296: the agent leaves the Agent tool's list (asked of the model; the init event still names it), the built-ins (`claude`, `Explore`, `general-purpose`, `Plan`, `statusline-setup`) stay: 36.8k with 28 denied (-2.3k). No settings key, flag or env var hides `~/.claude/agents` as such: `--agents` only adds, `--agent` picks the main-thread agent.
- *User hooks* (`workerUserHooks: false`, or a seat's `--user-hooks off`; the default keeps them). No hooks-only switch exists in 2.1.296: `disableAllHooks` in `--settings` also turns Drove's own hooks and the plugins' off (checked: no hook ran), and `allowManagedHooksOnly` and `strictPluginOnlyCustomization` are managed-settings only (no effect from `--settings`). The lever is `--setting-sources project,local`: the user's `settings.json` is not read, `--settings` hooks still run (checked with a marker file), and `~/.claude/CLAUDE.md` stays (memory is `claudeMdExcludes` alone). It also drops everything else the `user` source carries: env (`CLAUDE_CODE_PLUGIN_DIRS`, tool tokens), `permissions`, `enabledPlugins`, `skipDangerousModePermissionPrompt` (without it the bypass dialog stalls the pane), `~/.claude/{skills,agents,commands}` and the synced claude.ai skills, and the user-scope servers of `~/.claude.json`. So `claudeSettings` copies the user's `settings.json` minus `hooks` (`readClaudeSettings`) into the seat's `settings.json` and layers Drove's own keys over it (`enabledPlugins` and `env` merge per key, `claudeMdExcludes` and `permissions.deny` concatenate, `hooks` is Drove's alone), and `allowedMcp` puts the user-scope servers into `mcp.json` when no allowlist narrows them. The user's skills, agents and commands cannot be put back, so `skillOverrides` and the agent denies are skipped for such a seat (`[]` skills still adds `--disable-slash-commands`) and the spawn result says so. The settings file holds the user's `env` (tokens included), as the Codex home's `config.toml` already holds the user's MCP env; both are written mode 0600 under the run, and `redactSpec` masks every env value (the settings `env`, MCP server `env` and `headers`, a Codex home's `mcp_servers.*.env` tables, `workerEnv`) in the `launch.json` record, which is the only copy Drove shows or reads back. Measured the same way: the whole source dropped with the settings carried over 26.0k (-13.1k, user MCP tools, skills and agents among it); all hooks off (`disableAllHooks`) 36.3k (-2.8k), the best estimate of the hook output alone. Codex: `codexHomeContents` starts `hooks.json` with the user's groups (so their trust carries over); with `userHooks: false` it starts empty and Drove's hooks take index 0.
- *Codex has no per-seat memory switch.* Codex reads the user's `AGENTS.md` (`AGENTS.override.md` first) from `config.codex_home` in `CodexHomeUserInstructionsProvider` (codex-rs `codex-home/src/instructions/mod.rs`, rust-v0.162.0), with no config key or `-c` override that skips it; `project_doc_max_bytes` and `project_doc_fallback_filenames` only shape the repo's own `AGENTS.md` chain, which a worker needs. `CODEX_HOME` is shared by every seat, so a per-seat flip of the links would race. A Codex seat therefore follows `workerUserMemory` and `workerUserHooks` alone (the home's `hooks.json` is one file too); `plugins`, `skills`, `agents`, `userMemory` and `userHooks` on a Codex spawn are stored on the seat (a migrate to Claude uses them) and the spawn result says they apply to Claude seats only. `mcp` is per seat for Codex too, through `-c mcp_servers.<name>.enabled`.
- *The planner picks.* `plannerRole` (and the mod's `orchestratorSection`) carries a "Lean spawns" paragraph: what a worker loads under the current config, the option names and when to pass them, and the MCP server and plugin names read best effort and read only (`readClaudeMcp`, `readClaudePlugins`, the user's Codex `config.toml`), names only. It is in the planner's text only; the worker role stays identical across seats so it caches (DROVE-72).
- None of these touch a planner.

### Codex worker

```
env:  DROVE_HOME DROVE_RUN DROVE_ROLE=worker DROVE_SEAT DROVE_TOKEN
      CODEX_HOME=<DROVE_HOME>/runs/<run>/codex-home                    [proven: DROVE-34 live check]
argv: [resume <thread id>]                                             (promote, up)
      --dangerously-bypass-approvals-and-sandbox   (default; see below) [proven: openai/codex codex-rs/utils/cli/src/shared_options.rs]
      -C <worktree>                                                    [proven]
      [-m <model>]                                                     (only when the seat has a model)
      -c model_reasoning_effort="<effort>"                             [proven: the effort changes across a promote restart, DROVE-45]
      (no prompt argument by default; launch-arg mode appends "<brief + footer>")
```

The typed line is about 150 to 200 bytes (it was 1117 before DROVE-34; the resume line was 1161). Everything else is in the run's `CODEX_HOME` (next). The role text is **not** an argument: it rides at the top of the first brief (`spawn`), and resume and promote launch Codex with no role text at all, because the session already holds it (DROVE-23; `developer_instructions` and the five inline hook overrides are gone from the worker line).

**Drove-owned `CODEX_HOME`** (DROVE-34). One per run, at `runs/<run>/codex-home`, passed through the pane env, so none of it is typed. Drove writes it on every Codex worker launch (each file by tmp + rename, because another seat's launch may rewrite it while a running Codex reads it), and never writes the user's own `~/.codex`:
- `config.toml`: a header comment; the user's root `model` and `personality` keys when they set them; `check_for_update_on_startup = false`; `[projects."<repo>"] trust_level = "trusted"` (the repo, not the worktree: Codex resolves a linked worktree to its main repo root); `[mcp_servers.drove]` (`command = "node"`, `args = [<drove>/src/cli.ts, "mcp"]`, `env_vars` with the five `DROVE_*` names, `default_tools_approval_mode = "approve"`); the user's other `[mcp_servers.*]` tables, copied; and the `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]` trust entries (see Hook trust).
- `hooks.json`: the user's own hook groups first, at the indices their trust is keyed by, then Drove's five: `PreToolUse` (matcher `Bash|shell|exec_command|apply_patch`), `SessionStart`, `UserPromptSubmit`, `Stop` and `PermissionRequest`, each a call of the `g-<hash>` shim with the event name.
- symlinks to the user's `~/.codex` (or `$CODEX_HOME` when it is set and is not itself inside `$DROVE_HOME`): `auth.json`, `AGENTS.md` and `AGENTS.override.md` when they exist, and each entry of `skills/`. A path that already holds a real file is never replaced by a link. Login therefore carries over, and the user's skills and instructions still load.
- `sessions/` and the rest are Codex's own and stay with the run. That is why resume needs the same home: the seat records `codexHome` in the roster, `promote`, `up` and `codex queue` all use it, and a seat with **no** `codexHome` (spawned before DROVE-34) is a legacy seat that keeps the old launch: `~/.codex` and the inline spec of the planner below.

**Hook shim.** The hooks call one tiny script, `$DROVE_HOME/g-<8 hex of sha1 of the drove entry>`, which `exec`s `node <drove>/src/cli.ts guard "$@"`. One shim per drove entry point, so two checkouts that share a home never overwrite each other's. A hook command is therefore `<shim> <event>`, short and constant.

**Sandbox (decision, the maintainer, 2026-10-09; DROVE-14).** Codex workers run with approvals and the sandbox bypassed, like Claude workers' `--dangerously-skip-permissions`: `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) replaces `-s workspace-write`, and the extra writable dir and the network override are dropped because they are moot. Drove's `PreToolUse` guard hook still runs and still denies pushes, in both modes. The config key `codexWorkerSandbox` in `~/.drove/config.json` (`"bypass"`, the default, or `"workspace-write"`) restores the old spec: `-s workspace-write`, `--add-dir <repo>/.git` and `-c sandbox_workspace_write.network_access=true`. The Codex planner keeps normal approvals and the workspace-write sandbox.

**Identity env.** The `DROVE_*` identity is already in the pane env (`herdr --env`). Codex forwards named parent env vars to a stdio MCP server through `mcp_servers.<name>.env_vars = [...]` (read from Codex's own process env; only Codex-internal names are filtered), so the config (the home's `config.toml`, or for a legacy seat and the planner an inline `mcp_servers.drove={…}` override) names the variables and never holds the values. The token is therefore not typed into the shell and does not appear in the pane scrollback. This applies to the Codex planner too.

### Planners

- **Claude planner** (`drove plan --kind claude`): `exec claude --model <opus> --effort <high> --session-id <uuid> --mcp-config planner/mcp.json --settings planner/settings.json --append-system-prompt-file planner/role.md [--dangerously-load-development-channels server:drove] ["<goal>"]`. No bypass of permissions: the human answers prompts in their own pane.
- **Codex planner** (`drove plan --kind codex`): `exec codex -s workspace-write -C <repo> --add-dir <repo>/.git --add-dir $DROVE_HOME/runs/<run> -c model_reasoning_effort=… -c sandbox_workspace_write.network_access=true -c mcp_servers.drove={command="node",args=[…],env_vars=[…],default_tools_approval_mode="approve"} -c developer_instructions=… -c hooks.<Event>=[…<shim> <event>…] "<goal or 'Read the roster and wait for the human.'>"`. The planner has no Drove-owned `CODEX_HOME`: it runs in the human's own pane under the user's own Codex config, so its MCP server and its five hooks stay inline overrides (the MCP server as one table, the hooks through the shim). The initial prompt exists so that the planner has a thread id at once, which the wake needs.

### Hook trust (Codex)

Codex runs a hook only if its trust is persisted in a `config.toml` [proven, CCS-47 knowledge `codex-hook-trust-is-keyed-by-position`]. A worker with a Drove-owned `CODEX_HOME` needs no human approval: Drove writes the trust itself, into that home's `config.toml` (never the user's), as `[hooks.state."<home>/hooks.json:<event>:<group>:<handler>"] trusted_hash = "sha256:…"` for each of its five hooks, computed with Codex's own fingerprint (SHA-256 of the canonical JSON of event, matcher, command, timeout and flags; `codexHookHash`, from openai/codex rust-v0.162.0 `hooks/src/engine/discovery.rs`). Codex canonicalises its home and keys trust by absolute path, so both the home and the user's home are resolved with `realpath`. The user's own hooks keep their trust: their trust entries are re-keyed to the new `hooks.json`. [proven: live check of DROVE-34 on a Codex seat, no hook-review dialog, the guard denied `git push`, Cairn worked.]

The human-approval path remains for what Drove does not own: a legacy seat and the Codex planner, whose hooks are inline `-c` overrides. Every Drove hook command is a constant string, with identity from the env, so the human approves each once, Codex persists the approval, and later launches reuse it [verify that inline `-c` hooks get stable trust keys]. Fallback: a per-launch `--dangerously-bypass-hook-trust`, enabled by the human in `~/.drove/config.json` (`codexBypassHookTrust: true`). See Open question 3.

### Isolation (DROVE-93)

**What a worktree isolates:** the working files, the index and the branch. Everything else is shared with the other seats and with the human: TCP ports, databases and caches on localhost, untracked config (`.env`, local certificates; a worktree has none of them), global installs (`npm -g`, brew, pip without a venv), system services and the home directory. Two workers that both start a dev server on 3000, or both run migrations against one local database, collide, and nothing in git says so.

**What Drove adds, all opt-in in `~/.drove/config.json`:**
- *Ports* (`workerPorts: { base, stride }`). Each open seat takes the lowest free slot index (`freeSlot` in `src/isolation.ts`, counting the open seats of every run in the home, since ports are machine-wide). Its env gets `PORT = base + slot × stride`, `DROVE_PORT_BASE` (the same) and `DROVE_PORT_COUNT = stride`. The slot is stored on the `Seat`, so relaunch, promote, `up` and migrate rebuild the same env; closing a seat frees it. Drove does not check that the ports are free on the machine, only that no seat shares one.
- *Env templates.* `workerEnv` values may use `{seat}`, `{run}`, `{slot}` and `{port}`, filled per seat in `launchExtrasOf`. An unknown `{name}` stays as written and the spawn result names it. An explicit `PORT` in `workerEnv` wins over the computed one.
- *Untracked files* (`workerCopy`: globs from the repo root). At spawn, `git ls-files -o -i --exclude-standard` over a `:(glob)` pathspec lists the ignored matches in the main checkout; they are copied with `COPYFILE_EXCL`, so a file the worktree has is never touched. A match that is untracked but not ignored is refused, since the copy would show in `git status` and could be committed by a worker's `git add`. A Claude seat's worktree appears after launch, so its copy runs after `alignClaudeWorktree`; a Codex seat's runs right after `git worktree add`. The brief footer names the ports and the copied files in one line, only when set.

**What this does not cover:** a database server itself (a template can name a database per seat, not create it), a shared package cache or a global install a worker changes, a service that listens on a fixed port Drove does not know, and code that must not touch the host at all.

**When a container or VM per seat is worth it** (not built): workers that mutate shared global state (global installs, system services, kernel or Docker settings), run untrusted or unreviewed code (a dependency's postinstall, a repo from the outside), need a different OS or toolchain than the host, or hold secrets the others must not read. Options and their cost:
- *devcontainer* (one `devcontainer up` per worktree): reuses the repo's own definition, so workers match CI; needs Docker, adds tens of seconds and a few hundred MB per seat, and the agent CLI plus its auth, the Drove mod and the MCP socket path must be reachable inside it.
- *Docker per seat* (a bind-mounted worktree, a fixed image): the cheapest hard boundary for ports, packages and the filesystem; the herdr pane runs `docker exec`, so the pane, hooks and `drove report` need the CLI and `DROVE_HOME` mounted in. Bind-mounted files keep the host's uid problems; no systemd inside.
- *Lima or Tart VM per seat*: a real boundary, including services and a different kernel or macOS version; a full OS per seat means gigabytes of disk, minutes to clone, and RAM that caps the pane budget well below 5.

Until a repo hits one of those, ports, templates and copied files are enough, and the worktree stays the unit of isolation.

## 6. Guards

One module, `src/guard.ts`, with the shell parser in `src/shell.ts`, ported from the mod and fixed. It is pure: `decide(GuardInput) → GuardDecision`. It has three callers:

1. Claude PreToolUse, through `drove guard pre-tool-use` (stdin is the hook JSON).
2. Codex PreToolUse, through the same command [verify the input shape; the adapter accepts `tool_name` of `Bash`, `shell`, `exec_command` or `apply_patch`, and a `tool_input.command` given as a string or as an argv array].
3. The mod's `tool.call`, by importing `decide` directly (no subprocess).

Output: exit code 2 with the reason on stderr, which both clients document as "block" [Claude: docs; Codex: verify]. Claude also gets the `hookSpecificOutput.permissionDecision: "deny"` JSON on stdout. When the guard itself fails, see *Fail mode* below: the planner and a reviewer seat fail closed, every other seat fails open.

### Shell parser fix (CCS-50)

The mod's `bashReason` regex-scans the whole raw command for `$(…)` and backticks, including single-quoted text and heredoc bodies. The fix is structural: `parseShell` records each segment's `substitutions` only where a shell would expand them. That means unquoted and double-quoted `$(…)`, `<(…)`, `>(…)` and backticks, and the bodies of unquoted-delimiter heredocs (`<<EOF`). Single-quoted text, `$'…'` text and the bodies of quoted-delimiter heredocs (`<<'EOF'`, `<<"EOF"`) are data. `bashReason` recurses into `segment.substitutions` and never into raw text. Required tests:

- allowed: `cairn add "t" --body - <<'EOF'` + body containing `<ref>` and `` `herdr pane split` `` + `EOF`
- allowed: `cairn add "t" --body "$(cat <<'EOF'` … `<ref>` … `EOF` `)"`
- allowed: `echo '$(rm -rf x)'`, `grep -n "a<b" file`
- denied: `echo "$(herdr pane split --current)"`, `` x=`rm f` ``, `cat <<EOF` + body `$(touch f)` + `EOF`

### Rules

| | Planner | Worker |
|---|---|---|
| Edit/Write/MultiEdit/NotebookEdit/apply_patch | deny, except in `/tmp`, `/private/tmp`, `~/.claude/plans`, `$DROVE_HOME/runs/<run>/scratch` | allow |
| Bash: file writers, in-place sed/perl, runtimes, `./script`, redirects to files | deny (mod rules), **except** `mkdir`, `touch`, `tee`, `cp`, `mv`, `rm`, `rmdir` and redirects whose every write target is inside a Claude Code session scratchpad (below) | allow |
| Package tools | read-only subcommands only (mod table) | allow |
| *Reviewer seat* (DROVE-91, below) | | a worker with `DROVE_SEAT_ROLE=reviewer` gets the planner's column for Edit/Write, Bash writers, runtimes and package tools, the worker's column for `git push`, `herdr`, `claude`/`codex` and `drove`, and the exceptions listed under "Reviewer seats" |
| `gh` writes | allow PRs (all but `merge`), issues (not `delete`, `transfer`), releases (`create`, `edit`, `upload`), workflow `run`/`enable`/`disable`, run `rerun`/`cancel`, labels (not `delete`), repo `clone`/`fork`/`sync` and `create --private\|--internal`; deny deletions, transfers, repo `edit`/`rename`/`archive`, a repo `create` that would be public, `label delete`, `pr merge` in any form (it skips the merge gate: "use drove merge <seat> --pr: it gates the merge on the checks; ask the human to merge other PRs"), `secret`/`variable` writes and `gh api` writes ("ask the human"); deny any of them naming `production` in `--base`/`-B`/`--target`/`--ref`/`--head`/`-H` (DROVE-104) | allow |
| `curl`/`wget` writes | deny | allow |
| `git` | allow, except a push to `production` and a `merge` of a seat branch (`worktree-*`, `drove/*`, in any spelling) | allow, except any `push` |
| `herdr` writes | deny, **except** `herdr agent prompt\|wait <seat>` where `<seat>` is an open seat of this run, given as its name, namespaced agent name, pane id or session id (CCS-50, DROVE-43) | deny |
| `herdr` reads (`list`, `get`, `read`, `explain`, `wait`) | allow | allow |
| `claude`, `codex` | deny, except `--help`, `--version` and `codex queue` to an open seat of this run | deny, except `--help`, `--version` and `claude plugin test [dir]` (DROVE-39) |
| `drove` | allow `goal`, `init`, `spawn`, `send`, `prompt`, `promote`, `merge` (but not with `--no-checks`), `roster`, `capture`, `close`, `board --once`, `down`; deny `budget`, `plan`, `up`, `guard`, `mcp` | allow `roster`, `capture`; deny the rest |

The guard cannot see a PR's base when a command names the PR by number (`gh pr view 12`), so the `production` rule covers only the branches named on the command line.

**Reviewer seats** (DROVE-91). `Identity.seatRole` travels as `DROVE_SEAT_ROLE` (set for a reviewer or tester only; an unknown value is ignored, so a missing one is an implementer) and the hook puts it in `GuardInput.seatRole`. For `role: 'worker'` with `seatRole: 'reviewer'`, `decide` treats the call as read-only:

- Edit tools are denied unless every path is scratch: outside the seat's own worktree and inside the temp directories (or Claude's per-project memory). A worktree that itself lives under `/tmp` is not scratch.
- Bash runs through the planner's checks (`readOnly` on the scope), with the planner scratchpad rule replaced by the same scratch test, so `mkdir`, `cp`, `rm`, `tee` and redirects work on `/tmp` files only.
- The repo's checks are allowed through `isCheckCommand`: `npm|pnpm|yarn|bun` with `test`, `t`, or a script named `test`, `lint`, `typecheck`, `type-check`, `check` or `tsc` (with `:suffix`s, minus `fix`, `write`, `format`, `update`, `snapshot` and `clean`), directly or through `run`; `make` with such targets; `cargo test|check|clippy`, `go test|vet`; `tsc --noEmit`, `eslint`, `jest`, `vitest`, `mocha`, `pytest`, `ruff`, `prettier --check`, `biome check|lint|ci`, `node --test`, `python -m pytest|unittest`; and `npx|pnpx|bunx` of those. Any `--fix`, `--write`, `--apply`, `-u`, `--update*` or `--output` flag makes the command a denied one.
- `git` is limited to reading: `diff`, `log`, `show`, `status`, `blame`, `grep`, `ls-files`, `rev-parse` and the other plumbing readers, `branch` and `tag` without a name or a writing flag, `remote -v`, `worktree list`, `stash list|show`, `config --get|--list`, and nothing with `--output`. `push` keeps the worker's refusal.
- `gh` is read-only, whatever the planner may write (DROVE-104): `pr view|list|diff|checks|status`, `issue view|list|status`, `release`, `run`, `workflow` and `repo` `view|list`, `label list`, `auth status`, `search`, `status`, and `gh api` with GET only (a non-GET `-X`/`--method`, in either spelling, or `-f`/`-F`/`--field`/`--raw-field`/`--input` is denied). `pr merge`, `issue comment`, `release create`, `pr checkout`, `repo clone` and the rest are denied, so the planner's `production` rule is moot for it.
- `drove` keeps the worker's list (`roster`, `capture`), so `drove init`, `spawn` and the other planner commands are denied, and `herdr` writes and other agent sessions stay denied.

The guard reads arguments only. A test, a lint rule or a script the repo defines runs the repo's own code, which may write: the role is a seatbelt against a reviewer's mistakes, not a sandbox. A tester has no guard of its own: it is an implementer with `owns` defaulted.

The `--help` and `--version` exception fixes a real annoyance: the mod denied `claude --help` to this worker while it wrote this design.

**`claude plugin test`** (DROVE-39). It runs a mod's test file and starts no session, so a worker may run exactly `claude plugin test` with at most one directory argument and no flags, including through the real binary's path (`~/.local/bin/claude plugin test mod`). Every other `claude` or `codex` command is still denied to it (`claude`, `claude -p`, `claude --resume`), and the planner gets no exception. A user's zsh `claude` function injects `--dangerously-skip-permissions` before `plugin`, which breaks the subcommand in Claude itself, so the worker must call the real binary [proven: a worker ran `~/.local/bin/claude plugin test mod` itself, 38/38].

The writable roots (`isInside`) are resolved after `realpath`, so `/tmp/../repo` does not count as `/tmp`.

**Planner scratchpad** (DROVE-101). A planner in a Claude Code session may write in that session's scratchpad: a path under `/tmp`, `/private/tmp` or `tmpdir()` shaped `claude-<uid>/<project>/<session>/…/scratchpad`, checked after `realpath` so `..` and symlinks do not count. Every write target of the command must be inside one; a glob or variable before the `scratchpad` segment, a plain `/tmp` path and a mix of targets are denied. Interpreters, `chmod` and the rest of the file writers stay denied, and the worker rules are unchanged.

**`drove init <dir>`** (DROVE-101) makes a new repo for a goal that needs one: it creates `<dir>` (with parents) if missing or empty, runs `git init -b main` and makes one empty commit, `chore: initial empty commit`. It refuses a non-empty directory, an existing repo and a directory inside a repo. `--json` prints `{path, branch, commit}`. The planner then attaches the run there (`/orchestrate --repo <dir>` in the mod, `drove plan` from the directory otherwise), because a run is bound to the repo of the session's cwd.

### Ledger, next steps and thrash (DROVE-121)

Strands Agents' interventions return a typed action, record it and escalate; the guard now does the same for a denial.

**Rules.** A denying `GuardDecision` carries a stable `rule`, so a denial can be counted and grouped:

| Rule | What it covers |
|---|---|
| `owns` | an edit, write or redirect outside a worker's `owns` |
| `reviewer-readonly` | a reviewer seat's edit, writer, runtime, `git` or `gh` write |
| `planner-edit` | the planner's Edit, Write, MultiEdit, NotebookEdit or `apply_patch` outside the writable roots |
| `planner-shell` | the planner's file writers, runtimes, package tools, `curl`/`wget` writes and redirects |
| `push` | a worker's `git push` |
| `production` | a push or a `gh` call that names the `production` branch |
| `herdr` | a `herdr` write |
| `merge-gate` | a seat branch merged by hand, `gh pr merge`, `drove merge --no-checks` |
| `agent-launch` | `claude` or `codex` started from a session |
| `drove-cli` | a `drove` subcommand the role does not have |
| `github` | a `gh` call that is the human's (deletions, settings, a public repo, `gh api` writes) |
| `run-state` | a worker's write into Drove's run state (`~/.drove`, `$DROVE_HOME`), where its own `owns` live (DROVE-119) |
| `unreadable` | a call the guard cannot read: no command text, no path, a command name or a path that is a variable, nesting too deep |
| `guard-error` | the guard itself failed (below) |

**Ledger.** Every denial is one `guard.denied` event in the run's `events.jsonl` (the earlier `guard.deny`, which had no rule, is read as a denial of rule `unknown`): `seat` (`planner` for the planner), and `data` with `tool`, `rule`, the clipped `command` or `path`, and the clipped `reason` (the refusal without its role note and next step), each part at most 200 characters, so a line is far below the 8 KiB cap. Allows are never written, and a denial stands when the log cannot be written. The ledger costs one appended line on a denial and nothing on an allow.

**Next step.** Every denial text ends with `Next step: <one concrete thing to do>`, chosen by the rule and the role (a worker's `push`: "commit your work on your branch and report done; the planner merges and pushes"; a reviewer's: "put what you found in your report"; the merge gate: "merge it with the drove merge tool"). Where a call has a more specific step (`gh pr merge`, `git merge <seat branch>`) the call supplies it. The `owns` text is the exception: it already ends with its own step (send a question report asking the planner to add the path to its owns with the set_owns tool).

**Thrash.** A seat that keeps meeting one rule is stuck, and nothing else shows it. When a worker's denial is the `count`th of one rule within `minutes` and no report from that seat came between them, the hook raises an attention item with reason `guard-thrash`: a line in the seat's `attention` list (kept across the watcher's polls, like `pending-delivery`) and an `attention` event with `data.rule`, `data.detail` and `data.count`. Its text names the rule and the last refusal: `w-api hit the guard's owns rule 3 times in 10 minutes and has not reported since; last refusal: …`. Limits are `guardThrash: { "count": 3, "minutes": 10 }` in `~/.drove/config.json` (a part that is not a whole number of at least 1 keeps its default).

- *The planner's, not the human's.* `guard-thrash` is a planner item like `stalled` and `budget` (`isForHuman` is false): it is not "needs you" on any board and not in `drove attention`. It is the seat row's text on the terminal, web and mod boards (all three read the same `buildBoard`), a notice to the planner in the timeline (`feedOf`), and a "For you to act on" line in the next wake.
- *Once per seat and rule.* The count and the "already raised" check read the ledger, from the last 512 KiB of `events.jsonl`, and the seat's roster entry (an item it still holds is raised, whatever the ledger tail shows; a report the roster already holds ends the count before its event is written). They run under a per-seat lock, so two hooks of one seat that deny at once raise one item; a lock that stays busy for 250 ms skips the escalation (a stale one is stolen after 2 s), because a denial must never be slow and the next denial counts again. Different rules raise their own items. The planner is not escalated about itself.
- *Announced once.* The next wake carries each item once; a watcher that starts later (a restart) treats items older than itself as announced.
- *Cleared by a report.* The watcher drops a seat's `guard-thrash` items when it ingests any report from that seat, a progress report included; a report also starts a new count (denials before it no longer add up).
- *Cost.* Nothing is read on an allow. A denial of a worker reads a bounded tail of the ledger once.

**Fail mode.** What the hook does when the guard itself fails (it throws, the roster it needs is unreadable, or the hook's stdin is not a JSON object):

| Seat | `pre-tool-use` | other events |
|---|---|---|
| planner | refused, exit 2, rule `guard-error`: "the guard could not check this call (…), so it is refused" | the record is skipped and the call goes on |
| reviewer seat (`DROVE_SEAT_ROLE=reviewer`) | refused, as the planner | as the planner |
| any other worker (implementer, tester) | allowed, as before: a broken guard must not stop an implementer, and only its `owns` check is lost | as the planner |
| no Drove identity in the env | allowed: not a Drove session | allowed |

`failsClosed` in `src/hooks.ts` is the one place that says which. A worker whose `DROVE_OWNS` cannot be parsed has no `owns`, as before. The refusal itself is written to the ledger as `guard-error`.

### Merge gate (DROVE-92, DROVE-105)

Until this, the planner merged after reading the diff and Drove had no say. Now the guard denies the planner a `git merge` whose argument names a seat branch (`worktree-<seat>` or `drove/<seat>`, also as `origin/...`, `refs/heads/...` or with `~n` or `^`; every branch Drove creates has one of the two prefixes, so the roster need not be read), and `drove merge <seat>` is the way in. It lives in `src/commands.ts` (`merge`), is exposed as the planner tool `merge` and the mod's `merge_worker`, and fails closed: a run that cannot say its checks passed does not merge.

**Where the checks come from.** `checksOf(repo)` reads `checks` from `<main checkout>/.drove.json` (an array of shell commands; `[]` declares none), else `repoVerifyCommands`: the `typecheck`, `lint`, `test` scripts of `package.json` or the `typecheck`, `lint`, `test`, `check` Makefile targets, the same detection that fills a worker's brief footer. None found refuses with how to declare them. It reads the base, not the seat's worktree, so a branch cannot edit its way past its gate; it does not stop a branch that rewrites the script a check runs (`npm test` running `true`), which is review's job. The checks run with `sh -c` in the seat's worktree, with the `DROVE_*` identity variables blanked, each with a 15 minute limit.

**What is tested.** The branch tip, in its own worktree, which must have no uncommitted tracked or untracked changes (untracked files under `.claude/` are ignored). The merge result is not tested: when the base moved on since the branch was cut, a local merge can combine two green branches into a red one. `--pr` tests the merge result, because GitHub's `pull_request` workflows run on the merge ref.

**Local.** The main checkout must be on the run's base branch (`run.base` without `origin/`) and clean (`git status --porcelain`, ignoring untracked `.claude/`). After the checks, `git merge --no-ff -m <msg> <branch>`; a failed merge is `git merge --abort`ed. The message is `-m` or `merge: <the branch's last commit subject>`. Nothing is pushed.

**`--pr`.** In order: a repo with no `.github/workflows` (in the main checkout or the worktree) runs the local checks first, before anything leaves the machine. Then `git push origin refs/heads/<branch>:refs/heads/<branch>` (explicit refspec, no upstream, no force, never the `production` branch), `gh pr view <branch>` (else the open PR from `gh pr list --head --base --state open`, else `gh pr create --head --base --title --body`), then the PR is judged: closed, conflicting or changes requested is refused; `gh pr checks --json name,bucket,link` with a `fail` or `cancel` bucket is refused by name; a `pending` bucket, a repo with workflows and no check reported within `CI_GRACE_MS` (10 minutes), or `reviewDecision: REVIEW_REQUIRED` returns `pending` with the PR URL and records `merge.pending`; no checks at all, outside the grace, runs the local checks. Green is `gh pr merge <n> --squash|--merge --subject <msg>` (no `--delete-branch`: gh would try to delete the local branch, which a worktree holds), a re-read of the PR state by number (retried after 1, 2 and 4 s before it is refused), `git push origin --delete <branch>`, then `git fetch origin <base>` and `git merge --ff-only origin/<base>` when the main checkout is on the base and clean (otherwise a note says the local base was not updated). Rerunning a pending merge is idempotent: the push is a no-op and the PR is reused; a PR already MERGED on GitHub is settled before anything is checked or pushed: it goes straight to the remote branch deletion and the base update. A MERGED PR is trusted only when its head (`headRefOid`) is the branch tip, or the sha just pushed, because branch names are reused across runs and `gh pr view <branch>` can return an old merged PR of the same name. A 5xx, a network error or an empty answer from `gh` on the checks read is `pending` with the PR URL, not a refusal.

**Record.** `merge.passed`, `merge.refused` (with a `code`: `checks-failed`, `dirty-checkout`, `wrong-branch`, `merge-conflict`, `no-checks`, `pr-conflicts` and so on) and `merge.pending` are appended to the run's events with the seat, branch, mode and detail, and the last result is kept on the seat as `gate` for the board line (it is hidden once the seat reports again). Refusals before a seat is found (no such seat, not the planner) record nothing.

**Check evidence (DROVE-122).** The check runner lives in `src/checks.ts` (`runChecks(deps, run, seat, { fresh?, plan? })`), apart from the merge: the gate, `drove checks` and the planner's `run_checks` tool all call it. Each command it runs appends one line to `<run>/checks.jsonl`: `{ seat, command, cwd, sha, clean, exit, durationMs, at, tail }`. `sha` is the worktree's HEAD, `clean` is true when `git status --porcelain` showed nothing before the command and after it (as in the gate, untracked files under `.claude/` do not count), so a check that edits files (`lint --fix`, snapshots, codegen) records `clean: false` and so does every later command of that run, and `tail` is the last 40 lines and 2 KiB of output with colour codes removed (cut further when its escaped JSON would pass the 8 KiB line cap). The commands run in order and the first failure stops the rest, which get no record. Each run also emits a `checks.ran` event (`sha`, `clean`, `passed`, `commands`, `ran`, `durationMs`, and `failed` and `exit` on a failure), and sets the seat's `checks` on the roster for the boards.

*The reuse rule.* A run is skipped when the ledger is intact (every line parses and ends in a newline: a torn or hand-edited line means no reuse, because a newer failing record that cannot be read must not let an older pass win) and, for every command of the plan, the newest record for this seat, command, worktree and HEAD has `exit` 0 and `clean` true, and the worktree is clean now. A new commit, a dirty tree (now, or when the record was made), a missing or failing record, a changed plan, or `fresh` means the whole plan runs again; evidence is all-or-nothing, never mixed with new runs. The merge gate then reports `checks reused: passed at <sha7> <time>` in the `merge.passed` detail and sets `checksReused` on the event; `--pr` in a repo without CI takes the same path through the same closure, and the PR path is otherwise unchanged. Evidence is a statement about the branch tip, not about the merge result, exactly as before.

*Pinned to the checked commit.* After the checks pass, or are reused, the gate reads `refs/heads/<branch>` and refuses with `head-moved` unless it is the sha the checks ran at (a worker that committed since, switched branches or detached HEAD in its worktree would otherwise have an unchecked commit merged). The local merge then merges that sha, not the branch name (`merge.passed` carries `checkedSha`), and `--pr` pushes `<sha>:refs/heads/<branch>`; a late local check on the PR path must match the sha already pushed. `--no-checks` has nothing checked to pin and merges the branch as before.

*The planner tool.* `run_checks` (`drove checks`) answers per command: passed, FAILED with its exit code and output tail, or skipped; the commit; whether the tree was clean; and whether it reused evidence. A failing check is a result, not a tool error. A dirty tree runs and records, but the answer says it is not evidence a merge reuses. The tool runs the commands the worktree's own scripts define, as the merge gate does; Drove itself writes nothing to the repo, only `~/.drove`. A worker cannot call it.

*Showing it.* `Seat.checks` is `{ result, sha, clean, at, failed?, stale? }`. The watcher reads each such seat's worktree HEAD on its poll and sets `stale` while it differs from `sha`. The roster line reads `checks passed at <sha7>`, `checks failed: <command> at <sha7>` or `checks stale: ..., HEAD has moved`; the terminal and mod boards show `chk✓`, `chk✗` or `chk~` in a column that appears once any open seat has run its checks; the web panel has a `checks` field. `drove report` adds a `chk run/fail` column from the `checks.ran` events.

**`--no-checks`** skips the local checks (GitHub's checks still apply under `--pr`). It is the human's: the guard denies it to the planner, and the command refuses it when it runs inside a Drove session (`DROVE_RUN` set), so the human runs it from their own terminal with `--run ID`.

Stricter planner denials added in P2:

- `eval`, `source` and `.` (they run text the guard cannot see)
- `find` with `-exec`, `-delete` or `-fprint`
- `xargs` with an unwrapped command
- a command name taken from a variable or a substitution
- an absolute-path script inside a writable root
- a bare `> file` redirect
- nesting deeper than 6 levels
- `apply_patch` heredocs, checked against the writable roots
- redirect targets containing `$` or a backtick

## 7. State detection

Signals, by freshness:

1. **Hooks** (`seats/<seat>/hooks.jsonl`, written by `drove guard <event>`):
   - Claude: `SessionStart` (session id, ready), `UserPromptSubmit` (a prompt arrived; working), `Stop` (turn ended), `StopFailure` instead of `Stop` when an API error ended the turn (`error`, recorded as `stop-failure` with the error and its details; DROVE-69), `Notification` with a `notification_type` such as a permission or idle prompt (needs input) [docs].
   - Codex: `SessionStart` (thread id), `UserPromptSubmit` (working), `Stop` (turn ended), `PermissionRequest` (needs input, with a reason) [openrig proven; our inline form needs verifying].
2. **The outbox**: a report changes the seat's turn state (`done` means it waits for review; `question` and `blocked` mean it waits for an answer).
3. **herdr** `agent list` polled every 5 s by the planner server: `working`, `idle`, `done`, `blocked` or `unknown` [proven, based on the screen or OSC title, can lag by about 7 s]. The seat disappears from the list when its pane is gone.

`detect.ts` exposes a pure `deriveState(prev, signals, now) → { state, attention[] }`. Precedence: needs-input (hook) > `blocked` (herdr) > report-owed (outbox) > `working` (an open turn, or herdr) > `idle`/`done`. A turn is open when the latest `UserPromptSubmit` has no `Stop`, `StopFailure` or `SessionStart` after it (DROVE-108); herdr flips a busy seat to idle after a prompt is typed into it, so an open turn wins over herdr's idle. An interrupted turn fires no `Stop`, so the open turn is trusted only while the prompt or the transcript's last write (the watcher stats the path a hook record carries) is under 5 minutes old. A seat that owes an answer or a review counts only a prompt that came after its report. No herdr agent for the seat → `gone`, unless the seat is `starting`, or is being restarted (below).

**Restart in progress** (DROVE-41). A promote or a relaunch stops the agent and starts it again in the same pane, and in between herdr has no agent for the seat, which used to read as `gone` and raised a false "pane is gone" attention. So `promote` and `up`/`up --seat` call `markRestarting` before they stop the agent: it merges `state: starting`, `stateAt` and a durable `restartingSince` into the live seat record (a merge into the roster, never an upsert of a stale copy). Writing `starting` alone is not enough: the watcher's next poll overwrote it before `/quit` had finished [seen live; the first fix failed]. While `restartingSince` is younger than `RESTART_BOUND_MS` (2 × the 20 s exit wait + the 60 s start timeout = 100 s), `deriveState` returns the seat as it is, and `applyDerived` and the watcher's merge leave it alone. After the bound, a seat with no agent reads `gone` even if it is marked `starting`, so a restart that never finished is still caught. `restartingSince` is cleared in a `finally` in `promote` and in the relaunch, and by `restoreState` when the stop failed. [proven: a Codex seat promoted and demoted with restart and resume raised no `gone` event or attention.]

**Session id.** The watcher's poll copies the `sessionId` of a seat's latest `session-start` hook record (or any record that has one) into the roster when the seat has none, as `refreshRoster` does (DROVE-30). The hook records are the source for Codex, whose thread id herdr only learns after the first turn.

**Attention list.** These are items for the human, shown on the board and in `roster`, and given to the planner in its next wake or piggyback:
- a dialog or permission prompt;
- a hook-trust prompt;
- a Claude folder-trust prompt;
- a channel confirmation;
- **the Codex "Background server has incompatible feature settings" dialog**;
- a usage limit (`usage-limit`, "w-x hit its usage limit (resets 2pm)"; the seat is never nudged);
- a stalled prompt;
- idle without a report;
- a gone pane;
- a budget request;
- a seat with `reviewLoopLimit` changes verdicts (default 3): `review-loop`, cleared by approval, promotion, migration or closing;
- a run above optional `runMaxCost`: one durable `run-budget` item for the human.

Seat budgets add `maxMinutes` (wall time since `spawnedAt`, including time the seat was down) and `maxCost` (USD transcript cost from the report price table) beside `maxTurns` and `maxTokens`. Both are spawn CLI flags and planner tool fields, stored in the roster and preserved across promote, up and migrate. The existing watcher poll checks them and sends the same one-time budget notice; it never kills a seat. Unknown model prices do not trip a cost bound. The run-cost warning is recorded as an attention event, so watcher restarts cannot repeat it.

**Dialog detection.** When `agent start` returns `agent_not_ready`, when a seat turns `blocked`, or when a seat is not `working` and no `session-start` or `user-prompt-submit` hook has fired yet (the Codex hook-review dialog shows as `idle`, not `blocked`), Drove reads `herdr agent read <seat> --source visible --lines 40` and matches a regex table. The visible screen is used because Codex draws on the alternate screen, which never reaches the scrollback sources:

| Pattern | Attention reason |
|---|---|
| `/^You've hit your usage limit/m` (Codex; "… or try again at 2:00 PM.") | `usage-limit` |
| `/^You've (hit\|reached) your …/m`, `You're out of usage`, `Your org is out of usage` (Claude; "You've hit your session limit · resets 2pm"; "fast limit" is excluded, it is a status-line cooldown) | `usage-limit` |
| `/Background server has incompatible feature settings/` | `codex-version-mismatch` |
| `/trust (this\|the files in this) folder\|project you created or one you trust/i` | `trust` (Claude: "Do you trust the files in this folder?") |
| `/hooks? needs? review\|hooks? (is\|are) new or changed/i` | `hook-trust` (Codex: "1 hook needs review before it can run"; hint: approve Drove's hooks once in the pane, Codex remembers them) |
| `/hook.*trust/i` | `hook-trust` |
| `/trust the contents of this directory/i` (added to the folder-trust row) | `trust` (older Codex folder trust) |
| `/Update available\|Update now \(runs/` | `dialog` (Codex update prompt; choose Skip) |
| `/Codex just got an upgrade\|Try new model/` | `dialog` (Codex model migration) |

**Usage limit.** A seat that stopped after working with no report since its last working time also has its visible screen read, not only a blocked or hook-less one, so a limit screen that herdr shows as `idle` is seen. The match is anchored at a line start so a diff or a transcript quoting the text does not trip it. The detail carries the reset time the screen shows ("hit its usage limit (resets 2pm)"); the seat reads `blocked` and `needsNudge` never fires for it. The strings come from Claude Code 2.1.296 and Codex's native binary. For Claude there is a second, durable signal (DROVE-69): the `StopFailure` hook, which fires instead of `Stop` when an API error ends the turn (`error`: `rate_limit`, `billing_error`, `overloaded`, `authentication_failed`, `server_error`, …; `error_details`; `last_assistant_message`; fire-and-forget) [Claude Code 2.1.296]. Drove records it as `stop-failure` with detail `<error>: <details>`, and a `rate_limit` or `billing_error` record gives the same `usage-limit` item ("hit its usage limit (rate_limit)", or the reset time when the details carry one) with no limit text on screen, so the item survives the text scrolling away. It holds until a later `session-start`, `user-prompt-submit`, `pre-tool-use` or `stop` record. Other errors are recorded and raise nothing. The planner's options are to wait for the reset, close and respawn, or migrate the seat (§8).

**Start failures.** Whenever `herdr agent start` fails or times out (in `spawn`, `promote` and `up`), Drove first runs the adoption check of §5 (a live agent of the expected kind in the pane and no dialog keeps the seat; `promote` and `up` keep it and send the control, `seat` is marked gone or the pane closed only when it is absent or a dialog matched). Before any rollback closes the pane, Drove reads the pane twice, `herdr agent read <seat> --source visible --lines 60` and `--source recent-unwrapped --lines 60` (each falling back to `herdr pane read <pane>`), and saves both to `seats/<seat>/start-failure.txt` (mode 600) under `== visible screen ==` and `== recent output ==` headings, appends a `seat.start_failed` event with the herdr error code and the first matching dialog reason from this table, and puts a one-line hint in the error ("Claude is asking to trust the folder") with the file path.

`codex-version-mismatch` carries the detail "Codex CLI and app-server daemon versions differ (`codex --version` vs the daemon); align them. Drove will not answer the dialog". Drove never answers a dialog itself.

**Idle without a report.** After a seat goes from working to idle with no report since its last working time and a 20 s grace, Drove sends one `nudge` control ("You stopped without a report: send done, question or blocked"). This is the mod's `idle-without-report`, delivered by Drove for both kinds. It is sent once per working episode.

## 8. Promote and demote

| Kind | Recommended | How |
|---|---|---|
| Claude worker, mod present | **Per-request switch** [proven in the mod] | Drove updates the seat's model and effort in the roster and sends a `promote` control. The mod, running inside the worker, reads its seat from the roster and applies it in `turn.step` from the next request. A verified notice tells the worker its new model, says it needs no reply, and the mod files a `progress` report itself when that turn ends, so the worker is not read as idle without a report (§10). |
| Claude worker, no mod | **Restart with resume** | Wait until the seat is idle. Mark it restarting (§7). Close its pane with `herdr pane close`; **never `/exit`**, which opens the keep-or-remove worktree dialog (§5, "Stopping a Claude worker"). Then clear a stale worktree lock (§5), place a new pane with cwd = the seat's worktree (the `up --seat` path; the grid slot may move), and `herdr agent start` with the same spec plus `--resume <session id> --model M --effort E`, then the promote control sent by `herdr agent prompt` once the agent is ready (it is multi-line, so never a launch argument; a prompt `timeout` is delivered-unconfirmed). |
| Codex worker | **Restart with resume** [proven: live promote and demote under a Drove-owned `CODEX_HOME`; the session kept its history and role, and its turn context shows the new effort] | Wait until idle. Mark the seat restarting (§7), send `/quit`, then `codex resume <thread> [-m M] -c model_reasoning_effort=E` in the same pane with the seat's recorded `CODEX_HOME` (§5), then the promote control by `herdr agent prompt`. The thread id is the roster's `sessionId`, or else the hook record's (DROVE-30); with neither, `promote` fails with `no-session`. `-m` is passed only when the seat has a model, so a Codex seat spawned on Codex's default model is promoted by effort alone [`resume -m` changing the model: docs; verify]. Cheaper candidates to verify later: `codex queue -m M` (the help lists `-m`, but it may be a shared global flag), and app-server `turn/settings/update` (needs a control-socket client; skipped in v1 because of the version coupling seen in the daemon handshake warnings). |

A restart is refused while the seat owes a report or is mid-turn. `promote` returns "queued until idle" in that case, and the watcher completes it. That wait is only for `promote`, which replaces the agent: `close` and `down` are the planner's or the human's request to stop now, so they close the pane without waiting for idle, and the turn in flight is picked up by the resume notice on `up`.

### Migrate (DROVE-69)

A conversation cannot move between Claude Code and Codex, but the work can. `drove migrate <seat> --kind claude|codex [--model M] [--effort E] [--reason TEXT]` is built like a promote restart, with no resume and no wait for idle (the usual case is a seat stopped at its usage limit):

1. Before anything stops, it builds a handoff brief: "You replace a <kind> worker that hit its usage limit (or was migrated); its turn in flight is lost", the reason, the saved `seats/<seat>/brief.md` (a worker role saved in front of an older Codex brief is cut), `git log --oneline <base>..HEAD`, `git diff --stat HEAD` and `git status --short` in the worktree (40 lines each at most), and the seat's last three reports from `outbox.jsonl` (summary, kind, expects and clipped details; never the token).
2. `markRestarting` (§7), then `stopAgent`: a Claude seat's pane is closed, a Codex seat gets `/quit` and its pane is closed too, because the pane's env belongs to the old kind (`DROVE_AGENT`, `CODEX_HOME`). A stale Claude worktree lock is cleared, and the seat's Cairn claim is released with `cairn release --force` so the new agent can claim the task.
3. The other kind starts in a new pane with cwd = the seat's worktree. Codex gets `-C <worktree>` and the run's `CODEX_HOME`; Claude gets a fresh `--session-id` and **no `--worktree`**. Both get the run's worker role and the seat's MCP and skill allowlists, and the handoff goes in as a `brief` control expecting a review.
4. The roster keeps the seat's name, worktree, branch, token, Cairn ref and last report, takes the new kind, model, effort, session (Claude's minted id; Codex's from herdr or the hook), sets or drops `codexHome`, and records `migratedFrom: { kind, sessionId, model, at, reason }`. A `seat.migrate` event carries `from`, `to`, model, effort, pane, worktree, branch and reason.

**Why Claude starts without `--worktree`.** `--worktree <seat>` would try to create the worktree. Claude Code 2.1.296 checks folder trust at `projects[<canonical repo root>].hasTrustDialogAccepted` in `~/.claude.json`, and resolves a linked worktree (a `.git` file pointing at `<repo>/.git/worktrees/<name>`, with `commondir` and a `gitdir` backlink) to its main repo, so a worktree made by `git worktree add` in a trusted repo is trusted [read in the 2.1.296 binary, the functions around `hasTrustDialogAccepted`; `~/.claude.json` holds no per-worktree entries]. If a later version prompts anyway, the start ends `agent_not_ready`, the seat is marked `blocked` with the `trust` item and the handoff waits in the queue.

**Failures.** A seat that does not stop is restored and nothing changes. If no pane can be placed or the new agent never starts, the pane output is saved as for any start failure (§7), and the seat goes back to its old kind, session and `codexHome`, marked `gone` with "migrate to <kind> failed …; `drove up --seat <seat>` resumes the <kind> session, or run `drove migrate` again". Migrating to the seat's own kind is refused (use promote).

### Seat roles (DROVE-91)

A seat has an optional `role` (`reviewer` or `tester`; absent is an implementer, so older rosters read unchanged) and, for those two, a `target` seat name. Both come from `drove spawn --role R --target SEAT`, are validated before anything is created (a target is required, must be another seat of this run and cannot be a reviewer; `--owns` is refused for a reviewer; `--target` with no role is refused) and sit on the seat beside `plugins` and `userMemory`. `identityOfSeat` builds the identity for spawn, promote, `up` and migrate alike, so the env (`DROVE_SEAT_ROLE`, `DROVE_OWNS`) and the role text (`workerRole(run, config, seat.role)`) follow the seat through every relaunch.

- **Reviewer worktree: the run base, plus a pointer.** The two options were a worktree at the target's branch head, or the target's diff against the run base read from where it lives. The first sees nothing at review time: a worker commits only after approval, so the target's branch head is still the base. The second works for committed and uncommitted work, needs no second worktree path and reuses the normal spawn, so a reviewer starts like any seat and its brief's last line names the target's worktree, branch and brief file (`seats/<target>/brief.md`, the stored brief) and the commands: `git -C <worktree> diff <base>` and `git -C <worktree> status --short` for the work in the tree, `git diff <base>...<branch>` for what is committed. The checks run in the target's worktree.
- **Tester worktree.** Branches from the head of the target's branch: a Claude seat takes `claudeBase = <target branch>` in `alignClaudeWorktree` (a fast-forward, since Claude created it from an ancestor), a Codex seat `git worktree add -b drove/<seat> <path> <target branch>`. `--base` is ignored with a note. The target's branch must exist, and the spawn result warns when its worktree has uncommitted changes. The planner merges the tester's branch after the target's.
- **Role text.** `workerRole(run, config, role)` has one text per role: `# Worker mode` (pinned by `test/fixtures/worker-role.implementer.txt`), `# Reviewer mode` and `# Tester mode`. None names a seat; the footer of the brief does, so every seat of a role shares one cached prefix (DROVE-72). The reviewer text says to review the target's diff against the target's brief and to report `done` with `expects: review`, a recommendation, findings with file:line and the check results; it says the target's Cairn task is its implementer's and must not be claimed. The tester text says to write tests only, to report a failing test rather than weaken it, and to report the tests added and what they caught.
- **Planner text.** `plannerRole` (`src/prompts.ts`) and `orchestratorSection` (`mod/hooks/prompts.ts`) have a short "Reviewer and tester seats" paragraph: when to use them, how each reports, and that each takes a pane of the budget.
- **Board.** A seat with a role gets `R` or `T` in a one-column cell after its name, only when the run has such a seat, and `drove roster` prints `reviewer of <target>`.

## 9. Resume

- `drove down`: for each open seat, makes sure the session id is known (Claude: minted at launch; Codex: hook record or herdr), then stops the agent (a Claude seat by closing its pane, never `/exit`; a Codex seat with `/quit`, then the pane), closes the tab, writes `run.json` with `status: down`, and appends `run.down`. The planner's session id is saved too. Worktrees and branches stay. For a run with a goal task, the summary note ends with the run report's totals and one line per seat (§1, `drove report`); a report that cannot be built is left out.
- `drove up`: picks the newest `down` run for this repo (or `--run`), recreates the tab and grid, and relaunches each seat with its launch spec plus `--resume <id>` (Claude) or `resume <id>` (Codex, under the `CODEX_HOME` recorded on the seat: a Codex session lives under that home, and a legacy seat with none resumes from `~/.codex` with the inline spec); each relaunch is marked restarting (§7) and recorded as a `seat.relaunch` event (below); before a Claude seat starts, a stale worktree lock left by the closed pane is cleared (§5). A seat that owed the planner nothing gets no initial prompt. A seat that was mid-task gets "Resumed by Drove after a restart: carry on, and report when done", sent by `herdr agent prompt` after `agent start` returns (a launch argument only with `briefVia: "launch-arg"`, §5), because a resumed turn can outlast the start timeout just like a first brief. Unconfirmed on a prompt timeout; a failure before anything is typed leaves the seat idle with a `pending-delivery` attention item. Last, `drove up` `exec`s the planner with its resume argument in the current pane.
- A dead seat (pane gone without a `close`) is shown as `gone` with the one-step fix: `drove up --seat <seat>` relaunches only that seat. This is the recovery path openrig lacked.
- **Crash recovery** (DROVE-67). A crash, a reboot or a herdr restart leaves the run `up` with no panes and no watcher to mark anything `gone`. `drove up` on an `up` run probes the planner pane and every open seat's pane with `herdr agent get` (pane id first, the seat's agent name when it has none). If any is alive it refuses and names it; if herdr cannot answer (anything but not-found) it refuses too, and a seat with a fresh `restartingSince` also stops it. Otherwise it marks each open seat `down`, keeping its saved session id (from the roster, else the hook record) and `codexHome`, appends `run.recovered` with the adopted seat names, and resumes as usual. `drove up --seat` likewise accepts a seat the roster still shows as working, idle or done when its pane is gone.
- **`seat.relaunch`** (DROVE-19). Every relaunch, from `drove up` and from `drove up --seat`, appends one event whatever its outcome: `data` is `{ ok, resumed, pane }` on success and `{ ok: false, resumed: false, error, pane? }` on failure. Before it, a relaunch left nothing in the log between `gone` and the next state. The board prints it as "relaunched (resumed)" or "relaunch failed: …", and the mod's timeline shows it.

## 10. The mod as a thin layer

The Claude orchestrator mod lives in this repo at `mod/` (loaded by pointing `CLAUDE_CODE_PLUGIN_DIRS` at it). It keeps `/orchestrate` and the tool names (`mcp__orchestrator__spawn_worker`, `message_worker`, `review_verdict`, `promote_worker`, `demote_worker`, `migrate_worker`, `merge_worker`, `close_worker`, `roster`, and a worker's `report`) and adds Codex workers (`spawn_worker` takes `kind: claude|codex`).

**It cannot import Drove** (DROVE-9; this answers §13 Q5). Claude Code's plugin runtime has no Node and imports only files of the plugin, and every Drove module uses `node:fs`, `node:crypto` or `node:child_process`. So the mod reaches Drove through its CLI, `node <drove>/src/cli.ts …` (the path is `<mod>/../src/cli.ts`, or the mod's `droveEntry` setting), and keeps a copy of the run-state types in `mod/types/index.d.ts` that `test/mod-types.test.ts` holds to `src/types.ts`. `src/mod.ts` stays the facade for Node callers.

| Drove | How the mod uses it |
|---|---|
| `drove mod attach --session <id> --pane <pane> [--goal] [--budget] [--run]` (`src/modhost.ts`) | `/orchestrate` and a session restore: creates (or re-attaches) a run whose planner is this Claude session, `viaMod: true`, with no launch files and no exec. A later attach of the same session to the latest up run re-attaches it. A run with no goal takes the first human prompt to the planner as its goal: the mod's `prompt.submit` hook re-attaches with `--goal`, and the planner's `user-prompt-submit` guard hook (`src/hooks.ts`, any planner kind) writes `run.json`; wakes, envelopes, slash commands and empty text are skipped and an existing goal is kept. |
| `drove mod bridge --run <id> --session <id>` | One long-lived child per planner session (`$.process.spawn`), supervised with backoff. It runs `createWatcher` with `modWake` (the first wake transport for a `viaMod` planner), so cursors, batching, herdr polling, nudges (never while the planner owes the seat), pending flushes and queued promotes are all Drove's. It writes JSON lines: `ready`, `busy`, `fatal`, `run` and `roster` (with each Claude worker's `seats/<seat>/mod.json`) when they change, `events` (the last 60, then each new one), `wake` and `error`. It exits when its parent pid changes, when its lock is taken, or (code 4) when the run goes down or is attached to another session. |
| `planner/bridge.json` lock | One bridge per run. A live bridge of the **same** session is a leftover of a hot reload of the mod, so the new one sends it SIGTERM (SIGKILL after 3 s) and takes over; a live bridge of another session makes the new one stand down (`busy`, code 3). A bridge that exits releases the lock by writing pid `0`, and **a holder with pid `<= 0` is never signalled** (DROVE-46): `process.kill(0, …)` signals the caller's whole process group, so a restart of the bridge used to SIGTERM the planner's Claude Code with it, and every resume repeated it from the leftover marker. `isPidAlive` is likewise false for pid `<= 0`. |
| `drove spawn`, `send`, `promote`, `migrate`, `close`, `roster`, `goal`, `budget`, `down` | The bodies of the `mcp__orchestrator__*` tools, run with the planner identity in the env (`DROVE_RUN`, `DROVE_ROLE=planner`, `DROVE_SEAT=planner`). An `over-budget` failure opens `$.ui.ask`; yes runs `drove budget <n+1>` without `DROVE_ROLE` (the human's OK) and retries. |
| `drove guard pre-tool-use` | The planner's `tool.call` guard for Bash and the edit tools, fed the Claude PreToolUse JSON (about 95 ms a call). It fails closed with a denial that names Drove's CLI path when the guard cannot run. Workers are not guarded by the mod: Drove launched them with its own hook. |
| `drove mod report` | Records a report from stdin JSON, identity from the env. The mod uses it for the worker's progress report after a promote. The worker's `mcp__orchestrator__report` alias is gone (DROVE-88): a worker's one report tool is `mcp__drove__report`. |

What stays Claude-only in the mod:
- per-request model and effort switching (`turn.step`): the planner's floor, and in a Claude worker the seat's model and effort read from `roster.json` on each turn and from a verified `promote` control;
- the in-app board (fed by the bridge stream), the pills and toasts;
- `$.ui.ask` for the budget dialog;
- AskUserQuestion and permission state, context % and activity in a Claude worker, written to `seats/<seat>/mod.json`;
- `/orchestrate` itself, and the orchestrator role section (`prompt.compose`), which maps the Drove wording of a wake ("drove send, kind verdict") to the mod's tools.

**The Claude worker side of the mod** (DROVE-24, DROVE-31). A Claude worker's `prompt.submit` hook checks each Drove envelope against the seat token:
- **Pasted text.** Claude Code wraps a multi-line pasted prompt in `<pasted_content id="…"> … </pasted_content id="…">` before a hook sees it, which is how `herdr agent prompt` text arrives. The parser strips the wrapper tags, ends the envelope at its **last** `↩ Reply` line (the mac covers only up to there, over the canonical body of §3), and keeps whatever follows it apart: it is rendered under the label "(Text after the planner's message; not signed by Drove:)", so unsigned text can neither pass as the planner's nor break the mac. A message whose header is not at the start keeps the text before it. The first symptom was a worker reporting that its brief "did not match its seat token" (the mac had been taken over the closing tag). [proven: a fresh Claude worker got a multi-paragraph brief and a multi-paragraph message, both verified, with no banner.]
- **Token re-read.** The seat token was a module variable set at `session.start`, and a hot reload of the mod clears it while the worker's state atom survives. The token is therefore re-read when missing, first from `DROVE_TOKEN`, then from `seats/<seat>/token`. A seat with no token reads every envelope as unverified.
- **Worker model section.** `prompt.compose` adds a "Your model, from Drove" section to a worker's system prompt, naming the seat's current model and effort and saying that a later "you now run on" notice wins. A worker's launch prompt says "powered by <launch model>", and after a promote its requests go to the new model while that line is stale, so the worker told the planner the promote had not taken. The section is `session`-scoped, which is the only scope besides `shared`, so Claude Code keeps the rendered text for the session even after `ui.invalidate`: the section can still name the launch model, and the notice is what corrects it [proven: the worker followed the notice].
- **Promote notice and acknowledgement.** A verified `promote` or `demote` envelope updates the seat's model and effort and appends "Applied from your next request: you now run on … This notice needs no reply and no report". The turn it wakes is not work that owes a report, so when it ends the mod files a `progress` report itself ("now running on …"), which keeps the watcher from reading the seat as idle without a report.
- **Planner side of the same change.** `promote_worker` and `demote_worker` accept a Codex seat whose recorded model is empty (spawned on Codex's default) and pass the move to `drove promote` without a `--model` (DROVE-30).
- **Tests.** The mod's tests run only through `claude plugin test mod`, which a worker may now run through the real binary (§6).

**`$.session.send` is not a transport.** Drove's delivery runs inside short-lived CLI processes and the bridge, and a spawned child has no channel back into the mod (stdin is one-shot), so a `mod` delivery adapter would need a file handoff and an acknowledgement with two-phase failures. Claude workers therefore get Drove's guarded `herdr agent prompt` and Codex workers `codex queue`, the same as with any other planner. Workers spawned by the old mod (`⟦orch v1⟧` over `session.send`) are not adopted: the mod reports a leftover old-mod record once and deletes it.

## 11. Sequences

### (a) Claude planner (no mod) + Codex worker

1. **Spawn.** The planner calls `drove.spawn{seat:w-api, kind:codex, cairn:DROVE-7, brief}`. Drove runs `git worktree add -b drove/w-api --no-track .claude/worktrees/w-api origin/main`, mints a token, writes the run's `codex-home/` (§5), opens a grid pane with `CODEX_HOME` in its env, waits for the shell prompt, and runs `herdr agent start w-api-a3f1 --kind codex -- …spec…` with no prompt argument. When `agent start` returns (the agent is idle), the worker role and the brief go as the first control by `herdr agent prompt <pane> --wait`. The roster records `w-api`, with its pane and `codexHome`. The `session-start` hook writes the thread id, and the watcher copies it into the roster. The tool returns "running; reports will come to you".
2. **Report done.** `w-api` calls `report{kind:done}`, and a line lands in `seats/w-api/outbox.jsonl`. The planner MCP watcher reads it (cursor), verifies the token, updates the roster (`owes: review`) and appends a `report` event.
3. **Wake.** A channel notification goes out if the channel is active. Otherwise `herdr agent prompt <planner pane>` runs once the planner has been idle for 5 s or more. Otherwise the report is pending and rides on the next planner tool result.
4. **Review.** The planner reads `git -C .claude/worktrees/w-api diff main…` (read-only, allowed by the guard).
5. **Verdict.** `drove.send{seat:w-api, kind:verdict, verdict:approve}`. Drove sends `codex queue --thread <id> --message "⟦drove v1 … kind=verdict …⟧ …"`, records the control id in `sent.jsonl`, and sets `owes: none`.
6. **Commit confirmation.** `w-api` commits its own paths, then reports `done` with `expects: none`. The wake text says "confirms approved work; close it".
7. **Merge.** The planner calls `drove.merge{seat:w-api}`: Drove runs the repo's checks in `.claude/worktrees/w-api` and, when they pass, merges `--no-ff` into `main` in the main checkout. A plain `git merge drove/w-api` is denied by the guard (§6, Merge gate); with a remote and CI the planner passes `pr: true` instead.
8. **Close.** `drove.close{seat:w-api, removeWorktree:true}` sends `/quit`, closes the pane (and the tab if empty), runs `git worktree remove` (the branch is merged) and marks the seat `closed`. The planner then closes Cairn DROVE-7.

### (b) Codex planner + Claude worker

1. **Spawn.** The Codex planner calls the MCP tool `spawn{seat:w-ui, kind:claude, …}`. Drove opens a pane at the repo root, waits for the shell prompt, then runs `herdr agent start w-ui-a3f1 --kind claude -- … --worktree w-ui --session-id <uuid> …` with no prompt argument, and sends the brief by `herdr agent prompt <pane> --wait` once the agent is idle. The session id is known from the start.
2. **Report done.** `w-ui` calls `report` (server `drove`, from `--mcp-config`), and the line lands in its outbox.
3. **Wake.** The planner MCP server reads the line and runs `codex queue --thread <planner thread> --message "[w-ui · done · expects review] … → Review the diff, then call verdict."`. If the planner is mid-turn, it runs as the next turn.
4. **Review.** The planner reads the diff through its shell, which the guard allows as read-only git.
5. **Verdict.** The planner calls `send{seat:w-ui, kind:verdict, verdict:approve}`. This is a guarded send: `herdr agent get <pane>` is not blocked, so `herdr agent prompt <pane> "<envelope>"` runs. If the pane is blocked, the control waits in `pending.jsonl` and an attention item goes out.
6. **Commit confirmation.** `w-ui` reports `done` with `expects: none`, which reaches the planner through `codex queue`.
7. **Merge.** The planner calls the MCP tool `merge{seat:w-ui}` (or `pr: true`), which runs the checks and merges; the shell is not used for it.
8. **Close.** The planner calls `close{seat:w-ui}`, which closes the pane (no `/exit`, §5) and marks the seat closed.

## 12. Build plan

This is the plan as it was cut on 2026-10-09; all five pieces are built and merged, and the code (and §§5 to 10) is the reference where it differs. Five pieces with disjoint files. `src/types.ts` is frozen by this design: a piece that needs a type change asks the planner, and does not edit it. Every piece codes against the stub signatures already committed, and tests the other pieces through injected `Deps` (`Exec`, clock, `DROVE_HOME` in a temp dir). Nobody in a worktree can start `claude` or `codex` or drive panes, so the items under "human-run" are verified by the human afterwards.

### P1: core state and protocol
- **Files:** `src/paths.ts`, `src/store.ts`, `src/protocol.ts`, `src/roster.ts`, `src/prompts.ts`, plus their tests.
- **Provides:**
  - `paths`: run id, seat dirs, `identityFromEnv`;
  - `store`: atomic JSON, mkdir lock, JSONL append and read from a cursor, token files at mode 600;
  - `protocol`: report validation, control envelopes with MAC, render and parse, `defaultExpects`;
  - `roster`: seat CRUD, grid slot, budget, roster lines;
  - `prompts`: planner and worker role texts, brief footer, reply lines.
- **Consumes:** `types.ts` only.
- **Acceptance:** round-trip of envelopes and reports. A MAC mismatch is detected. Concurrent appends from 20 child processes leave no torn lines. A held lock blocks, and a stale lock is stolen. Roster writes are atomic: a kill mid-write leaves the old file. Token files are mode 600.
- **Human-run:** none.

### P2: guard
- **Files:** `src/shell.ts`, `src/guard.ts`, `src/hooks.ts` (stdin adapters for Claude and Codex, `HookRecord` writing), plus tests.
- **Provides:** `parseShell`, `bashReason`, `decide(GuardInput)`, `parseHookInput(agent, json)`, `renderHookOutput(agent, decision)`, `recordHook`.
- **Consumes:** P1's `paths`, `store` (append) and `roster` (read open seats for the planner's prompt exception).
- **Acceptance:** all of the mod's current deny cases still deny. The CCS-50 cases in §6 pass. The planner may `herdr agent prompt` an open seat, but not an unknown agent. `--help` is allowed. A push to `production` is denied for everyone. `drove guard pre-tool-use` exits 2 with a reason, and runs in under 150 ms on a cold Node start.
- **Human-run:** one Codex launch with the inline PreToolUse hook. Check the hook-trust prompt and whether it persists across launches, check that `apply_patch` is denied, and record the Codex hook stdin shape.

### P3: runtime (herdr, git, launch, delivery, detection, commands, CLI)
- **Files:** `src/herdr.ts`, `src/git.ts`, `src/launch.ts`, `src/deliver.ts`, `src/detect.ts`, `src/commands.ts`, `src/cli.ts`, plus tests.
- **Provides:**
  - argv builders and parsers for herdr;
  - worktree and branch creation with the git rules;
  - `claudeWorkerSpec`, `codexWorkerSpec` and the planner specs;
  - `deliver(control)` with the transport choice, guarded send and pending retry;
  - `deriveState` and dialog matching;
  - every command in §1.
- **Consumes:** P1 and P2 (`guard` for the `drove guard` command).
- **Acceptance:** with a fake `Exec`:
  - the spec argv for each kind and role matches golden files;
  - `spawn` issues tab create or pane split, then agent start, in order, and rolls back the pane on failure;
  - a blocked seat queues and does not type;
  - `codex queue` is chosen for Codex seats that have a thread;
  - the version-mismatch dialog text becomes a `codex-version-mismatch` attention item;
  - git `--no-track` is used, and `origin/main` versus `main` is chosen by remote presence (tested on a real temp repo).
- **Human-run:**
  - one Claude and one Codex worker launched through `drove spawn`, with the initial-prompt brief;
  - `--add-dir .git` commit from a Codex worktree;
  - `model_reasoning_effort` and `developer_instructions` keys;
  - pane close (Claude), `/quit` (Codex) and resume for promote, including a resume in a worktree Claude had locked;
  - `drove down` and `up`.

### P4: MCP server and watcher
- **Files:** `src/mcp.ts` (stdio JSON-RPC, tool registry), `src/tools.ts` (planner tools and the worker `report` tool), `src/watch.ts` (outbox cursors, wake transports, pending and piggyback, herdr polling loop), plus tests.
- **Provides:** `serveMcp(role)`, `PLANNER_TOOLS`, `WORKER_TOOLS`, `createWatcher`.
- **Consumes:** P1, plus P3's `commands` and `deliver` (stubs until P3 lands; tests inject fakes).
- **Acceptance:**
  - an `initialize` / `tools/list` / `tools/call` session over a child process, as in the spike's test;
  - `report` validates and appends;
  - the watcher reads a pre-filled outbox exactly once across restarts (cursor);
  - a Codex-planner wake calls `codex queue` with the planner thread;
  - a failed wake lands in pending, and the next tool result carries it;
  - `progress` does not wake;
  - reports within 2 s are batched.
- **Human-run, all passed live (DROVE-49, 2026-10-10):** a Claude planner with the dev channel (an idle session does take a turn); a Codex planner woken by `codex queue`; MCP elicitation support for the budget in both clients.

### P5: board and mod facade
- **Files:** `src/board.ts`, `src/mod.ts`, plus tests. The mod itself was rebuilt over Drove in `mod/` (DROVE-9, §10).
- **Provides:** `renderBoard(run, roster, events, attention, width)` (pure) and `runBoard` (refresh loop); `mod.ts` re-exports the facade listed in §10.
- **Consumes:** P1, plus P3's `detect`.
- **Acceptance:** golden frames at widths 80 and 140; the attention list is shown first; `mod.ts` exports exactly the documented names (a test pins the list).
- **Human-run:** `drove board` in a herdr pane during a real run.

**The web board (DROVE-79, DROVE-80).** `drove board --web [--port N]` serves the board to a browser. It is `src/web.ts` and `src/web/page.ts`.
- **Data.** It reads the run with `boardSource` and builds the model with `modelOf`, the same as the terminal board, at 400 columns and 1000 rows so nothing is clipped. The page draws the model's rows and cells itself in the Board view, with the `TONE_COLOR` palette, and wraps long cells. Nothing in `buildBoard` is copied. The payload also carries structured data so the page parses no cells (DROVE-81): `feed` is the board's feed without its hidden entries (`{id, at, from, to, kind, summary, full?}`, `at` in epoch milliseconds), `lead` is the planner's kind, model, effort and one line of activity, and each of `seats` adds `modelLabel`, `activity` (the board row's doing-cell, spinner cut off), `tone` (the state colour; alert while it needs you) and `needsYou` (it asks, is blocked or has an attention item). The chips and the clock work on that structured data, so `FEED_KIND_CELL` is gone.
- **Updates.** Server-Sent Events. One loop polls the run every `POLL_MS` and pushes a new model only when its JSON changes. The browser reconnects by itself, and the page shows "disconnected" while it cannot. Polling would have made each tab call the loader, and `boardSource` keeps a read cursor, so one shared loop is simpler.
- **Routes.** `/` is the page, `/api/board` is the current model as JSON, `/events` is the stream, and `/api/seat/<name>/tail` is the last 40 lines of an open seat's pane as plain text. Only GET and HEAD are answered; anything else is 405. No route changes state.
- **Seat detail.** Clicking a seat row expands a panel under it with the seat's kind, model, effort, state and age, branch, worktree, Cairn ref and session id, which ride on `/api/board` and `/events` as `seats`. The panel also shows the pane tail, read with `commands.capture` (the call under `drove capture`, so the herdr read is not repeated). The page asks for the tail every 4 seconds while a panel is open and stops when it closes. An unknown or closed seat is 404; a pane that cannot be read is 502. The commands to copy (`drove capture <seat>` and the worktree path) are text, not buttons.
- **Access.** It binds `127.0.0.1` only. A request is refused with 403 unless its `Host` is `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), its `Origin`, when it has one, is `http://127.0.0.1:<port>` or `http://localhost:<port>`, and its `t` query parameter equals a token made at each start. A request with no `Origin` is allowed, since curl and a same-origin `EventSource` may send none. No CORS header is ever sent, and the page's CSP allows no outside origin.
- **Page.** The colours follow `prefers-color-scheme`: the dark hues are `TONE_COLOR`, and the light theme darkens them in CSS. A Graph | Board switch (kept in `localStorage`, graph by default) picks the view; the timeline, the chips and the seat panel are shared by both.
- **Graph.** Hand-written SVG for the edges and the messages, HTML buttons for the nodes (so they are focusable and clip with CSS), no dependency and no build step. The lead sits in the middle and the open seats on an ellipse round it, the node width shrinking from 220 to 164 px until none overlap; when they still do not fit (a narrow screen or many seats) it falls back to the lead on top and the seats in rows below, joined by right-angled edges. Each seat has an edge to the lead; a seat node opens the seat panel under the graph, and `Escape` closes it. A feed entry that is new since the page loaded (and arrives while the graph is shown and the tab is visible) sends a dot along the route from `from` to `to` in about 1.3 s, labelled with its kind and coloured by it (`KIND_TONES`: reports green, questions and blocked amber, verdicts violet, briefs blue). At most six fly per update. `⌘`, `lead` and `planner` mean the lead node; a seat's own name is its node; `Human` and any other name cannot be placed, so nothing moves for it (the seat's badge shows it). Under `prefers-reduced-motion` the dot is replaced by a brief highlight of the edge.
- **Timeline.** One line per entry: time (HH:MM, the browser's own offset), icon, from → to, kind, then the summary clipped with an ellipsis. A line is a button: click, Enter or Space toggles its full text (`full`, or the summary) below, with `aria-expanded`. Newest first. The chips filter by the structured `kind` with `NEEDS_YOU_KINDS` and `REPORT_KINDS` (`progress` is a hidden entry, so it never reaches the page; `REPORT_KINDS` still lists it).
- **Life.** No daemon: it runs in the foreground until Ctrl-C or SIGTERM, then ends the open streams and closes the port.

**Order:** P1 and P2 start at once. P3, P4 and P5 also start at once against the stubs, and rebase onto P1 when it merges (P1 is small and should land first).

## 13. Open questions (each with a recommendation)

Recommendations accepted by the planner on 2026-10-09; the human-run [verify] items are gathered per piece in §12. Questions answered since are marked **Answered**.

1. **Where do worktrees live?** `<repo>/.claude/worktrees/<seat>`. **Answered by the first real launch:** Claude's folder trust does *not* carry over to a folder made by `git worktree add` there (trust is per folder in `~/.claude.json`), so the seat stalled at "Do you trust the files in this folder?". Claude workers therefore use `claude --worktree <seat>` (Claude makes the folder and does not ask; branch `worktree-<seat>`), and only Codex workers keep a Drove-made worktree (`drove/<seat>`; their trust comes from the per-launch `projects."<path>".trust_level` override). The cost is an untracked `.claude/` in repos that do not ignore it. `~/.drove/worktrees/<repo>/<seat>` keeps repos clean, but risks a Claude folder-trust dialog per worktree. **Recommend `.claude/worktrees/<seat>` for v1** (proven), and test the outside-repo path once. Since then: Claude creates that worktree from `origin/main`, not from the local `main` (§5, Base branch), and two runs of one repo share the folder, so a spawn that would reuse an open seat's worktree or branch of another run is refused (§2).
2. **Claude planner wake without the mod.** A dev channel (research preview, one confirmation per launch, claude.ai auth only) or keystrokes into the human's pane. **Recommend: try the channel first, fall back to keystroke wake after 5 s idle, and always piggyback.** **Answered live (DROVE-49):** an idle session does take a turn, so the channel stays first. The mod is still the comfortable Claude planner.
3. **Codex hook trust.** Constant command strings plus one approval by the human, or `--dangerously-bypass-hook-trust` per launch (which also runs any untrusted repo-local hooks). Recommended: constant strings and a one-time approval, bypass as an explicit opt-in in `~/.drove/config.json`, and never prewrite trust hashes into the user's config. **Answered (DROVE-34), in part:** a worker under a Drove-owned `CODEX_HOME` needs no approval, because Drove prewrites the trust hashes into that home's own `config.toml`; the user's `config.toml` is still never touched. The one-time approval remains for the Codex planner and for legacy seats [verify that inline `-c` hooks get stable trust keys].
4. **Codex worker network.** `network_access=true` lets workers run `cairn` and package installs, but also makes `git push` possible, so only the guard prevents it. Recommended: network on, with the guard denying push (workers need Cairn). **Answered (DROVE-14):** a Codex worker runs with approvals and the sandbox bypassed by default (§5), so the network is open, the guard hook is the only thing that denies `git push`, and `codexWorkerSandbox: "workspace-write"` restores the sandboxed spec with network on. [proven: a Codex worker's `git push` was denied by the guard and `cairn` worked, DROVE-34 live check.]
5. **How the mod imports Drove.** **Answered (DROVE-9): it does not.** The plugin runtime has no Node and imports only the plugin's own files, so neither an absolute path nor `npm link` can work. The mod runs the Drove CLI (`drove mod attach|bridge|report` plus the planner commands and `drove guard`) and keeps a drift-tested copy of the run-state types (§10).
6. **Promote for a Codex worker** needs a restart today. **Answered: restart with resume** (§8) [proven live]. Still open: whether `codex queue -m` changes the model per turn: if it does, it replaces the restart.
7. **Does `herdr agent start` return ready when the agent begins with an initial prompt** (so it is `working` at once)? **Answered: no.** `agent start --timeout` waits until herdr considers the agent ready (idle). In an early live run a Codex planner spawned a Claude worker with the brief as the launch argument ("First run: sleep 40. …"); Claude was working from the first second, `agent start` timed out at 60 s, and spawn rolled back and closed a healthy working worker (`seats/w-cl2/start-failure.txt` shows its screen mid-turn). The earlier Claude test only passed because the task took under 15 s. **Decision:** launch with no prompt argument and send the brief with `herdr agent prompt --wait` as the first control (default, both kinds; `briefVia` and `DROVE_BRIEF_VIA` restore the launch argument), treat a prompt `timeout` as delivered-unconfirmed, and, if `agent start` times out anyway, keep the seat when the agent is up in the pane (§5). Only Codex then lacks a thread until its first turn ends; later messages wait for the thread id or go by `herdr agent prompt`.
8. **A long-poll `wait` tool for the planner** (block up to N seconds for the next report) would give both planners a wake with no keystrokes. It occupies the planner's turn, and Codex MCP tool timeouts are short by default. **Recommend not in v1**; reconsider if both the channel and keystroke wake disappoint.
9. **The event log grows without bound.** **Recommend rotating at 10 MB** (`events.1.jsonl`), and keeping runs for 14 days after `down`, as the mod's store pruning does.
10. **Human name in renders** (`for: human` was shown with a hard-coded first name). **Answered: a `~/.drove/config.json` `humanName`**, default "the human".
11. **Codex launch line over 1024 bytes.** **Answered (DROVE-23, DROVE-34):** the readiness gate plus one retry make a long line safe (§5), and a Drove-owned `CODEX_HOME` makes the worker line about 150 to 200 bytes, so a Codex worker no longer depends on the gate.
12. **Several runs at once.** **Answered (DROVE-43):** herdr agent names are global per server, so Drove namespaces them `<seat>-<run tag>` and addresses a seat by pane id once it has one (§2). In one repo, the same seat name in two runs is refused. Not yet run live with two runs side by side.
13. **Run live, all passed (DROVE-49, 2026-10-10):** a Codex planner with Codex workers; asking the human for a 6th pane in both clients (the mod's dialog and MCP elicitation); two runs with the same seat name (DROVE-43); a Claude planner without the mod woken by the channel; signed messages checked in Claude and Codex workers (DROVE-47). Nothing is left in the "not run live" list.

## 14. Unattended runs (DROVE-95, DROVE-96)

A job that is not in herdr (Bothy: cron, a signed webhook, chat, a poll) has to start a run, watch it, hear what needs a person, and resume it. This is Drove's side of that; the job is Bothy's. **It has run live** (2026-10-12, DROVE-110: a Bothy job started a detached run against a real herdr server) and the tests pin it against a fake herdr.

**Detached start.** `drove plan --detached` and `drove up --detached` replace "this pane" with a workspace of Drove's own. The steps, through the same herdr adapter the worker panes use (`src/herdr.ts`):

1. `herdr workspace list` as a probe. It changes nothing and fails when no server is reachable; Drove then refuses with `herdr-down` before it writes anything. It never starts the server.
2. The run is made or loaded as usual, and the planner's launch spec is built (its env is the run's identity; the launch files are written as for any seat).
3. `herdr workspace create --cwd <repo> --label "drove · <repo> · <run tag>" --no-focus --env …` opens the workspace; its `root_pane` is the planner pane. The reply names workspace, tab and pane (`parseNewWorkspace`).
4. The run records the pane as `planner.paneId`, so the wake (`herdr agent prompt` to the planner pane), `workspaceOf` (the workers' tab opens in the same workspace) and the board find it as they do for an in-pane planner.
5. After the shell prompt settles (§5), `herdr agent start planner-<tag> --kind <kind> --pane <root pane> -- <planner argv>`, retried while the pane is busy. `agent_not_ready` is not a failure: the planner is at a startup dialog (folder trust, the dev channel, Codex hook trust), which is reported as `planner.state: "blocked"` with the dialog's reason and left for a person. A goal that has a newline cannot ride in the typed launch line, so it is typed with `herdr agent prompt` once the planner is up.
6. The command prints the run id, the planner pane and the workspace and returns. With `--json` the shape is `DetachedStart` (`src/types.ts`).

`up --detached` opens the workspace before the seats are relaunched (they place their tab in the planner's workspace), then relaunches them and starts the planner with its resume argument. A planner that fails to start leaves the run as `up --detached` made it and says where the pane is; a new run whose start failed is put back `down`, with its workspace closed, so the same command can try it again.

What it needs on the host: a running herdr server on the default socket or `HERDR_SOCKET_PATH`; `herdr`, `git`, `node` and the planner's agent CLI on `PATH`; `cairn` for `--from-cairn` and `--next`; one `DROVE_HOME`. The workspace is opened with `--no-focus`.

**The attention list.** The board, the planner's wake ("Needs the human") and the web page each look at part of the run's state; `src/attention.ts` is that state as one list. `attentionCandidates` is pure over what the run holds:

| Source | Where it is read | Item kind |
|---|---|---|
| each seat's `attention` list in the roster (`detect.ts` derives it) | `roster.json` | the `Attention` reasons: `dialog`, `permission`, `trust`, `hook-trust`, `channel-confirm`, `codex-version-mismatch`, `usage-limit`, `stalled`, `idle-without-report`, `gone`, `budget`, `pending-delivery`, `guard-thrash` (the planner's, never the human's: §6) |
| a worker's question in its pane (`asking`) | `seats/<seat>/mod.json`, the same `isAsking` the board uses | `asking`, which replaces the generic `permission` line for that seat |
| each owing seat's latest report that is `for: human` | `outbox.jsonl` (token-checked, as `drove reports`); open while the seat's `owes` is not `none` | `question`, `blocked`, `promote` |
| a spawn refused by the pane budget | an `attention` event with `reason: pane-budget`, written by `spawn` | `pane-budget`, open until the budget is raised, a slot frees or the seat starts |
| the planner's own pane | `herdr agent get` on `planner.paneId` (plus a screen read when blocked) | `dialog` or `gone` with `seat: "planner"`; "gone" waits 30 s after a `run.up` |

**Ids.** The derived attention lines are rewritten on every poll (their `at` is the poll time) and a poller is a new process each time, so an item cannot take its id from either. `runs/<id>/attention.json` is a ledger written under a lock: the first sighting of a key (`<seat>:<kind>[:<report id>]`) records its start (the seat's `stateAt` for a dialog, the report's `at`, the event's `at`) and an episode number; a key seen open keeps both; a key that went away is closed, and its next sighting is the next episode. The id is `<run>:<key>:<n>`. The ledger is the only thing the command writes besides what `roster` already refreshes.

**Freshness.** The roster is refreshed from herdr (`refreshRoster`, what `drove roster` does) when it was last written more than 10 s ago, so a run whose planner and watcher are dead still reports truthfully. While a watcher runs it keeps the roster fresh and nothing is rewritten.

**`--follow`.** A loop over the same snapshot every 3 s that diffs ids, prints `new` for ids it has not announced and `resolved` for ids that left (with the item as last seen), and ends on abort. It holds no state a restart needs: ids are stable across processes, so the first poll of a new follower re-announces what is open and the consumer dedupes.

**Decisions.**

- *Answering is not Drove's.* An item says how a person answers (an exact command, or the pane); nothing in the stream answers anything. A dialog is never answered by a script (§6).
- *`drove send` takes `--run`* so an answer can be sent from a job that is in no run's directory. It applies only when the caller has no run identity of its own (a human), so an agent cannot reach another run with it.
- *Run status is `drove roster --json`.* It already held `run.status` and each seat's state and last report; it now also says whether the planner pane is alive (`planner.state`), gives the latest report across seats, and the roster's write time. There is no separate `status` command.
- *Errors are data with `--json`.* `{"ok":false,"code","error"}` on stderr, exit 1; usage errors exit 2.

**Open.** The live proof (DROVE-110) shows a workspace opened with no client attached accepts `agent start` and runs the planner. Still to confirm: whether the Claude planner's wake (the channel, or `herdr agent prompt`) lands in a workspace nobody looks at; whether `workspace list` is the right liveness probe on every herdr version Drove supports (`herdr status server --json` also exists, but its shape is not pinned here); and which dialogs a first unattended launch really meets.

## 15. Doctor and remote machines (DROVE-97)

`drove doctor` (`src/doctor.ts`) answers "can this machine run Drove?" without touching anything: one function per check over an injected `exec`, each returning `ok`, `warn` or `fail` with a one-line fix, and the command exits 1 when any check fails. What a missing piece costs decides the status. Node below 22.18, no git, no herdr or no reachable herdr server (probed with the same `herdr workspace list` the detached start uses, never a start), neither agent CLI or a `claude` older than `CLAUDE_MIN` (the version the launch flags were verified on, defined in `doctor.ts` next to the check), an unreadable Cairn and an unwritable `DROVE_HOME` fail; `gh` missing or signed out, one agent CLI missing and a repo with no remote only warn, because they take away one feature (`merge --pr`, one agent kind) and not the run. The mod's `nodePath` is read from Claude Code's user settings only when the mod is enabled there. The command is on the planner's and the worker's allowlists: it reads and prints. The README section "Running Drove on another machine" is the practical side: install, Cairn sign-in, a herdr server kept by a person, unattended starts through section 14, and the client-project checklist (code stays on the client's machine, a `DROVE_HOME` per client, no secrets in `workerEnv`). Nothing here adds a service: a remote Drove is the same Drove with its own state directory.
