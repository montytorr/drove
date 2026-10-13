# Lean workers

Each worker is a full Claude Code or Codex session, and by default it loads everything you have configured: every MCP server, plugin, skill, agent type, memory file and hook. This page covers choosing the agent for a worker, changing it mid-run, trimming what each worker loads, and the `spawnPolicy` that bounds what the planner may hand out. Back to the [README](../README.md).

## Claude or Codex for a worker

A spawn names the agent with `--kind claude|codex`, or leaves it out and follows `workerKind` in `~/.drove/config.json`:

- `auto` (the default): Claude when it is on the host, else Codex.
- `claude` or `codex`: that kind for every spawn that names none; the rules below become the exceptions.

The planner's role text carries these rules, and shows them only when both kinds are on the host (with one, it says which and spawns use it):

- **Codex:** a self-contained implementation with clear acceptance tests (backend, algorithms, refactors, test suites), and long mechanical work.
- **Codex for review and load:** the reviewer of a Claude worker's branch (and Claude for a Codex worker's), so a review comes from another model; also when a run has more than 2 or 3 workers, or after a seat of the other kind hit a usage limit.
- **Claude:** UI and visual work that needs a Chrome check; work that relies on your skills, MCP servers, plugins or agents (a Codex seat ignores those trims); anything that needs a back-and-forth with you.

A Cairn task labelled `kind:codex` or `kind:claude` asks for that kind, and the planner's goal carries the label.

Which agents are on the host is detected when a run is planned, attached or brought up, and saved on the run (`drove doctor` runs the same check). A spawn or migrate to a kind the host lacks is refused. A run where neither `claude --version` nor `codex --version` answered is treated as having both.

A Codex seat on your default model shows it by name (from `~/.codex/config.toml`, profiles included) on the board, the web page and `drove roster`.

## Promote, demote, migrate

