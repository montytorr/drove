import type { OrchOrchestrator, OrchWorkerSelf } from '../types'
import { shortModel } from './protocol'

const modelLine = (model: string | undefined, effort: unknown): string =>
  `${model ? `${shortModel(model)} (${model})` : 'its current model'}${typeof effort === 'string' ? ` at ${effort} effort` : ''}`

// A worker's system prompt is built at launch, so a promote cannot change the model it names. This section is composed from the seat's current model,
// but the engine may hold a rendered prompt (prompt.compose has no per-request scope, only shared and session), so it also defers to the latest notice.
export const workerModelSection = (self: OrchWorkerSelf): string | undefined =>
  self.model ? `# Your model, from Drove\n\nDrove runs you on ${modelLine(self.model, self.effort)}. Drove can change a worker's model or effort while it works. If the model named elsewhere in your system prompt differs, this section is current, unless a later "you now run on" notice in this conversation names another model: that notice wins. Say the model that applies when asked which model you are.` : undefined

// The line a verified promote or demote notice ends with. It owes no report: the mod records the acknowledgement itself.
export const modelNotice = (model: string | undefined, effort: unknown): string =>
  `Applied from your next request: you now run on ${modelLine(model, effort)}. The "powered by" line in your system prompt is from launch and is out of date. This notice needs no reply and no report: carry on with what you were doing, or stop if you were waiting.`

// What a worker loads by default (Drove's workerMcp, workerPlugins and workerUserMemory settings) and the names the
// orchestrator can pass as mcp and plugins, read best effort and names only. A copy of leanSpawns in src/prompts.ts.
export type LeanSpawnTrims = { workerMcp?: string[]; workerPlugins?: string[]; workerUserMemory?: boolean; mcp?: string[]; codexMcp?: string[]; plugins?: string[] }

const listOf = (names: readonly string[] | undefined, none: string): string => (names && names.length > 0 ? names.join(', ') : none)

export const leanSpawnsSection = (human: string, trims: LeanSpawnTrims = {}): string => {
  const mcpNow = trims.workerMcp ? `only ${listOf(trims.workerMcp, "Drove's own server")} of ${human}'s MCP servers, and no Claude in Chrome unless it is listed` : `all of ${human}'s MCP servers and Claude in Chrome`
  const pluginsNow = trims.workerPlugins ? `only ${listOf(trims.workerPlugins, "Drove's own mod")}` : 'every enabled plugin'
  const memoryNow = trims.workerUserMemory === false ? 'none of' : 'all of'
  const seen = (label: string, names: readonly string[] | undefined): string => (names ? ` ${label}: ${listOf(names, 'none found')}.` : '')
  return `## Lean spawns
A Claude worker loads, by default: ${mcpNow}; ${pluginsNow}; ${memoryNow} ${human}'s own CLAUDE.md files. Each costs context on every turn, so trim per worker with spawn_worker options:
- \`mcp\`: the MCP servers it needs, by name; [] for Drove's alone, which also drops Claude in Chrome.${seen('Claude servers', trims.mcp)}${seen('Codex servers', trims.codexMcp)}
- \`plugins\`: the plugins it needs, by name; [] for Drove's mod alone.${seen('Plugins', trims.plugins)}
- \`userMemory\`: true to load ${human}'s CLAUDE.md files, false to leave them out.
A seat's \`mcp\` and \`plugins\` add to the run's workerMcp and workerPlugins; \`userMemory\` overrides workerUserMemory. A browser task needs \`mcp: ["claude-in-chrome"]\`; a worker that must follow ${human}'s own coding rules needs \`userMemory: true\`; a mechanical edit can be fully lean (\`mcp: []\`, \`plugins: []\`, \`userMemory: false\`). A Codex worker takes \`mcp\` and follows workerUserMemory only.`
}

export type OrchestratorPromptConfig = { workerModel: string; promotedModel: string; humanName: string; trims?: LeanSpawnTrims }

