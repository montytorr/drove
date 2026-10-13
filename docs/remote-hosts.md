# Running Drove on another machine

Drove runs where the code lives: a client's laptop, a dev box, a CI host. Nothing in it talks to a Drove service; a run is `~/.drove` plus the repo's worktrees plus a herdr server. This page covers setting up such a host, starting runs on it without a person at the keyboard, and keeping a client's work separate. Back to the [README](../README.md).

## Install

Node 22.18+, `git`, herdr 0.9+, `claude` and/or `codex` (signed in), `gh` (signed in, only for `drove merge --pr`) and the Cairn CLI. Clone Drove, run `npm install`, then `./src/cli.ts setup --yes` from the clone: it links the CLI, installs the mod and creates `DROVE_HOME` without asking, and does nothing the second time. See the [README's Install](../README.md#install).

Then run `drove doctor` from the repo. It checks Node, git and the repo's remote, herdr and its server, `claude` and `codex`, `gh` and its sign-in, `cairn` with one read, `DROVE_HOME`, the mod's `nodePath` and whether the mod is installed (`mod`). Each check is `ok`, `warn` or `fail` with a one-line fix.

The exit status is 1 when a check fails, so a setup script can gate on it (`drove doctor --json` for a script). It is read-only and never starts a server; the planner and workers may run it.

## Cairn sign-in

Every worker claims a Cairn task, so the machine needs a signed-in `cairn`.

- `cairn setup --url <instance>` pairs keys in the browser and installs the CLI, hooks and skill; it is safe to re-run.
- On a host with no browser, pair on a machine that has one and set `CAIRN_BASE_URL` and `CAIRN_API_KEY` in the environment Drove runs under.
- With several instances, name each (`cairn instance add <name> --url <url>`) and route a repo to one (`cairn route add <instance> --folder`), so a client's tasks stay on the client's instance.

`drove doctor` proves the sign-in with one read (`cairn projects`).

## herdr on a headless host

Drove never starts herdr. Start the server yourself in a persistent session: tmux, screen, or a service such as a systemd user unit or a launchd agent running `herdr`. Give Drove's commands the same `HERDR_SOCKET_PATH` if the socket is not the default. `drove doctor` fails with the reason when no server answers.

## Start a run unattended

From cron, a webhook or a chat command:

```bash
drove plan --from-cairn REF --detached --json   # opens a workspace of its own, returns at once
drove attention --all --json --follow           # what waits on a person
drove up --run ID --detached                    # resume
```

The JSON shapes and failure codes are in [Unattended runs](unattended.md). Trust the repo and approve Drove's hooks once, by hand, before leaving a job alone: Drove never answers a dialog.

## How reports come back

- A worker's `done`, `question` and `blocked` reports reach the planner in its pane. `drove reports --json` reads them in full, and `drove roster --json` shows who owes one.
- Every worker also leaves its findings and status on its Cairn task (notes, then `in-review`), which outlives the run and is readable from any machine on the instance.
- What needs a person is `drove attention`. A forwarder such as Bothy can turn those items into alerts; until one runs on the host, poll `drove attention --all --json --follow` yourself.

## Client-project checklist

- **Keep the client's code on the client's machine.** Run Drove there, not on a machine of yours with the code mounted or copied. Prompts and diffs go to the agent's provider either way, so confirm the client allows that.
- **Use a separate `DROVE_HOME` per client** (`export DROVE_HOME=~/.drove-acme`), so run state, session ids and `config.json` never mix. Set it in every command and job that touches the run.
- **Keep secrets out of `workerEnv`.** Its values are in `~/.drove/config.json` and in every worker's environment, so any worker (and its logs) can read them. Put a client secret in the repo's ignored `.env` and copy it with `workerCopy` ([isolation](isolation.md)), or let the agent's own sign-in carry it.
- **Use the client's Cairn instance** (or a project on yours they cannot read) for their tasks: a worker's notes quote their code.
- **Review before you merge.** `drove merge --pr` pushes the branch, so check the remote is the client's.
