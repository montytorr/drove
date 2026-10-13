# Isolating workers

A git worktree gives each worker its own files and branch. It does not give it its own ports, database or untracked config. This page covers how Drove makes sure a worker really runs in its worktree, and the config keys that add per-seat ports, environment and copied files. Back to the [README](../README.md).

## The worktree

- A **Claude worker** gets its worktree from `claude --worktree <seat>` (branch `worktree-<seat>`).
- A **Codex worker** gets one made by Drove (branch `drove/<seat>`).

A Claude worker gets its brief only once its worktree exists and herdr reports the pane's foreground cwd inside it. Otherwise the spawn fails with `no-worktree`, the screen is saved to `start-failure.txt` in the seat folder and the pane is closed, so no worker ever edits the base checkout.

The worker never pushes; a hook denies it. A worktree is removed only on request (`drove close --remove-worktree`) and only when its branch is merged.

A Claude seat is closed by closing its pane, never with `/exit`; Drove releases the worktree lock Claude leaves behind. Codex gets `/quit` first.

Several runs can be open at once, for example one per herdr workspace. herdr agent names are shared across the server, so Drove names each agent `<seat>-<run tag>`. Two runs of one repo share the worktree folder, so a spawn that would reuse a seat another run still holds is refused.

## Ports, environment and files

These keys in `~/.drove/config.json` cover the common cases. Each applies at launch, and the seat keeps its slot through restart, promote, `up` and migrate.

| Need | Key | What a worker gets |
|---|---|---|
| its own dev-server port | `workerPorts`: `{ "base": 4100, "stride": 10 }` | `PORT` (= base + slot × stride), `DROVE_PORT_BASE` (the same) and `DROVE_PORT_COUNT` (= stride) in its env, and a line in its brief. Each open seat takes the lowest free slot, so a closed seat's slot is reused. |
| its own database or paths | `workerEnv` values may use `{seat}`, `{run}`, `{slot}` and `{port}` | `DATABASE_URL=postgres://localhost/app_{seat}` becomes `app_w-api` for that seat. An unknown `{name}` is left as written and the spawn result says so. |
| your untracked config | `workerCopy`: globs relative to the repo root, such as `[".env", ".env.local"]` | Files git ignores that a worktree lacks, copied from the main checkout at spawn. An existing file is never overwritten, and a file git does not ignore is refused with a note, so a copy never shows up as a change. |

`workerEnv` is also the place for plain extra variables (`{"MY_FLAG": "1"}`). Its values sit in `config.json` and in every worker's environment, so keep secrets in a copied `.env` instead ([client checklist](remote-hosts.md#client-project-checklist)).

The brief's footer gives a worker its ports and the files copied for it, only when set.

## Containers

A container or VM per seat is not built. DESIGN.md's "Isolation" section (in §5, Launch specs) says what a worktree isolates and when a container is worth it.
