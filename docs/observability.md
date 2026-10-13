# Observability

Drove shows a run while it happens and accounts for it afterwards. The board, in a terminal pane, inside Claude Code or in a browser, lists each seat and a timeline of the briefs, reports and verdicts. `drove report` counts tokens, cost, time and rework; `drove diagnose` says why a run needed rework; `drove trace` exports it as OpenTelemetry.

All of them read the run's plain files, so they work on a running or a stopped run. Back to the [README](../README.md).

## The board

The same board, in four places. It lists each seat with its kind, model and effort, Cairn ref, state, last check result and what needs a human, then a timeline of the briefs, reports and verdicts between the planner and its workers. The header carries the run's goal and progress.

| Where | How | Notes |
|---|---|---|
| a spare pane | `drove board` | live and coloured, on your terminal's own background; one frame with `--once` or when piped; no colour when piped or with `NO_COLOR`; this repo's latest run unless `--run` or `DROVE_RUN` |
| the planner, with the mod | `/orchestrate <goal>` | the same board inside Claude, with pills, toasts and the dialogs that need your answer |
| a `drove plan` Claude session, with the mod | `/orchestrate board` | the board of the session's own run (`DROVE_RUN`), read-only, polled every two seconds; run it again to hide it |
| a browser | `drove board --web` | read-only, with a graph view; see below |

In a `drove plan` session, `/orchestrate board` starts no wake bridge, registers no tools, and never switches the model or effort or opens a dialog: the planner keeps waking through `drove plan`'s own path. `board bg`, `status` and `help` answer there too; `/orchestrate <goal>` and `off` refuse, because the session is already a planner.

**Seat columns.** A state glyph (`⚙` working, `✓` done, `·` idle, `?` asking, `⛔` blocked, `×` gone), the seat name, `R` or `T` for a reviewer or tester, the last check result at the seat's HEAD (`chk✓` passed, `chk✗` failed, `chk~` stale), model and effort, Cairn ref, what it is doing, and the time since its last report.

**The planner's pane light.** While the planner's turn has ended but a worker is still working and nobody waits on the human, Drove sets a spinner title on the planner pane, so herdr shows it as working rather than done. It restores the title when the wait ends or the run goes down.

### The web board

`drove board --web` serves the board on `127.0.0.1`, on a free port or the one you give with `--port N`. It prints a URL ending in a token made at each start; open that URL.

- **Graph.** The lead in the middle (on top on a narrow screen) and each open seat a node around it, with its name, kind, model and effort, Cairn ref, current activity and a state colour. A working seat pulses; one that asks, is blocked or has an attention item carries a "needs you" badge.
- **Traffic.** When a new brief, report or verdict reaches the timeline, a dot labelled with its kind travels along the edge between the lead and the seat. Nothing moves for entries already there at load, or under `prefers-reduced-motion`, where the edge only lights up.
- **Board.** A Graph | Board switch next to the title goes to the terminal board's rows; the page remembers the choice.
- **Seat detail.** Click a seat (node or row) for its kind, model, effort, state and age, branch, worktree, Cairn ref, session id and check result, its thread of briefs and reports, and the last 40 lines of its pane as plain text, refreshed every few seconds while open. `drove capture <seat>` and the worktree path are shown to copy.
- **Timeline.** One line per entry (time, icon, from → to, kind, clipped summary, newest first). Click it, or press Enter or Space, to open its full text. Chips show only what needs you, only reports, or everything.

The page follows your system's light or dark theme. It answers only GET and HEAD, and refuses a request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, whose `Origin` is another site, or that has no token. Ctrl-C stops it; the page is there only while the command runs.

## Reading reports

`drove reports [<seat>] [--all] [--json] [--run ID]` prints the workers' reports in full: those not yet read, or a seat's latest when it has none unread, or every report with `--all`. The mod's planner has the same as its `read_reports` tool. A wake shows one line per report; the full text is read here.

`drove roster` gives one line per seat, and `drove capture <seat>` a seat's recent output.

## Run report

