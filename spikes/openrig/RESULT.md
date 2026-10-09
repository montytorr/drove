# openrig hands-on spike (CCS-49)

Tested `@openrig/cli` 0.6.8 with Codex CLI 0.162.0 in a Docker container (node:22-bookworm, arm64). Nothing ran on the host. Only the Codex seats were exercised, because Claude was skipped on purpose.

## Did it work, and how long

Yes. After an image build of about 30 s, the first useful rig took **about 5 min of my time**:

| Step | Time |
|---|---|
| `npm i -g @openrig/cli`, `rig setup`, `rig doctor` | about 1 min |
| Daemon start | about 1 min, once I found the tmux-server issue |
| Writing a 2-seat spec | about 2 min |
| `rig up` | **12.7 s** |
| First task end to end (queue create, build, handoff, review, PASS) | about 50 s |

Two traps cost me most of the debugging time:

- **The daemon needs a tmux server.** `rig daemon start` died with `error connecting to /tmp/tmux-1001/default`. `tmux new-session -d` first fixed it. It is a bad first-run error.
- **Codex's bwrap sandbox fails in Docker** (`No permissions to create a new namespace`). Seats stalled at an approval prompt. The default launch is `codex -s workspace-write`; `permission_policy: builtin:yolo` makes it `-s danger-full-access -a never`. Editing `~/.codex/config.toml` is not enough, because the launch flags override it. This is a Docker-specific problem, but it is the trap a container user will hit.

Concepts I had to learn (about 12): rig, pod, seat (member), AgentSpec with profiles, runtime, `agent_ref: local:`, permission policy, edges, qitem (queue item), canonical session name `seat@rig`, snapshot, kernel/operator, and the culture/startup-file layering.

Not tested: Claude seats, Herdr, workflows, and the web UI. `localhost:7433/` returns 404; there is a JSON API (`/api/rigs`, `/healthz`), and the UI is probably opened via `rig ui open`, which I did not try.

## What felt good

- **State detection is accurate and cheap.** `rig ps --nodes` showed `needs_input (permission_request)` the instant Codex asked for approval, then `working` and `idle`, and `WORK yes/no` tracked a qitem being owned. The source is Codex hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`), written into `config.toml` with trust hashes. A tiny relay script POSTs to `/api/activity/hooks` with a 1.5 s timeout and never blocks the agent.
- **The queue and handoff are a good primitive.** `rig queue create --destination seat --body ...` lands in the seat's pane as a nudge. `rig queue handoff <id> --to ...` closes the source and creates the new item with `handedOffFrom` provenance. Both Codex agents did this themselves, from the instructions in their `AGENTS.md`, with no hand-holding. States are `pending`, `in-progress`, `done` and `blocked/HELD`, with a mandatory closure reason, and there is an append-only transition log.
- **The message envelope is good.** `rig send` produces `From: X To: Y Sent: ... --- body --- ↩ Reply: rig send X "..."`. The receiver always knows who sent it and how to reply. Sending from outside a seat warns "no sender identity". `rig send` also refuses to type into an interactive prompt unless you pass `--dangerously-interact --reason`.
- **Auto-snapshot plus resume works.** `rig down` auto-snapshots (`auto-pre-down`, plus a periodic one every few minutes). `rig up duo` after that said `fully_restored` and both Codex sessions resumed with context. The builder correctly remembered "hello.py, reviewer said PASS".
- **Boot is fast** (12.7 s for two seats), and a one-seat `rig create` exists.
- **The TUI works** (explorer plus topology panes, vim-style command bar). It rendered fine in a 140x40 tmux pane. `rig mcp serve` exposes 18 tools (`rig_up/down/ps/send/capture/snapshot/restore/add/...`), mostly mirroring the CLI.
- **`rig capture` and `rig transcript`** give a plain read of any seat.

## What felt heavy

- **About 87 commands and a big footprint.** 97 MB installed, 20+ concepts, and the dist ships a full context-pack, workflow, slack, gateway, watchdog and agent-image machinery. A two-seat task touched maybe 8 commands.
- **Global config writes.** It edits `~/.codex/config.toml` (hooks plus trust hashes) and writes `AGENTS.md` into the project (untracked, with a warning telling you to gitignore it). `rig setup` also wants to install claude, herdr and tmux config. This is why the sandbox was mandatory.
- **Recovering one dead seat is unfriendly.** After I killed `dev-build`'s tmux session, the daemon noticed (lifecycle `attention_required`, reason `stop`) but did **not** restart it. `rig up duo --existing` refused ("has live sessions"). `rig seat clean` needs `--reason` and `rig seat launch` needs `--fresh`. In practice only `rig down` then `rig up` recovered it, which restarts the healthy seat as well.
- **Agents burn turns on boilerplate.** Each seat spent about 10-25 s of start-up reading skills and running `rig whoami`, `rig queue list` and `rg --files`. Codex also tried to relay to a nonexistent `operator@host`.
- **Confusing defaults.** Codex runs sandboxed by default but `-s workspace-write` fails under Docker. `--verify` on `queue create` waits 30 s for a Slack-style receipt that never comes (inert here). `rig queue list` hides done items by default.
- **Stray CLI crash.** `rig send --help | head` throws an unhandled EPIPE.

## Ideas worth copying, ranked

1. **Hook-driven activity state, not screen scraping.** Codex hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`) POST to a daemon. This gives exact working / idle / needs-input with a reason. (`daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs`; `rig ps --nodes --json`.) It is the biggest win for a planner that must not guess.
2. **A durable work queue with a handoff verb.** Owned items, state machine, mandatory closure reason, and `handoff` as one transaction that closes the source and creates the next item. (`rig queue create|claim|update|handoff|block`.) It maps directly onto planner to worker to reviewer.
3. **A message envelope with sender, recipient and reply command.** The receiver can always answer. (`rig send`; `lib/pane-envelope.ts`.)
4. **A guarded send.** Never type into a pane that is at an interactive or permission prompt, and make the override loud: `--dangerously-interact --reason`. (`rig send`; `domain/session-transport.ts`.)
5. **Canonical addressing `seat@rig`** for every seat across capture, send and queue. It makes scripting and logs readable.
6. **Auto-snapshot before teardown, plus resume ids.** `rig down` snapshots; `rig up` resumes each Codex session by id. Cheap and it worked first time. (`rig snapshot`, `rig restore`, `resumeType: codex_id`.)
7. **Declarative permission policy per rig or seat** that picks the launch flags (`builtin:yolo` gives `-s danger-full-access -a never`; the default floor gives `workspace-write`). Needed because config alone does not win. (`rig-spec.md` "Attaching a permission policy".)
8. **`rig capture` / `rig transcript`** for read-only inspection. The planner can read a worker's last N lines without attaching.
9. **A needs-you / attention concept.** A seat with `attention_required` and a reason (`rig parked`, `rig seat clear-attention`) is what a planner should surface to the user.
10. **Seat identity injected via env** (session name, node id, daemon URL, hook token), so every hook and CLI call stamps who it is from. This is how the sender header works.

