# Drove v1: design

Cairn DROVE-2 (parent DROVE-1). Date: 2026-10-09. Inputs: `spikes/codex-proof/RESULT.md` (CCS-48), `spikes/openrig/RESULT.md` (CCS-49), CCS-47 findings, CCS-50, and the Claude orchestrator mod (`~/.claude/mods/orchestrator`, read only).

Drove is a small cross-agent orchestrator on herdr. One **planner** plans, delegates, reviews diffs and merges. **Workers** write the code. Either side can be Claude Code or Codex. Every agent runs in its own herdr pane, and each worker has its own git worktree.

Markers used below: **[proven]** was seen working in a spike or in the mod. **[docs]** is stated in official docs but not yet run by us. **[verify]** is a guess that a human-run launch must confirm before we rely on it.

## 0. Decisions taken (not reopened)

- No daemon. The planner's own Drove MCP server (stdio, lives as long as the planner session) is the event loop. It watches the worker outboxes and wakes the planner. As a fallback, pending reports also ride on every planner tool result.
- herdr is the only pane layer. One herdr tab per run for the workers, laid out as a grid, with a budget of 5 worker panes. A 6th needs the human's OK.
- Permissions are set per launch only. Drove never edits `~/.codex/config.toml`, `~/.claude/settings.json`, `~/.tmux.conf` or skills, and never writes `AGENTS.md` or `CLAUDE.md` into a repo.
- Work items are Cairn tasks, one ref per worker. Drove has no queue of its own.
- Claude Code and Codex are both supported as planner and as worker in v1.
- The planner never edits code and never runs builds; a guard enforces this. Workers never push.
- Branches are created with `--no-track` from `origin/main` when a remote exists, from `main` otherwise. Nobody pushes to a `production` branch.
- Workers launched as `claude` get `_CC_ACCT_PINNED=1`.
- TypeScript run directly by Node 22.18+ (type stripping), ESM, zero runtime dependencies, tests on `node:test`.

## 1. CLI surface

One binary, `drove` (`src/cli.ts`). Each subcommand is a thin wrapper over a function in `src/commands.ts`. The planner's MCP tools call the same functions, so the CLI and MCP paths cannot drift apart.

| Command | Who runs it | Why it exists |
|---|---|---|
| `drove plan [--kind claude\|codex] [--model M] [--effort E] [--goal TEXT] [--run ID]` | human, in a herdr pane | Creates a run (or attaches to `--run`), records this pane as the planner pane, then `exec`s `claude` or `codex` with the planner MCP server, the planner guard and the planner role attached. This is the only way a planner starts outside the mod. |
| `drove spawn <seat> --kind claude\|codex --cairn REF --brief TEXT\|-  [--model M] [--effort E] [--base BRANCH]` | planner | Creates the worktree and branch, opens a pane in the run's worker tab (grid), launches the agent with its launch spec, and delivers the first brief. Enforces the 5-pane budget. |
| `drove send <seat> --kind message\|answer\|verdict [--verdict approve\|changes] [--expects E] TEXT` | planner | Sends one enveloped control message through the best transport for that seat (see §4), with a guarded send and a retry queue. Verdicts and answers are kinds of `send`. |
| `drove prompt <seat> TEXT` | planner, human | Raw `herdr agent prompt` into a seat the run owns, with no envelope. This is the escape hatch for a re-brief after a restart, or when `codex queue` is unavailable. It still refuses a `blocked` pane. |
| `drove promote <seat> --model M --effort E [--reason TEXT]` | planner | Changes a worker's model or effort (§8). It is a separate command because it can restart the agent; demote is the same command with a lower setting. |
| `drove roster [--json] [--run ID]` | anyone | One line per seat: state, kind, model, effort, Cairn ref, age, last report, and what the planner owes it. |
| `drove capture <seat> [--lines N]` | planner, human | Read-only `herdr agent read` of a seat's recent output. |
| `drove close <seat> [--remove-worktree]` | planner | Quits the agent, closes the pane (and the tab when it is empty), and marks the seat closed. It removes the worktree only when asked and only when the branch is merged into the base. |
| `drove board [--once]` | human | A live plain-text board for a herdr pane: seats, states, attention list and recent events. `--once` prints a single frame. |
| `drove down [--run ID]` | human, planner | Saves every session id, quits the agents, closes the panes and marks the run `down`. |
| `drove up [--run ID]` | human | Reopens the worker tab and resumes each worker by session id, then `exec`s the planner with its resume argument in the current pane. |
| `drove budget <n>` | human only | Raises the pane budget for the current run. The guard denies it to every agent, so it is the human's OK for a 6th pane when the client cannot show a dialog (§3). |
| `drove guard <event>` | hooks only | The hook entry point for Claude and Codex. For `pre-tool-use` it prints the guard's decision. For `session-start`, `stop`, `notification`, `permission-request` and `user-prompt-submit` it records state in the seat's `hooks.jsonl`. Identity comes from the env, so the command string is identical across launches (this matters for Codex hook trust, §6). |
| `drove mcp` | agents only | The stdio MCP server. Its role comes from `DROVE_ROLE`: the planner gets the planner tools plus the outbox watcher, and a worker gets `report`. |