`drove report [<run>] [--json]` is the number a factory improves against, for the latest run of this repo or the run you name, running or down. It only reads. The planner has it as `run_report`. Per seat, and for the run:

| Column | What it counts |
|---|---|
| tokens and cost | input, cache reads, cache writes and output, summed once per message from the seat's own transcript, and priced per message on the model that wrote it |
| wall time | spawn to close, summed over a seat's incarnations (to now for an open seat) |
| human | how long attention items waiting on the human (dialog, permission, trust, usage limit) stayed open |
| `chg/pro/dem/mig/rst` | verdicts asking for changes, promotions, demotions, migrations and restarts, from `events.jsonl` |
| `chk run/fail` | runs of the repo's checks (`drove checks`, `run_checks`, a merge that ran them) and how many failed; a reused record is not a run |
| `deny` | tool calls the guard refused the seat; the line under the table breaks the total down by rule |
| `nudge` | steering nudges |

The report also splits seats and tokens by kind. The planner has a row too, limited to the run's lifetime.

**Transcripts.** Claude: `~/.claude/projects/<worktree path with / and . as ->/<session>.jsonl`, found from the seat's session ids and its hook records. Codex: the rollout under the run's `codex-home/sessions`. A seat whose transcript cannot be found is listed under the table.

`drove down` writes the same totals, and one line per seat, into its summary note on the run's Cairn task. The report ends with a pointer to `drove diagnose` when the run has findings.

### Prices

Cost comes from the table in `src/report.ts`, in USD per million tokens. Cache writes cost 1.25× the input price (5-minute) or 2× (1-hour).

| Model | Input | Output | Cache read |
|---|---|---|---|
| Fable 5.1 | 10 | 50 | 0.25 |
| Fable 5 | 10 | 50 | 0.25 |
| Opus 5.5 | 4 | 20 | 0.20 |
| Opus 5 | 5 | 25 | 0.25 |
| Sonnet 5.5 | 2 | 10 | 0.20 |
| Sonnet 5 | 2 | 10 | 0.20 |
| Haiku 5.5 | 0.10 | 0.50 | 0.01 |

A model with no price, which includes every Codex model, shows tokens only, and the cost is marked partial with a `+`. A date suffix or a context marker on the model id (`[1m]`) is ignored for pricing.

## Diagnose

`drove diagnose [<run>] [--json]` says why a run needed rework and where the fix belongs, from the same records plus the check ledger, the briefs and the reports. It only reads.

One line per finding: `category · seat · confidence · evidence · suggested fix (where: brief | role text | config | repo | planning | Drove)`, ending with a summary line that also goes to stderr. A run with nothing to report prints `no findings`.

| Detector | Looks for |
|---|---|
| `scope-too-narrow` | owns denials, then a widening |
| `checks-failed-at-done` | a done report whose checks failed |
| `review-loop` | repeated `changes` verdicts |
| `no-acceptance` | a seat with no acceptance criteria that got a `changes` verdict |
| `merge-conflict` | a conflict, naming the seats that touched the same files |
| `ci-only-failure` | checks that passed locally and failed in CI |
| `brief-not-delivered` | a brief that never reached the worker |
| `budget-hit` | a seat limit or the run budget reached |
| `usage-limit` | a plan limit |
| `guard-thrash` | repeated guard denials |
| `steering` | steering nudges |

Each detector is deterministic; DESIGN.md §6 lists its evidence.

## Trace

`drove trace [<run>]` prints an indented run → seat → attempt tree, with check spans under the active attempt (otherwise the seat), merge outcomes under the seat, and guard denials, steering nudges and attention as span events.

- `--json` prints OTLP/JSON.
- `--otlp http://localhost:4318` posts it to `/v1/traces`, using `OTEL_EXPORTER_OTLP_HEADERS` when set.
- `otlpEndpoint` in `~/.drove/config.json` exports automatically after `drove down`. An export failure does not fail the shutdown, and HTTP requests time out after two seconds.

Trace and span ids stay the same on re-export. Usage and known costs come from the same transcripts as `drove report`. Merge spans have zero duration, because the event log records only merge outcomes.
