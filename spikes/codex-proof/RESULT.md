# CCS-48: Codex worker delivery path, result

Date: 2026-10-09. codex-cli 0.160.1 (installed), app-server daemon 0.162.0 (per CCS-47 notes), herdr 0.9.0, Node 22.18, model shown in the TUI: GPT-6.1-Sol high.

## Verdict

The transport works end to end with no Claude-only APIs. The one gap: the **first** brief of a fresh Codex TUI cannot go through `codex queue`.

| Step | Result |
|---|---|
| Codex TUI in a herdr pane with an extra `orch` MCP server | works (`launch.sh`) |
| Brief in, `report` tool called, outbox line written | works, 4 of 4 reports |
| Follow-up into the running session with `codex queue --thread` | works, no keystrokes |
| Follow-up while Codex is mid-turn | queued, runs as the next turn |
| herdr `agent` state for the Codex pane | correct, with some lag |
| First brief on a brand-new session | **needs `herdr agent prompt`** (see Finding 1) |

## Timeline (all from this run)

Launch by Cal at 10:18; agent `codex-proof`, pane `w23:p2`, thread `01a11fbe-0a6c-7973-bdeb-db61e3773d83`.

| Time (CEST) | Event |
|---|---|
| 10:18:30 | Codex up, herdr `idle`, `agent_session: null` |
| ~10:20 | Cal sends brief with `herdr agent prompt` (workers/orchestrator guards block it) |
| 10:20:53 | outbox line 1: `done / review / "wrote hello.txt"`, `sandbox/hello.txt` = `hello from codex` |
| 10:21:08 | `codex queue` follow-up 1 accepted (0.06s) |
| 10:21:20 | outbox line 2: `progress / none / "queue-ok"` (about 12s after queue) |
| 10:21:35 | `codex queue` long task (`sleep 40` then report `long-done`) |
| 10:21:38 | herdr `working` |
| 10:21:52 | mid-turn `codex queue` accepted instantly |
| 10:22:24 | outbox line 3 `long-done` (turn lasted 50s) |
| 10:22:31 | outbox line 4 `mid-turn-ok` (second turn, 6s) |
| 10:22:34 | herdr `done`; 10:22:53 `idle` |

Pane transcript confirms the order: the mid-turn message appeared as its own user message after the long task finished.

## Answers

**Does `codex queue --thread` reach a herdr-launched TUI session?** Yes, in spite of CLI 0.160.1 vs daemon 0.162.0. No version error. Output: `Queued message <uuid> for thread <thread-id>.` Returns immediately; Codex acts a few seconds later. Caveats:
- Needs a thread id. `codex queue --thread codex-proof` (the herdr agent name) fails: `Error: No active session found matching 'codex-proof'.` The id comes from `herdr agent get <name>` → `.result.agent.agent_session.value` (source `herdr:codex`), which is `null` until the first turn finishes.
- The daemon log shows a WARN each time `codex queue` runs, `failed to upgrade control socket websocket connection: WebSocket protocol error: Handshake not finished` (10:21:08, 10:21:35, 10:21:52), but the message is delivered anyway. Likely the 0.160 client probing the 0.162 socket first; harmless here, worth re-checking after an upgrade.
- `rpc.transport="in-process"` appears in the TUI's own log rows, yet queue still reached it, so the session is reachable through the shared daemon.

**Does Codex reliably call `report` when told to?** 4 of 4. Wording that worked:
- First brief: "You are worker codex-proof. Task: create a file named hello.txt ... When it is written, you MUST call the MCP tool report (server orch) with kind=done, expects=review, body=\"wrote hello.txt\". Calling the report tool is the only way I hear from you; do not just reply in text. After the call, stop and wait."
- Follow-ups only needed: "reply by calling the report tool (kind=progress, expects=none) with body exactly: queue-ok. Do nothing else."
Naming the tool, the server and all three field values was enough; the "only way I hear from you" line stops it answering in prose. Not tested: a brief with no mention of `report`, or a long task where Codex may forget.

**Mid-turn follow-up: queued, steered or lost?** Queued. It did not interrupt or steer the running `sleep 40` turn, was not lost, and ran as a separate turn about 7s after the first finished (`long-done` then `mid-turn-ok`). `codex queue` does not block while the turn runs.