Not in v1: a queue command (Cairn is the queue), workflows, snapshots beyond session ids, `send-keys`.

## 2. State layout and identity

```
$DROVE_HOME (default ~/.drove), mode 700
  runs/<run-id>/
    run.json            # RunMeta. Written by plan/up/down/budget (atomic)
    roster.json         # Roster. Atomic: write tmp + fsync + rename, under roster.lock
    roster.lock/        # mkdir lock (stale after 10 s, then stolen)
    events.jsonl        # append-only DroveEvent log, one write() per line, lines capped at 8 KiB
    planner/
      pending.jsonl     # reports a wake transport could not deliver yet (piggyback source)
      cursors.json      # byte offset per outbox already consumed (exactly-once reading)
      settings.json     # Claude planner --settings (guard + state hooks)
      mcp.json          # Claude planner --mcp-config
    seats/<seat>/
      token             # 32 random bytes, hex, mode 600
      outbox.jsonl      # Reports. Single writer: the worker's MCP server
      hooks.jsonl       # HookRecord lines. Writer: drove guard <event>
      pending.jsonl     # Controls waiting for a deliverable pane (guarded send)
      sent.jsonl        # ids of delivered controls (idempotence)
      settings.json     # Claude worker --settings
      mcp.json          # Claude worker --mcp-config
      launch.json       # the LaunchSpec used (token redacted), for relaunch and debugging
  worktrees: <repo>/.claude/worktrees/<seat>   (see Open question 1)
```

- **Run id**: `<repo-basename>-<yyyymmdd>-<hhmm>-<4 hex>`, e.g. `drove-20261009-1042-a3f1`.
- **Seat names**: `[a-z][a-z0-9_-]{0,31}`, which is herdr's agent-name rule. The seat name is also the herdr agent name, the branch suffix (`drove/<seat>`) and the worktree directory. The planner's seat name is `planner`.
- **Writers**: `roster.json` and `run.json` are written only by planner-side code (the planner MCP server and `drove` commands run by the planner or the human), always under the lock. Workers never write the roster; they only append to their own `outbox.jsonl`. Hooks append only to `hooks.jsonl`.
- **Identity env** (set on the pane with `herdr pane split --env` and inherited by the agent, its hooks and its MCP servers):

| Var | Value |
|---|---|
| `DROVE_HOME` | state root |
| `DROVE_RUN` | run id |
| `DROVE_ROLE` | `planner` or `worker` |
| `DROVE_SEAT` | seat name (`planner` for the planner) |
| `DROVE_TOKEN` | the seat token (workers only) |
| `_CC_ACCT_PINNED` | `1` for Claude workers |

The token is not a security boundary against the worker itself: its shell can read its own env. It does three jobs. It rejects a stale worker's reports after a respawn under the same name (a new token is minted each time). It rejects text that only looks like a Drove envelope, such as a pasted report. And it keys the message MAC (§3). The real boundary is file permissions: `$DROVE_HOME` is 700 and token files are 600.

