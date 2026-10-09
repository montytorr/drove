import { appendJsonl, writeJsonAtomic } from '../src/store.ts'

const [mode, path, arg] = process.argv.slice(2)

if (mode === 'append') {
  for (let index = 0; index < 25; index += 1) {
    await appendJsonl(path as string, { worker: arg, index, pad: 'x'.repeat(600) })
  }
} else if (mode === 'write-forever') {
  process.stdout.write('ready\n')
  const big = { marker: 'new', pad: 'y'.repeat(4_000_000) }
  for (;;) await writeJsonAtomic(path as string, big)
}