**Does `herdr agent list` show correct idle/working/done?** Yes, with lag:
- `idle` before any work, `working` during the 56s run (flipped 3s after the queue), `done` when the turn ended, `idle` about 19s later (when seen/read).
- `agent_status` is a good "ready for input" signal (`idle` and `done` both mean ready), but lagged once: 7s after follow-up 1 was queued it still read `idle`, although the report landed at +12s. Poll the outbox, not only the state, to know a turn finished.
- `herdr agent explain` shows detection comes from the OSC title (`osc_title_idle`, evidence `w-codex`), not from Codex events.

**Which unverified points held?**
- Quoted `-c` passthrough: yes. `agent-start.json` argv shows all seven `-c` args intact, including the TOML table for `env`.
- `default_tools_approval_mode="approve"`: accepted by 0.160.1, no approval prompt on `report`.
- Trust override `projects."<sandbox>".trust_level="trusted"`: no trust prompt shown (Cal accepted nothing extra).

## Findings

1. **First turn cannot use `codex queue`.** A fresh TUI has no thread until its first turn, and herdr's `agent_session` is `null` until then. The first brief has to be typed in or sent with `herdr agent prompt`. In this rig neither the worker nor the orchestrator role may drive a pane, so a cross-agent orchestrator needs its own "prompt agent" tool (a thin wrapper over `herdr agent prompt ... --wait`) for that first brief; from the second message on, `codex queue` is enough. Alternative to explore: start Codex already inside a thread, e.g. `codex resume`/`codex exec` with an initial prompt argument, so the thread exists at launch (not tried; `codex <PROMPT>` as launch arg would also work if the launcher is allowed to pass it).
2. **The "⚠ 4 warnings" footer.** Not identified. The daemon log (`~/.codex/logs_2.sqlite`) shows three `app-server event: warning` rows at 10:18:30 (startup, next to `skills/list`, `hooks/list`, `config/batchWrite`) but not their text, and no WARN/ERROR rows for this thread. Probably startup config/skill/hook notices from the global `~/.codex` setup; press `f2` in the pane to read them. Does not affect the transport.
3. **herdr output for the pane after finish:** the pane stays alive at the prompt; the session id stays valid, so many `codex queue` calls reuse one thread.
4. **`report` tool design held up:** newline-delimited JSON-RPC stdio, protocol echo of the client's version, validation errors returned as `isError` results. Codex rendered it as `Called orch.report`.

## Stretch: PreToolUse hook denying apply_patch

Prepared, **not run** (it needs a second Codex launched by Cal): `launch-planner.sh` starts `codex-planner` with an inline `-c hooks.PreToolUse=[{matcher="apply_patch|Edit|Write", hooks=[{type="command", command="sh .../deny-apply-patch.sh"}]}]`, without `--dangerously-bypass-hook-trust`, so the hook-trust prompt behaviour is recorded. `deny-apply-patch.sh` prints a `permissionDecision: deny` JSON (shape unverified for Codex 0.160; tested only that it emits valid JSON). The inline `-c` syntax for hooks is a best guess; there is no existing PreToolUse example in `~/.codex/hooks.json`. To finish: Cal runs `sh launch-planner.sh`, then the brief "use apply_patch to create planner.txt, then report what happened" goes in with `herdr agent prompt`, and we check whether `sandbox/planner.txt` exists and what the trust prompt said.

## Files

- `orch-mcp.mjs`: the MCP server. `test-orch-mcp.mjs`: stdio test (passes).
- `launch.sh`: the one script Cal ran. `drive.sh`: `thread | status | queue MSG | outbox | wait N`. `poll.sh`: 1s state poller.
- `launch-planner.sh`, `deny-apply-patch.sh`: stretch, untested.
- Not committed (gitignored): `outbox.jsonl`, `*.log`, `sandbox/*`; `agent-start.json` is a run artifact.

## Commands used

```sh
sh launch.sh                                   # Cal, from his herdr pane
sh drive.sh status                             # herdr agent get codex-proof
sh drive.sh thread                             # agent_session.value, null until the first turn ends
herdr agent prompt codex-proof "<brief>" --wait --timeout 120000   # first brief only
sh drive.sh queue "<follow-up>"                # codex queue --thread <id> --message ...
sh drive.sh outbox                             # JSON lines from the report tool
```
