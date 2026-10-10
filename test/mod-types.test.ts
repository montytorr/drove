import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const source = new URL('../src/types.ts', import.meta.url)
const copy = new URL('../mod/types/index.d.ts', import.meta.url)

const declarations = (text: string): Map<string, string> => {
  const found = new Map<string, string>()
  for (const block of text.split(/\n(?=export type )/)) {
    const match = /^export type (\w+)/.exec(block.trim())
    if (match?.[1]) found.set(match[1], block.trim().replace(/\s+/g, ' '))
  }
  return found
}

const copied = (text: string): string => {
  const start = text.indexOf('// ---- copied from src/types.ts ----')
  const end = text.indexOf('// ---- end of the copy ----')
  assert.ok(start >= 0 && end > start, 'the mod types file keeps its copy markers')
  return text.slice(start, end).split('\n').slice(1).join('\n')
}

test("the mod's copy of Drove's types matches src/types.ts declaration for declaration", async () => {
  const original = declarations(await readFile(source, 'utf8'))
  const mine = declarations(copied(await readFile(copy, 'utf8')))
  assert.ok(mine.size >= 10, 'the copy holds the run-state types')
  for (const [name, declaration] of mine) assert.equal(declaration, original.get(name), `${name} drifted from src/types.ts`)
})