## Do not copy

- Writing into global `~/.codex/config.toml`, Claude settings and `~/.tmux.conf`. We should pass hooks and flags per launch (`codex -c`, a per-worktree `CODEX_HOME`) and leave the user's config alone.
- A daemon plus SQLite plus tmux plus HTTP API as the minimum. We already have herdr for panes and the orchestrator plugin for state.
- Auto-writing `AGENTS.md` into the repo. Use an explicit brief, or a file that is gitignored by construction.
- The coordination layers L1 to L5, the workflow runtime, agent images, Slack and gateway, and the 87-command surface.
- Making the human learn pods, edges and agent specs just to start two workers. A brief should be a prompt, not a YAML spec tree.
- The "seat restarts nothing" behaviour: a dead worker should be detected and reported to the planner with a one-step relaunch.

## Minimum feature set if we build it ourselves

1. Spawn worker N (Claude Code or Codex) in a herdr pane inside its own git worktree, with a per-launch permission posture.
2. Hook-based state per worker (working / idle / needs-input with reason), from Claude hooks and Codex hooks, posting to the planner. Codex hooks can be passed via `-c` rather than a global config.
3. A tiny task queue: create, claim, handoff, done, with a closure reason and an append-only log. A SQLite file or a JSONL file is enough.
4. A guarded `send` with the From/To/Reply envelope. It refuses when the target is at a prompt, and warns when the sender is unknown.
5. `capture` of a worker's last N lines, and a `done` / `blocked` / `question` report path back to the planner.
6. Dead-worker detection with a one-command relaunch that resumes the session by id.
7. Snapshot of the roster plus resume ids before shutdown.
8. A status view for the planner (one line per worker: state, task, age), and an attention list.

## Environment and teardown

`Dockerfile`, `notes/duo.yaml` (the rig spec) and the `notes/s*.sh` run scripts are in this directory, along with `notes/log.md` (timed log). `auth.json` was mounted read-only at runtime and copied only into the container's own home; it was never baked into an image, committed or printed. The container's port 7433 was published to `127.0.0.1` but the daemon binds loopback inside the container, so the host never reached it; I used `docker exec` instead.

**Torn down:** container `openrig-spike` and image `openrig-spike` were removed. I created no volumes. The other volumes listed by `docker volume ls` predate this spike and were not touched.
