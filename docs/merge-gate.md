# The merge gate

A worker's branch lands only through `drove merge <seat>`, which runs the repo's checks in the seat's worktree and merges exactly the commit it checked. Before the planner even reads a `done` report, Drove runs a fast subset of those checks itself and sends failures straight back to the worker. Optional reviewer and tester seats add a second pair of eyes. Back to the [README](../README.md).

## The way in

The planner never merges a worker's branch by hand: the guard denies `git merge` of a `worktree-*` or `drove/*` branch with "use drove merge <seat>: it runs the checks first". The way in is `drove merge <seat>`, the planner's `merge` tool or the mod's `merge_worker`.

`--no-checks` skips the local checks. It is for the human, from their own terminal with `--run ID`: Drove refuses it inside a Drove session and the guard denies it to the planner.

## Which checks

1. The `checks` list in the repo's `.drove.json`, run in order with `sh -c`:

   ```json
   { "checks": ["npm run typecheck", "npm test"] }
   ```

   An empty list declares that there are none.
2. Without one, the `typecheck`, `lint` and `test` scripts of `package.json` (the same commands `drove spawn` lists in a worker's brief).
3. Else the `typecheck`, `lint`, `test` and `check` targets of the Makefile.

A repo with none of these is refused until it declares some. The list is read from the main checkout (the base), not from the worker's branch, so a branch cannot loosen its own gate.

## Local merge (default)

- The seat's worktree must have no uncommitted changes: the checks would test what the merge does not carry.
- The main checkout must be on the run's base branch and clean.
- The checks run in the seat's worktree. The first failure refuses the merge and returns that check's output tail.
- On a pass, Drove merges `--no-ff` into the base with the message `merge: <the branch's last commit subject>` (`-m` overrides it).
- A conflict is aborted and refused, leaving the base untouched.

The result is local and unpushed; the planner pushes when the work is done.

## Merge through a pull request (`--pr`)

The repo needs a remote. Drove pushes the seat's branch to `origin` (never `production`, never forced) and opens a pull request with `gh pr create`. The title is the last commit's subject and the seat's Cairn ref; the body lists the commits, the Cairn ref, the run and the seat.

Drove then reads `gh pr checks`:

| PR state | Answer |
|---|---|
| a check failed | refused, naming the failed checks |
| checks running, no check yet while the repo has workflows, or a review still required | `pending: … <PR URL>`: run `drove merge <seat> --pr` again later (it reuses the PR; do not poll) |
| GitHub refuses the push with a 5xx or a network error, or `gh` is down | pending |
| everything green | `gh pr merge` (`--squash` for one commit, else a merge commit), the remote branch is deleted and the local base fast-forwarded from `origin` |
| conflict, requested changes, or `gh pr merge` refused | refused with the reason |

A repo with no CI counts as green only after the local checks pass; they run before anything is pushed. A repo with workflows whose PR shows no check ten minutes after it opened is treated the same way.

A MERGED PR is trusted only when its head is the branch tip. One `--pr` merge shares a 300-second budget between its `gh` calls (45 s each) and its push, fetch and branch delete (90 s each), so a slow GitHub ends in `pending` rather than a timeout.

## Check evidence

Every run of the checks is recorded, one line per command, in `~/.drove/runs/<id>/checks.jsonl`: seat, command, worktree, the worktree's HEAD, whether the tree was clean, exit code, duration and the last 2 KiB of output. A command that timed out keeps exit code 124 and is marked `timedOut: true`.

`drove checks <seat>` (the `run_checks` tool, in both planners) runs the merge plan's checks in the seat's worktree. It answers pass or fail per command with the failing tail, the commit and whether the tree was clean, and never writes to the repo. A worker cannot call it.

**Reuse.** When every check of the plan has a passing record at the seat's current HEAD on a clean tree, neither `drove checks` nor `drove merge` runs them again. The merge says `checks reused: passed at <sha> <time>`.

These mean a fresh run: a new commit, a dirty worktree (including one a check itself dirtied, such as `lint --fix`), a missing or failing record, an unreadable ledger line, or `--fresh` (`fresh: true` on the tools).

**The commit that was checked is the commit that lands.** The merge refuses with `head-moved` when the worktree's HEAD is not the branch's tip, and merges (or, with `--pr`, pushes) that exact sha.

The boards show each seat's last result at its HEAD as `chk✓`, `chk✗` or `chk~` (stale: HEAD has moved). `drove report` counts the runs and failures per seat.

## Drove checks a done report first

When an implementer sends `done` expecting a review, Drove runs checks in the seat's worktree before it wakes the planner. Reviewers and testers are not checked: they run checks themselves.

- **Which commands.** `autoChecks` in the repo's `.drove.json`, a fast subset such as `{"autoChecks": ["npm run typecheck"]}`. Without it, the merge plan above. An empty list turns the step off. Give a repo a fast list: the default is the whole merge plan.
- **How.** In the background, one per seat and two at a time per run, never holding up the watcher. A worker that reported before committing is checked too, and the result says `dirty`.
- **A failure** goes back to the worker as a `changes` verdict opening "Drove's checks failed", with the failing command, its exit code and the output tail. The planner is not woken.
- **After `autoCheckAttempts` failures in a row** (default 2), the planner is woken with the report and a line "Drove's checks failed N times: <command> …". The count restarts; a pass or the planner's own verdict to the seat also clears it.
- **A pass** wakes the planner as usual, with one more line: "Drove ran <commands> at <sha7>: passed (clean|dirty)".

`"autoCheck": false` in either `.drove.json` or `~/.drove/config.json` turns it all off; for `autoCheckAttempts` the repo's value wins.

A report is held until its checks have run: the planner does not see it, nor does `read_reports`, and the seat's later reports wait behind it in order. A seat that is `gone` or `down` has its report released with a line saying the checks were not run.

The run is recorded in `checks.jsonl` like any other, so a merge reuses it when every command of the merge plan has a passing record at the same commit.

## Events

| Event | When |
|---|---|
| `merge.passed`, `merge.refused`, `merge.pending` | each merge outcome; the last one shows on the seat's board line |
| `checks.ran` | each run of the checks |
| `autocheck.passed`, `autocheck.failed` | each auto-check of a done report; each verdict sent counts as a change round in `drove report` |

## Refusal codes

| Code | Meaning |
|---|---|
| `head-moved` | the worktree's HEAD is not the branch tip it would merge |
| `policy-change` | the branch changes `spawnPolicy`; a human must merge it ([spawn policy](lean-workers.md#spawn-policy)) |

## Reviewer and tester seats

Review and testing can be seats of their own. They are optional: the planner reads the diffs itself unless a change is large or risky, touches security, or has logic it cannot easily check.

Spawn one with `--role reviewer|tester --target <seat>` (the spawn tool's and `spawn_worker`'s `role` and `target`). A seat with no `--role` is an implementer. A reviewer or tester takes a pane of the budget like any seat, and the planner closes it once it has reported.

| | `reviewer` | `tester` |
|---|---|---|
| For | reading another seat's diff against that seat's brief | writing and running tests for another seat's change |
| Worktree | its own, at the run base; it reads the target's worktree (`git -C <target worktree> diff <base>`, which holds uncommitted work) and the target's brief, both named in its brief | branched from the head of the target's branch; Claude seats are fast-forwarded to it, Codex seats get a Drove worktree made from it |
| May change | nothing, except scratch files under `/tmp` | only its `--owns`, which defaults to `test/**`, `tests/**`, `**/*.test.*`, `**/*.spec.*` and `**/__tests__/**` |
| Guard | read-only ([guard rules](guard-rules.md#reviewer-seats)) | the same owns guard as an implementer |
| Reports `done` with | `expects: review`: `approve` or `changes`, findings with file:line, most serious first, and the check results | `expects: review`: the tests added, the output, and what they caught |
| Then | the planner gives the verdict to the implementer and closes the reviewer; nothing to commit | the planner approves, it commits, and its branch merges after the target's |

- `--target` is required for both and names another seat of this run; a reviewer cannot be a target.
- A tester's target should have committed first: the spawn result warns when its worktree still holds uncommitted changes.
- `--owns` is refused for a reviewer.
- The role and target live on the seat, so `promote`, a restart, `up` and `migrate` keep them.
- The board shows `R` or `T` beside the seat; `drove roster` says `reviewer of <seat>`. A reviewer or tester gets `DROVE_SEAT_ROLE` in its environment.
- Each role has one role text, the same for every seat of that role, so it caches; the target, its branch, worktree and brief file go in the brief's last line.

A good pairing is a reviewer of the other kind: Codex reviewing a Claude worker's branch, Claude reviewing a Codex worker's, so the review comes from another model ([lean workers](lean-workers.md#claude-or-codex-for-a-worker)).