## 3. Protocol

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
- `mac`: the first 16 hex characters of `HMAC-SHA256(seat token, id + "\n" + body)`. A worker-side checker (the mod's `session.receive`, or a Claude `UserPromptSubmit` hook) can mark a header with a bad MAC as unverified, like the mod's `UNVERIFIED` today. Codex workers do not verify in v1. They trust their own pane, which only Drove and the human type into.
- The reply line is generated from `kind` and `expects`, so the receiver always knows how to answer: openrig's best idea, and it is free.
- Verdict `approve` carries the mod's `APPROVED` text: commit only your own paths, do not push, then confirm with `done` and `expects: none`. Verdict `changes` requires notes and expects `review`.
- `promote` and `demote` carry `model=` and `effort=`. `answer` and `message` differ only in how the board labels them.

### Delivery semantics

- Each control has an id. `sent.jsonl` makes delivery idempotent, and a retry happens only after an explicit failure. This fixes the mod's double send (CCS-50).
- Each report has an id. The planner server reads each outbox from its cursor, so every report is processed exactly once. A `report.delivered` event marks a successful wake. A report whose wake failed goes to `planner/pending.jsonl`, and the next planner tool result carries it (piggyback).
- Over budget: `spawn` asks the human through MCP elicitation when the client declared that capability [verify for both clients]. Otherwise it refuses with: "ask the human to run `drove budget 6`".

## 4. Delivery matrix

### Planner to worker

| Planner \\ Worker | Claude worker | Codex worker |
|---|---|---|
| **First brief** (both planners) | Initial prompt as a launch argument: `claude … "<brief>"` [docs; verify that `herdr agent start` still reports ready]. Fallback: `herdr agent prompt <seat> --wait` [proven in the mod]. | Initial prompt as a launch argument: `codex … "<brief>"` [verify]. The thread then exists from the first second, which closes the CCS-48 gap. Fallback: `herdr agent prompt --wait` [proven]. |
| **Later messages, Claude planner with the mod** | The mod's `$.session.send` to the worker's session id [proven] | `codex queue --thread <thread> --message <text>` [proven] |
| **Later messages, Claude planner without the mod** | `herdr agent prompt <seat>` [proven] | `codex queue` [proven] |
| **Later messages, Codex planner** | `herdr agent prompt <seat>` [proven transport] | `codex queue` [proven] |

The Codex thread id is the seat's `sessionId`. It comes from the Drove `session-start` hook record, or else from `herdr agent get <seat>` → `.result.agent.agent_session.value` [proven, but null until the first turn ends when there is no initial prompt].

**Guarded send.** Before any keystroke-based delivery (`herdr agent prompt`), check `herdr agent get <seat>`. If the state is `blocked`, or the seat's hooks report needs-input, do not type: append the control to `seats/<seat>/pending.jsonl`, raise an attention item, and retry on every watcher tick (3 s) until the pane is not blocked. herdr itself also rejects with `agent_blocked` [proven], and that error takes the same queue path. `codex queue` does not type into the pane, so it is allowed while the pane is busy (mid-turn messages queue [proven]). It is still deferred while the pane is `blocked`, because the queued turn would sit behind a dialog that nobody sees. `agent_pane_busy` from a fresh pane is retried for up to 45 s, as in the mod's `retryWhileBusy`. `agent_prompt_stalled` is not resent blindly: the mod's rule applies (check the state first).

### Worker to planner

All reports go through the outbox. Only the wake differs:

| Planner | Wake transport, in order |
|---|---|
| Codex | `codex queue --thread <planner thread> --message <rendered report>` [proven transport]. The planner thread is known because `drove plan` launches Codex with an initial prompt, and the session id comes from the planner's `session-start` hook or herdr. While the planner is mid-turn, the message queues as its next turn [proven]. |
| Claude with the mod | The mod's watcher hands the report to the session (`session.receive` path) [proven pattern] |
| Claude without the mod | (1) A channel: `notifications/claude/channel` from the planner's own MCP server, when `drove plan` launched it with `--dangerously-load-development-channels server:drove` [docs: research preview; one confirmation prompt at launch; verify that an idle session takes a turn]. (2) Else `herdr agent prompt <planner pane>` when the planner pane is `idle` or `done`, and never while it is `blocked` [proven transport]. |
| Any | Piggyback: every planner tool result ends with any reports still pending. |

`progress` reports never wake the planner. Several reports that arrive within 2 s go out as one wake message.

Risk with keystroke wake (2): it types into the human's own pane, and could land in a half-written prompt. Mitigation: wake only when the planner pane has been `idle` or `done` for 5 s or more. The channel is better, which is why it comes first.

## 5. Launch specs

All launches follow the same steps. Create or reuse the run tab: `herdr tab create … --env …` for the first worker, then `herdr pane split` into the grid slot (the mod's `gridSlot`). Then run `herdr agent start <seat> --kind <kind> --pane <pane> --timeout 60000 -- <argv>`. Files are written under `seats/<seat>/` first.

### Claude worker

```
env:  _CC_ACCT_PINNED=1 DROVE_HOME=… DROVE_RUN=… DROVE_ROLE=worker DROVE_SEAT=<seat> DROVE_TOKEN=…
cwd:  <worktree>
argv: --dangerously-skip-permissions                      [proven]
      --model <model> --effort <effort>                   [proven]
      -n <seat>                                           [proven]
      --session-id <uuid minted by drove>                 [docs] (so resume needs no discovery)
      --mcp-config <run>/seats/<seat>/mcp.json            [docs]
      --settings <run>/seats/<seat>/settings.json         [docs: launch-only, merged, writes no file]
      --append-system-prompt "<worker role text>"         [docs]
      "<brief + footer>"                                  [docs; verify with herdr agent start]
```

`mcp.json`: `{"mcpServers":{"drove":{"command":"node","args":["<drove>/src/cli.ts","mcp"]}}}`. The env is inherited [docs]. `settings.json` holds `hooks.PreToolUse` with matcher `Bash|Edit|Write|MultiEdit|NotebookEdit` running `drove guard pre-tool-use`, plus `SessionStart`, `Stop` and `Notification` hooks running `drove guard <event>`. No `--strict-mcp-config`: the user's own MCP servers stay available.

### Codex worker

```
env:  DROVE_HOME DROVE_RUN DROVE_ROLE=worker DROVE_SEAT DROVE_TOKEN
argv: -s workspace-write                                               [proven]
      -C <worktree>                                                    [proven]
      --add-dir <repo>/.git            (commits from a worktree write the common git dir)  [verify]
      -m <model> -c model_reasoning_effort="<effort>"                  [verify the key name]
      -c check_for_update_on_startup=false                             [proven]
      -c sandbox_workspace_write.network_access=true  (cairn, package installs)           [verify]
      -c 'projects."<worktree>".trust_level="trusted"'                 [proven]
      -c mcp_servers.drove.command="node"                              [proven pattern]
      -c 'mcp_servers.drove.args=["<drove>/src/cli.ts","mcp"]'
      -c 'mcp_servers.drove.env={DROVE_HOME="…",DROVE_RUN="…",DROVE_ROLE="worker",DROVE_SEAT="…",DROVE_TOKEN="…"}'  [proven pattern]
      -c mcp_servers.drove.default_tools_approval_mode="approve"       [proven]
      -c 'developer_instructions="<worker role text>"'                 [verify; fallback: role text at the top of the brief]
      -c 'hooks.PreToolUse=[{matcher="Bash|shell|exec_command|apply_patch", hooks=[{type="command", command="drove guard pre-tool-use", timeout=10}]}]'   [verify]
      -c 'hooks.SessionStart=[…drove guard session-start…]' -c 'hooks.Stop=[…]' -c 'hooks.PermissionRequest=[…]'   [verify]
      "<brief + footer>"                                               [verify]
```

The MCP env is passed explicitly because the spike did that; whether Codex MCP servers inherit the TUI's env is unverified.

### Planners

- **Claude planner** (`drove plan --kind claude`): `exec claude --model <opus> --effort <high> --session-id <uuid> --mcp-config planner/mcp.json --settings planner/settings.json --append-system-prompt "<planner role>" [--dangerously-load-development-channels server:drove] ["<goal>"]`. No bypass of permissions: the human answers prompts in their own pane.
- **Codex planner** (`drove plan --kind codex`): `exec codex -s workspace-write -C <repo> --add-dir <repo>/.git --add-dir $DROVE_HOME/runs/<run> -c sandbox_workspace_write.network_access=true -c mcp_servers.drove…(DROVE_ROLE=planner) -c developer_instructions=… -c hooks.PreToolUse=[…] "<goal or 'Read the roster and wait for the human.'>"`. The initial prompt exists so that the planner has a thread id at once, which the wake needs.

### Hook trust (Codex)

Codex runs a hook only if its trust is persisted in `config.toml` [proven, CCS-47 knowledge `codex-hook-trust-is-keyed-by-position`]. Drove does not write trust hashes, because that would edit the user's global config. Recommended approach: every Drove hook command is a constant string (`drove guard <event>`), with identity coming from the env. So the human approves each Drove hook once, Codex persists the approval itself, and later launches reuse it [verify that inline `-c` hooks get stable trust keys]. Fallback: a per-launch `--dangerously-bypass-hook-trust`, enabled by the human in `~/.drove/config.json` (`codexBypassHookTrust: true`). See Open question 3.

## 6. Guards

One module, `src/guard.ts`, with the shell parser in `src/shell.ts`, ported from the mod and fixed. It is pure: `decide(GuardInput) → GuardDecision`. It has three callers:

1. Claude PreToolUse, through `drove guard pre-tool-use` (stdin is the hook JSON).
2. Codex PreToolUse, through the same command [verify the input shape; the adapter accepts `tool_name` of `Bash`, `shell`, `exec_command` or `apply_patch`, and a `tool_input.command` given as a string or as an argv array].
3. The mod's `tool.call`, by importing `decide` directly (no subprocess).

Output: exit code 2 with the reason on stderr, which both clients document as "block" [Claude: docs; Codex: verify]. Claude also gets the `hookSpecificOutput.permissionDecision: "deny"` JSON on stdout. On an internal error, the planner fails closed (deny) and a worker fails open, as in the mod.

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
| Bash: file writers, in-place sed/perl, runtimes, `./script`, redirects to files | deny (mod rules) | allow |
| Package tools | read-only subcommands only (mod table) | allow |
| `gh` writes, `curl`/`wget` writes | deny | allow |
| `git` | allow, except a push to `production` | allow, except any `push` |
| `herdr` writes | deny, **except** `herdr agent prompt\|wait <seat>` where `<seat>` is an open seat of this run (CCS-50) | deny |
| `herdr` reads (`list`, `get`, `read`, `explain`, `wait`) | allow | allow |
| `claude`, `codex` | deny, except `--help`, `--version` and `codex queue` to an open seat of this run | deny, except `--help` and `--version` |
| `drove` | allow `spawn`, `send`, `prompt`, `promote`, `roster`, `capture`, `close`, `board --once`, `down`; deny `budget`, `plan`, `up`, `guard`, `mcp` | allow `roster`, `capture`; deny the rest |

The `--help` and `--version` exception fixes a real annoyance: the mod denied `claude --help` to this worker while it wrote this design.

The writable roots (`isInside`) are resolved after `realpath`, so `/tmp/../repo` does not count as `/tmp`.

## 7. State detection

Signals, by freshness:

1. **Hooks** (`seats/<seat>/hooks.jsonl`, written by `drove guard <event>`):
   - Claude: `SessionStart` (session id, ready), `Stop` (turn ended), `Notification` with a `notification_type` such as a permission or idle prompt (needs input) [docs].
   - Codex: `SessionStart` (thread id), `UserPromptSubmit` (working), `Stop` (turn ended), `PermissionRequest` (needs input, with a reason) [openrig proven; our inline form needs verifying].
2. **The outbox**: a report changes the seat's turn state (`done` means it waits for review; `question` and `blocked` mean it waits for an answer).
3. **herdr** `agent list` polled every 5 s by the planner server: `working`, `idle`, `done`, `blocked` or `unknown` [proven, based on the screen or OSC title, can lag by about 7 s]. The seat disappears from the list when its pane is gone.

`detect.ts` exposes a pure `deriveState(prev, signals, now) → { state, attention[] }`. Precedence: needs-input (hook) > `blocked` (herdr) > report-owed (outbox) > `working` (hook newer than 10 s, or herdr) > `idle`/`done`. Missing pane → `gone`.

**Attention list.** These are items for the human, shown on the board and in `roster`, and given to the planner in its next wake or piggyback:
- a dialog or permission prompt;
- a hook-trust prompt;
- a Claude folder-trust prompt;
- a channel confirmation;
- **the Codex "Background server has incompatible feature settings" dialog**;
- a stalled prompt;
- idle without a report;
- a gone pane;
- a budget request.

**Dialog detection.** When `agent start` returns `agent_not_ready`, or a seat turns `blocked`, `detect.ts` reads `herdr agent read <seat> --source detection --lines 40` and matches a regex table:

| Pattern | Attention reason |
|---|---|
| `/Background server has incompatible feature settings/` | `codex-version-mismatch` |
| `/trust (this|the files in this) folder/i` | `trust` |
| `/hook.*trust/i` | `hook-trust` |

`codex-version-mismatch` carries the detail "Codex CLI and app-server daemon versions differ (`codex --version` vs the daemon); align them. Drove will not answer the dialog". Drove never answers a dialog itself.

**Idle without a report.** After a seat goes from working to idle with no report since its last working time and a 20 s grace, Drove sends one `nudge` control ("You stopped without a report: send done, question or blocked"). This is the mod's `idle-without-report`, delivered by Drove for both kinds. It is sent once per working episode.

## 8. Promote and demote

| Kind | Recommended | How |
|---|---|---|
| Claude worker, mod present | **Per-request switch** [proven in the mod] | Drove updates the seat's model and effort in the roster and sends a `promote` control. The mod, running inside the worker, reads its seat from the roster and applies it in `turn.step` from the next request. |
| Claude worker, no mod | **Restart with resume** | Wait until the seat is idle. Send `/exit` with `herdr agent prompt`, then wait for the pane to return to the shell. Then `herdr agent start` with the same spec, plus `--resume <session id> --model M --effort E`, and the promote control as the initial prompt [docs]. The pane and layout are kept. |
| Codex worker | **Restart with resume** | Wait until idle. Send `/quit`, then `codex resume <thread> -m M -c model_reasoning_effort=E … "<promote control>"` in the same pane [`resume -m` docs; verify]. Cheaper candidates to verify later: `codex queue -m M` (the help lists `-m`, but it may be a shared global flag), and app-server `turn/settings/update` (needs a control-socket client; skipped in v1 because of the version coupling seen in the daemon handshake warnings). |

A restart is refused while the seat owes a report or is mid-turn. `promote` returns "queued until idle" in that case, and the watcher completes it.

## 9. Resume

- `drove down`: for each open seat, makes sure the session id is known (Claude: minted at launch; Codex: hook record or herdr), then quits the agent (`/exit` or `/quit`), closes the panes and the tab, writes `run.json` with `status: down`, and appends `run.down`. The planner's session id is saved too. Worktrees and branches stay.
- `drove up`: picks the newest `down` run for this repo (or `--run`), recreates the tab and grid, and relaunches each seat with its launch spec plus `--resume <id>` (Claude) or `resume <id>` (Codex). A seat that owed the planner nothing gets no initial prompt. A seat that was mid-task gets "Resumed by Drove after a restart: carry on, and report when done". Last, `drove up` `exec`s the planner with its resume argument in the current pane.
- A dead seat (pane gone without a `close`) is shown as `gone` with the one-step fix: `drove up --seat <seat>` relaunches only that seat. This is the recovery path openrig lacked.

## 10. The mod as a thin layer

The mod imports Drove from `src/mod.ts`, a stable facade that re-exports a curated API, so the mod never depends on internal module layout:

| From Drove | Used by the mod for |
|---|---|
| `protocol` (envelopes, reports, controls, MAC, rendering) | parsing and rendering in `session.receive` and `prompt.submit` |
| `guard.decide` | its `tool.call` guard, with no subprocess |
| `store` and `roster` (run state, seat ops) | the board and roster tools, and persistence (replaces `$.store` for runs) |
| `commands` (spawn, send, promote, close, capture, down/up) | the bodies of `mcp__orchestrator__*` tools |
| `watch` (outbox reader with cursors) | its tick: reads reports and injects them with `session.send` |
| `detect.deriveState` | board statuses |
| `prompts` | the role sections in `prompt.compose` |

What stays Claude-only in the mod:
- per-request model and effort switching (`turn.step`);
- the in-app board (React) and toasts;
- `$.session.send` as a delivery adapter (registered with `deliver` as the `mod` transport for Claude seats and the Claude planner);
- `$.ui.ask` for the budget dialog;
- AskUserQuestion state, and context % reporting;
- `/orchestrate`, which becomes the equivalent of `drove plan` inside an existing Claude session: it creates a run with this pane and session as the planner, with no `exec`.

The mod is loaded by Claude's runtime, not by Node. How it resolves the import (an absolute path to `src/mod.ts`, or a linked package) is Open question 5.

## 11. Sequences

### (a) Claude planner (no mod) + Codex worker

1. **Spawn.** The planner calls `drove.spawn{seat:w-api, kind:codex, cairn:DROVE-7, brief}`. Drove runs `git worktree add -b drove/w-api --no-track .claude/worktrees/w-api origin/main`, mints a token, opens a grid pane, and runs `herdr agent start w-api --kind codex -- …spec… "<brief>"`. The roster records `w-api`. The `session-start` hook writes the thread id, and the roster picks it up. The tool returns "running; reports will come to you".
2. **Report done.** `w-api` calls `report{kind:done}`, and a line lands in `seats/w-api/outbox.jsonl`. The planner MCP watcher reads it (cursor), verifies the token, updates the roster (`owes: review`) and appends a `report` event.
3. **Wake.** A channel notification goes out if the channel is active. Otherwise `herdr agent prompt <planner pane>` runs once the planner has been idle for 5 s or more. Otherwise the report is pending and rides on the next planner tool result.
4. **Review.** The planner reads `git -C .claude/worktrees/w-api diff main…` (read-only, allowed by the guard).
5. **Verdict.** `drove.send{seat:w-api, kind:verdict, verdict:approve}`. Drove sends `codex queue --thread <id> --message "⟦drove v1 … kind=verdict …⟧ …"`, records the control id in `sent.jsonl`, and sets `owes: none`.
6. **Commit confirmation.** `w-api` commits its own paths, then reports `done` with `expects: none`. The wake text says "confirms approved work; close it".
7. **Merge.** The planner runs `git merge --no-ff drove/w-api` in the main checkout. Git is allowed; the guard checks only the push target.
8. **Close.** `drove.close{seat:w-api, removeWorktree:true}` sends `/quit`, closes the pane (and the tab if empty), runs `git worktree remove` (the branch is merged) and marks the seat `closed`. The planner then closes Cairn DROVE-7.

### (b) Codex planner + Claude worker

1. **Spawn.** The Codex planner calls the MCP tool `spawn{seat:w-ui, kind:claude, …}`. Drove creates the worktree and pane, then runs `herdr agent start w-ui --kind claude -- --session-id <uuid> … "<brief>"`. The session id is known from the start.
2. **Report done.** `w-ui` calls `report` (server `drove`, from `--mcp-config`), and the line lands in its outbox.
3. **Wake.** The planner MCP server reads the line and runs `codex queue --thread <planner thread> --message "[w-ui · done · expects review] … → Review the diff, then call verdict."`. If the planner is mid-turn, it runs as the next turn.
4. **Review.** The planner reads the diff through its shell, which the guard allows as read-only git.
5. **Verdict.** The planner calls `send{seat:w-ui, kind:verdict, verdict:approve}`. This is a guarded send: `herdr agent get w-ui` is not blocked, so `herdr agent prompt w-ui "<envelope>"` runs. If the pane is blocked, the control waits in `pending.jsonl` and an attention item goes out.
6. **Commit confirmation.** `w-ui` reports `done` with `expects: none`, which reaches the planner through `codex queue`.
7. **Merge.** The planner merges in its own shell (workspace-write in the repo, plus `--add-dir .git`).
8. **Close.** The planner calls `close{seat:w-ui}`, which sends `/exit`, closes the pane and marks the seat closed.

## 12. Build plan

Five pieces with disjoint files. `src/types.ts` is frozen by this design: a piece that needs a type change asks the planner, and does not edit it. Every piece codes against the stub signatures already committed, and tests the other pieces through injected `Deps` (`Exec`, clock, `DROVE_HOME` in a temp dir). Nobody in a worktree can start `claude` or `codex` or drive panes, so the items under "human-run" are verified by the human afterwards.

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
  - `/exit`, `/quit` and resume for promote;
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
- **Human-run:** a Claude planner with the dev channel (does an idle session take a turn?); a Codex planner woken by `codex queue`; MCP elicitation support for the budget in both clients.

### P5: board and mod facade
- **Files:** `src/board.ts`, `src/mod.ts`, plus tests. The mod changes themselves are a later piece in `~/.claude/mods/orchestrator`, after P1 to P4 land.
- **Provides:** `renderBoard(run, roster, events, attention, width)` (pure) and `runBoard` (refresh loop); `mod.ts` re-exports the facade listed in §10.
- **Consumes:** P1, plus P3's `detect`.
- **Acceptance:** golden frames at widths 80 and 140; the attention list is shown first; `mod.ts` exports exactly the documented names (a test pins the list).
- **Human-run:** `drove board` in a herdr pane during a real run.

**Order:** P1 and P2 start at once. P3, P4 and P5 also start at once against the stubs, and rebase onto P1 when it merges (P1 is small and should land first).

## 13. Open questions (each with a recommendation)

Recommendations accepted by the planner on 2026-10-09; the human-run [verify] items are gathered per piece in §12.

1. **Where do worktrees live?** `<repo>/.claude/worktrees/<seat>` is where the mod and Claude's `--worktree` put them, and Claude's folder trust works there because the repo is trusted. The cost is an untracked `.claude/` in repos that do not ignore it. `~/.drove/worktrees/<repo>/<seat>` keeps repos clean, but risks a Claude folder-trust dialog per worktree. **Recommend `.claude/worktrees/<seat>` for v1** (proven), and test the outside-repo path once.
2. **Claude planner wake without the mod.** A dev channel (research preview, one confirmation per launch, claude.ai auth only) or keystrokes into the human's pane. **Recommend: try the channel first, fall back to keystroke wake after 5 s idle, and always piggyback.** If the channel does not start turns when idle, drop it and document that the mod is the comfortable Claude planner.
3. **Codex hook trust.** Constant command strings plus one approval by the human, or `--dangerously-bypass-hook-trust` per launch (which also runs any untrusted repo-local hooks). **Recommend constant strings and a one-time approval.** Bypass stays an explicit opt-in in `~/.drove/config.json`. Never prewrite trust hashes.
4. **Codex worker network.** `network_access=true` lets workers run `cairn` and package installs, but also makes `git push` possible, so only the guard prevents it. **Recommend network on, with the guard denying push** (workers need Cairn). Revisit if the Codex hook is unreliable.
5. **How the mod imports Drove.** An absolute path to `src/mod.ts`, or `npm link` plus a bare `drove/mod` import. **Recommend `npm link`, then `import … from 'drove/mod'`**, with `package.json` `exports` mapping `./mod` to `./src/mod.ts`. This depends on Claude's mod runtime resolving linked packages and handling `.ts` [verify].
6. **Promote for a Codex worker** needs a restart today. **Recommend restart with resume for v1**, and verify whether `codex queue -m` changes the model per turn: if it does, it replaces the restart.
7. **Does `herdr agent start` return ready when the agent begins with an initial prompt** (so it is `working` at once)? If it times out, **launch without the prompt argument and send the brief with `herdr agent prompt --wait`**, the proven path. Only Codex then lacks a thread until its first turn ends. That is fine, because later messages wait for the thread id.
8. **A long-poll `wait` tool for the planner** (block up to N seconds for the next report) would give both planners a wake with no keystrokes. It occupies the planner's turn, and Codex MCP tool timeouts are short by default. **Recommend not in v1**; reconsider if both the channel and keystroke wake disappoint.
9. **The event log grows without bound.** **Recommend rotating at 10 MB** (`events.1.jsonl`), and keeping runs for 14 days after `down`, as the mod's store pruning does.
10. **Human name in renders** (`for: human` shown as "Cal"). **Recommend a `~/.drove/config.json` `humanName`**, default "the human".