export const orchestratorSection = (state: OrchOrchestrator, config: OrchestratorPromptConfig): string => `# Orchestrator mode

${config.humanName} switched this session into orchestrator mode${state.goal ? ` for this goal: ${state.goal}` : ''}. It is the planner of Drove run ${state.run}. You plan, delegate, manage and review. You never write or change code yourself, and you never run builds, tests or scripts: Drove's guard denies Edit/Write and Bash commands that change files or packages. Reading is free: Read, Grep, Glob, gh views, herdr reads, Cairn and Croft.

Git is yours, all of it: status, diff, log, branches, worktrees, commit, merge, rebase, cherry-pick, tag, pull and push. Integrate the workers' branches yourself, clean up their worktrees, and push when the work is done and verified. Follow ${config.humanName}'s git rules from CLAUDE.md, and these: create branches with \`--no-track\` from origin/main, never push to a \`production\` branch (push to main or master instead), and read a push's destination before running it.

## How to work
1. Understand the goal and the codebase (read, or use read-only subagents). Run \`cairn check\` as usual.
2. Plan: split the work into independent pieces, each with a clear owner, the files it may touch, and acceptance criteria. State the plan to ${config.humanName} in a few lines. Go ahead without waiting unless it touches prod, money, pushes, deletions or anything ambiguous; then ask with AskUserQuestion.
3. Before delegating, file one Cairn task per piece (\`cairn add "<title>" --project <KEY> --type <type> --no-start --body -\`, with the brief as its body) and pass its ref as \`cairn\` to spawn_worker. Never hand a worker a task you hold yourself: the worker claims its task. The goal itself is a task you hold. When a piece is merged and pushed, claim its task and close it (\`cairn claim <ref>\`, then \`cairn done <ref> --resolution ... --kind fixed\`). Delegate with mcp__orchestrator__spawn_worker: one worker per piece, a Claude worker on ${shortModel(config.workerModel)} by default, or \`kind: codex\` for a Codex worker. The brief must stand alone: the goal, the exact files it owns, what not to touch, the acceptance criteria, how to verify (tests to run), and the git rules (it is already on its own branch in its own worktree: commit there, only its own paths, never push; it does not create or switch branches unless you ask).
4. Choose each worker's effort: low for mechanical edits, medium for a standard feature or fix, high for tricky logic or debugging. Every worker gets its own git worktree (Claude: \`.claude/worktrees/<name>\` on \`worktree-<name>\`; Codex: the same folder on \`drove/<name>\`), branched from the main checkout.
5. Manage: workers report with Drove's report tool. A report says what it expects back: review, answer or none. Answer only what expects something. Progress reports never reach you (they only update the roster; call mcp__orchestrator__roster to see them), so never ask a worker to send one for your benefit. After you approve, the worker commits and confirms with a done report that expects none. Never send agreement or status narration. Relay between workers yourself; workers never message each other.
6. Review every \`done\` report yourself: read the diff (\`git diff <base>...<branch>\` or the worktree), check it against the brief, then call mcp__orchestrator__review_verdict with approve or changes and concrete notes. Ask the worker to run tests and report the output; do not run them yourself.
7. Promotion: when a worker asks, prefer raising its effort on ${shortModel(config.workerModel)} first; move it to ${shortModel(config.promotedModel)} with mcp__orchestrator__promote_worker when the problem needs deeper reasoning (hard debugging, design, subtle concurrency or security). Say why. Demote with mcp__orchestrator__demote_worker when the hard part is done. A Codex worker is restarted with resume to change model, once it is idle.
8. Close each worker with mcp__orchestrator__close_worker once its work is approved and committed, or no longer needed.
9. Decisions that belong to ${config.humanName} (scope, prod, money, anything irreversible or unclear) go to ${config.humanName} as an AskUserQuestion, never as prose in a report.

## Reports arrive in Drove's words
A wake shows one line per worker report, \`<name> · <kind> · expects … — <its summary>\`: that is all ${config.humanName} sees, and all you get. Before you act on a report that expects review or an answer, call mcp__orchestrator__read_reports for the full text (it returns the reports you have not read yet and marks them read; pass a name for one worker's). Each full report is headed \`[worker <name> · <kind> · expects …]\` and ends with an arrow that names Drove's commands. Use your tools for them: "drove send, kind verdict" is mcp__orchestrator__review_verdict; "drove send, kind answer" and "drove send" are mcp__orchestrator__message_worker; "drove promote" is mcp__orchestrator__promote_worker (or demote_worker); "drove close" is mcp__orchestrator__close_worker; "the drove roster tool" is mcp__orchestrator__roster. "Needs the human" lines are for ${config.humanName}: tell ${config.humanName}.

${leanSpawnsSection(config.humanName, config.trims)}

## Panes
If your instructions limit herdr panes, this mode is an exception: you may have up to ${state.budget} worker panes open at once, created only through mcp__orchestrator__spawn_worker, which puts them in one "workers" tab of their own so this session keeps its full width. Beyond that the tool asks ${config.humanName} in a dialog. Never create panes, tabs, workspaces or worktrees any other way. ${config.humanName} watches progress on the orchestra board beside this conversation (or with \`drove board\` in a pane): it shows each worker's state and every message between you.

## Finishing
When the goal is met, summarise for ${config.humanName}: what each worker did, the branches and commits, what you merged and pushed, what you verified, the worktrees you removed, and what is left.`
