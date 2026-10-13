import { readFile, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Exec } from './types.ts'

// DROVE-147, DROVE-156: Claude Code 2.1.296 shows its folder-trust prompt unless `projects[<dir>].hasTrustDialogAccepted`
// is true in ~/.claude.json for the canonical git root, or for a directory from the cwd up to the cwd's own git root; the
// walk stops at the git root, so a trusted folder above the repo does not count. Drove launches Claude at the canonical
// root, so only that exact entry counts. Drove only reads that file.

export type RepoTrust = { state: 'trusted' | 'untrusted' | 'unknown'; root: string; file: string }

type ClaudeConfig = { projects?: Record<string, { hasTrustDialogAccepted?: unknown } | undefined> }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// The main checkout of the repo, as Claude keys it: a linked worktree is trusted through its main repo.
export const canonicalRoot = async (exec: Exec, repo: string): Promise<string> => {
  const common = await exec(['git', '-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 10_000 }).catch(() => undefined)
  const gitDir = common?.code === 0 ? common.stdout.trim() : ''
  const dir = gitDir ? dirname(gitDir) : resolve(repo)
  return realpath(dir).catch(() => dir)
}

// A file Drove cannot read, or one without a projects map, says nothing: the start-time prompt check still covers it.
export const readRepoTrust = async (file: string, root: string): Promise<RepoTrust> => {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  let parsed: unknown
  try {
    parsed = text === undefined ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const projects = isRecord(parsed) ? (parsed as ClaudeConfig).projects : undefined
  if (!isRecord(projects)) return { state: 'unknown', root, file }
  return { state: projects[root]?.hasTrustDialogAccepted === true ? 'trusted' : 'untrusted', root, file }
}

export const trustFix = (root: string): string =>
  `run \`claude\` once in ${root}, accept its folder-trust prompt, then quit it`

export const untrustedText = (trust: RepoTrust): string =>
  `Claude Code has not trusted ${trust.root} (projects["${trust.root}"].hasTrustDialogAccepted is not true in ${trust.file}), so a Claude worker launched there stops at the folder-trust prompt. One-time fix: ${trustFix(trust.root)}. Drove never writes that file. A Codex worker (--kind codex) is unaffected.`

export const trustAttentionText = (root: string, paneId: string | undefined): string =>
  `Claude Code has not trusted ${root}: its folder-trust prompt is waiting in ${paneId ? `pane ${paneId}` : 'the pane'}. Accept it in the pane, or ${trustFix(root)}. Drove holds the brief and delivers it once the prompt clears and the worktree is there.`