- **`promote`** changes a worker's model or effort; **`demote`** moves it back. `--model` is optional, so a Codex worker on its default model can be promoted by effort alone.
- A Claude worker with the mod switches on its next request and is told its new model. Otherwise, and for Codex, Drove restarts the agent with resume once it is idle.
- **`migrate`** moves a seat to the other kind: Drove stops the agent and starts the other kind fresh in the same worktree, without resume, with a handoff brief (the saved brief, the branch's commits, uncommitted changes, `git status` and the last three reports).

A migrated seat keeps its name, branch, token and Cairn task (Drove releases the old claim so the new agent can take it), and the roster records `migratedFrom`. The turn in flight is lost.

A Claude seat moved from Codex runs in Drove's worktree with no `--worktree`, because Claude trusts a linked worktree through its main repo. If the new agent does not start, the seat goes back to its old kind, marked gone, and `drove up --seat` resumes the old session.

**Usage limits.** A worker that hits its plan limit gets a `usage-limit` attention item and is never nudged. Drove sees it on the limit screen, and for Claude also through the `StopFailure` hook (`error: rate_limit` or `billing_error`), which keeps the item after the text has scrolled away. The planner can wait for the reset, close and respawn, or migrate the seat to the other kind.

## What a worker loads

A worker loads your whole Claude setup unless you trim it. Each trim has a run-wide key in `~/.drove/config.json` and, for a Claude worker, an option on one spawn (`drove spawn`, the planner's `spawn` tool, or the mod's `spawn_worker`).

The planner chooses per worker: its role text has a short "Lean spawns" paragraph that says what a worker loads under your config and lists your MCP server, plugin, skill and agent names, read from your Claude and Codex files (names only, never written).

| A worker loads | Run-wide key | Per spawn | Default | Saves per worker |
|---|---|---|---|---|
| your MCP servers | `workerMcp`: a list of names | `--mcp a,b` / `mcp` | all of them | the tools of each server left out |
| Claude in Chrome | the same list: a lean worker runs `--no-chrome` unless it names `claude-in-chrome` | the same option | loaded | about 2.2k tokens |
| plugins and mods | `workerPlugins`: names, with or without `@marketplace` | `--plugins a,b` / `plugins` | every enabled one | about 0.2k tokens |
| your memory files | `workerUserMemory`: `false` to leave them out | `--user-memory on\|off` / `userMemory` | loaded | about 5.3k tokens |
| skills: yours, your commands and your claude.ai ones (Claude); those linked into the run's Codex home (Codex) | `workerSkills`: a list of names; `[]` loads none | `--skills a,b` / `skills` (Claude) | all of them | about 5k tokens with `[]` (up to about 6.5k with the claude.ai ones), about 0.1k per skill left out |
| your agent types (`~/.claude/agents`) | `workerAgents`: a list of names; `[]` hides all of yours | `--agents a,b` / `agents` | all of them | about 2.3k tokens for 28 agents |
| the hooks in your `settings.json` | `workerUserHooks`: `false` to leave them out | `--user-hooks on\|off` / `userHooks` | run | about 2.8k tokens of hook output; about 10k with the skills, agents and commands it also drops |

- **Lists add up:** a worker gets the run's list plus its own. A list on a spawn makes that worker lean even when the config key is unset, and `[]` means Drove's server (or Drove's mod) alone. With neither set nothing is trimmed.
- **`userMemory` on a spawn wins** over `workerUserMemory` both ways. Memory files are your `~/.claude/CLAUDE.md` and any `CLAUDE.md` in the folders above the repo; the repo's own files always stay.
- **The options belong to the seat,** so `promote`, a restart, `up` and `migrate` keep them. A name that matches nothing you have is reported in the spawn result, and the worker runs without it.
- **Drove's own report tool,** `mcp__drove__report`, is the worker's one report tool, and Drove's own mod (`orchestrator`) is never trimmed.

### Skills

The names are the folders in `~/.claude/skills`, the files in `~/.claude/commands`, and your claude.ai skills as `anthropic-skills:<name>` (a name without the prefix matches too).

A skill the list leaves out is switched off for that worker only. `[]` starts it with `--disable-slash-commands`, which drops every skill, plugin and bundled ones included. Plugin skills follow `workerPlugins`. Claude's own bundled skills (`/debug`, `/simplify`) otherwise stay, because switching them off made the first request bigger.

### Agents

An agent the list leaves out is hidden from the worker's Agent tool with a `permissions.deny` rule `Agent(<name>)`. Claude's built-in agents (`Explore`, `Plan`, `general-purpose`), plugin agents and the repo's own `.claude/agents` stay.

### User hooks

Claude has no switch for the hooks in your `settings.json` alone (`disableAllHooks` also turns Drove's own off). The one lever is to start the worker without the `user` setting source: `--setting-sources project,local`.

That also takes away what Claude reads from the same place: your own skills, agents and commands (so `workerSkills` and `workerAgents` have nothing left to trim) and your user-scope MCP servers.

Drove puts back what it can: your `settings.json` minus its hooks (env, permissions, plugins, the bypass consent) goes into the worker's own settings, and your user-scope MCP servers go into its `mcp.json` (an allowlist still narrows them). `CLAUDE.md` is untouched, because memory has its own switch.

Project and local hooks, and the hooks of the plugins you leave enabled, stay. For Codex the key leaves your `hooks.json` out of the run's `CODEX_HOME`; Drove's own hooks stay.

### Codex workers

- `mcp` works per seat; `workerSkills`, `workerUserMemory` and `workerUserHooks` apply to the whole run.
- A Codex worker reads your `AGENTS.md` from its `CODEX_HOME`, which every seat of a run shares, and Codex has no per-launch switch for it (`project_doc_max_bytes` only limits the repo's own `AGENTS.md`).
- So `userMemory`, `userHooks`, `plugins`, `skills` and `agents` on a Codex spawn change nothing, and the spawn result says so. They are stored on the seat, so a migrate to Claude uses them. Set `workerUserMemory: false` or `workerUserHooks: false` for the run instead.

**The run's Codex home.** `codex-home/` in the run folder is the `CODEX_HOME` Drove gives Codex workers. Drove writes its `config.toml` (the MCP server, repo trust and hook trust) and `hooks.json`, and symlinks your `auth.json`, `AGENTS.md` and skills into it, so the launch line stays short and Codex asks no hook-review question. Your own `~/.codex` is read, never written.

**Sandbox.** Codex workers run with approvals and the sandbox bypassed, like Claude workers with `--dangerously-skip-permissions`. Drove's guard hook still denies pushes. Set `codexWorkerSandbox` to `"workspace-write"` to turn that off.

### Examples

A run-wide setting, in `~/.drove/config.json`:

```json
{ "workerMcp": ["notion"], "workerPlugins": ["context7"], "workerSkills": ["cairn"], "workerAgents": [], "workerUserMemory": false }
```

One worker that needs a browser and your own coding rules, on top of that:

```sh
drove spawn w-ui --kind claude --cairn APP-12 --brief - --mcp claude-in-chrome --user-memory on
```

A mechanical edit can drop everything: `--mcp '' --plugins '' --skills '' --agents '' --user-memory off --user-hooks off`.

## Spawn policy

`spawnPolicy` constrains what the planner may give a worker. Set it in `~/.drove/config.json` or in the committed run base's `.drove.json`. `drove policy [--run ID] [--json]` prints the merged policy and its errors, and both planners' prompts show the same, freshly read.

**Keys:** `kind`, `model`, `effort`, `mcp`, `plugins`, `skills`, `agents`, `userMemory`, `userHooks`, `owns`, `role`, `maxTurns`, `maxTokens`, `maxMinutes`, `maxCost`, and `bound`.

| Rule | Meaning |
|---|---|
| `{"fixed": value}` | supplied when omitted; a conflicting request is refused. A fixed list is exact, e.g. `{"mcp": {"fixed": []}}` |
| `{"choice": [values]}` | non-empty; checks effective defaults too. For a list setting, every requested entry must be one of these, e.g. `{"owns": {"choice": ["src/**", "test/**"]}}` |
| `{"required": true}` | the setting must be given; `{"bound": {"required": true}}` requires at least one seat limit |
| `{"max": number}` | numeric settings only |

Rules may combine. When both files set one, the narrower wins: choices intersect, maxima take the smaller value, `required` survives from either, and conflicting fixed rules refuse.

**Where it is enforced.** Spawn, promote and demote (`model`, `effort`), migrate (`kind`), `drove owns`, and stored seats relaunched by `drove up`, including the defaults each seat would use. A refusal has code `policy`.

- Fixed rules replace defaults, and maxima constrain configured default bounds.
- Once a policy names `mcp`, `plugins`, `skills` or `agents`, the seat's list replaces `workerMcp`, `workerPlugins`, `workerSkills` or `workerAgents` instead of adding to them. Omitted lists default to the configured list or none, then pass the same checks.
- Claude model aliases and full names compare equally; Codex comparisons stay literal.
- Policy-controlled Codex skills, memory and hooks also shape the run's shared `CODEX_HOME`.

`drove doctor` validates the policy (unknown keys, wrong types, empty choices, fixed values outside choices, maxima on non-numbers) and reads the repo's from the git root. A local or `--pr` merge that changes `spawnPolicy` is refused with `policy-change`: a human must merge it.
