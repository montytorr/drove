export type Segment = { words: string[]; stdin: string[]; stdinFile?: string; stdoutFile?: string }
export type Pipeline = Segment[]

type Heredoc = { delim: string; strip: boolean; seg: Segment }
type Redirect = 'in' | 'out' | 'heredoc' | 'heredoc-strip' | 'herestring' | null

const SPACE = /[ \t\r]/
const MAX_DEPTH = 8

const newSegment = (): Segment => ({ words: [], stdin: [] })

const skipQuoted = (src: string, from: number, quote: string): number => {
  let i = from + 1
  while (i < src.length && src[i] !== quote) {
    i += quote === '"' && src[i] === '\\' ? 2 : 1
  }
  return i
}

const readSubstitution = (src: string, from: number): number => {
  let depth = 0
  let i = from + 1
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(src, i, c) + 1
      continue
    }
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '(') depth += 1
    if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return src.length - 1
}

const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }

export const parseShell = (src: string): Pipeline[] => {
  const pipelines: Pipeline[] = []
  let pipeline: Segment[] = []
  let seg = newSegment()
  let word = ''
  let hasWord = false
  let redirect: Redirect = null
  let heredocs: Heredoc[] = []
  let i = 0

  const pushWord = () => {
    if (!hasWord) return
    if (redirect === 'in') seg.stdinFile = word
    else if (redirect === 'heredoc' || redirect === 'heredoc-strip') heredocs.push({ delim: word, strip: redirect === 'heredoc-strip', seg })
    else if (redirect === 'herestring') seg.stdin.push(word)
    else if (redirect === 'out') {
      if (!/^\d+$/.test(word)) seg.stdoutFile ??= word
    }
    else seg.words.push(word)
    redirect = null
    word = ''
    hasWord = false
  }

  const endSegment = () => {
    pushWord()
    if (seg.words.length > 0 || seg.stdin.length > 0 || seg.stdinFile !== undefined) pipeline.push(seg)
    seg = newSegment()
  }

  const endPipeline = () => {
    endSegment()
    if (pipeline.length > 0) pipelines.push(pipeline)
    pipeline = []
  }

  const readHeredocs = () => {
    let pos = i + 1
    for (const doc of heredocs) {
      const body: string[] = []
      while (pos <= src.length) {
        const end = src.indexOf('\n', pos)
        const line = src.slice(pos, end === -1 ? src.length : end)
        pos = end === -1 ? src.length + 1 : end + 1
        const probe = doc.strip ? line.replace(/^\t+/, '') : line
        if (probe.trim() === doc.delim) break
        body.push(line)
      }
      doc.seg.stdin.push(body.join('\n'))
    }
    heredocs = []
    i = pos - 1
  }

  const startRedirect = (kind: Redirect) => {
    if (hasWord && /^\d+$/.test(word) && !SPACE.test(src[i - 1] ?? ' ')) {
      word = ''
      hasWord = false
    }
    pushWord()
    redirect = kind
  }

  while (i < src.length) {
    const c = src[i] ?? ''
    const next = src[i + 1] ?? ''

    if (c === '\\') {
      if (next === '\n') {
        i += 2
        continue
      }
      word += next
      hasWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = skipQuoted(src, i, "'")
      word += src.slice(i + 1, end)
      hasWord = true
      i = end + 1
      continue
    }
    if (c === '$' && next === "'") {
      let j = i + 2
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) {
          const escaped = src[j + 1] ?? ''
          word += ANSI_ESCAPES[escaped] ?? `\\${escaped}`
          j += 2
          continue
        }
        word += src[j]
        j += 1
      }
      hasWord = true
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        const d = src[j]
        if (d === '\\' && '"\\$`\n'.includes(src[j + 1] ?? '')) {
          if (src[j + 1] !== '\n') word += src[j + 1]
          j += 2
          continue
        }
        if (d === '$' && src[j + 1] === '(') {
          const end = readSubstitution(src, j)
          word += src.slice(j, end + 1)
          j = end + 1
          continue
        }
        if (d === '`') {
          const end = skipQuoted(src, j, '`')
          word += src.slice(j, end + 1)
          j = end + 1
          continue
        }
        word += d
        j += 1
      }
      hasWord = true
      i = j + 1
      continue
    }
    if ((c === '$' || c === '<' || c === '>') && next === '(') {
      const end = readSubstitution(src, i)
      word += src.slice(i, end + 1)
      hasWord = true
      i = end + 1
      continue
    }
    if (c === '`') {
      const end = skipQuoted(src, i, '`')
      word += src.slice(i, end + 1)
      hasWord = true
      i = end + 1
      continue
    }
    if (c === '#' && !hasWord) {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (SPACE.test(c)) {
      pushWord()
      i += 1
      continue
    }
    if (c === '\n') {
      endPipeline()
      if (heredocs.length > 0) readHeredocs()
      i += 1
      continue
    }
    if (c === ';') {
      endPipeline()
      i += next === ';' ? 2 : 1
      continue
    }
    if (c === '|') {
      if (next === '|') {
        endPipeline()
        i += 2
        continue
      }
      endSegment()
      i += next === '&' ? 2 : 1
      continue
    }
    if (c === '&') {
      if (next === '&') {
        endPipeline()
        i += 2
        continue
      }
      if (next === '>') {
        startRedirect('out')
        i += src[i + 2] === '>' ? 3 : 2
        continue
      }
      endPipeline()
      i += 1
      continue
    }
    if (c === '(' || c === ')') {
      endPipeline()
      i += 1
      continue
    }
    if (c === '<') {
      if (src.startsWith('<<<', i)) {
        startRedirect('herestring')
        i += 3
        continue
      }
      if (src.startsWith('<<-', i)) {
        startRedirect('heredoc-strip')
        i += 3
        continue
      }
      if (next === '<') {
        startRedirect('heredoc')
        i += 2
        continue
      }
      startRedirect(next === '&' || next === '>' ? 'out' : 'in')
      i += next === '&' || next === '>' ? 2 : 1
      continue
    }
    if (c === '>') {
      startRedirect('out')
      i += next === '>' || next === '&' || next === '|' ? 2 : 1
      continue
    }
    word += c
    hasWord = true
    i += 1
  }
  endPipeline()
  if (heredocs.length > 0) {
    i = src.length - 1
    readHeredocs()
  }
  return pipelines
}

export const segmentText = (seg: Segment): string => [...seg.words, ...seg.stdin].join(' ')

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time', 'exec', 'command', 'builtin', 'nohup', 'caffeinate', 'unbuffer'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const skipOptions = (words: string[], from: number, withValue: string, longWithValue: readonly string[] = []): number => {
  let i = from
  while (i < words.length) {
    const w = words[i] ?? ''
    if (w === '--') return i + 1
    if (!w.startsWith('-') || w === '-') return i
    if (w.startsWith('--')) {
      i += longWithValue.includes(w) ? 2 : 1
      continue
    }
    const last = w[w.length - 1] ?? ''
    i += w.length === 2 && withValue.includes(last) ? 2 : 1
  }
  return i
}

export type Command = { words: string[]; env: Record<string, string> }

export const unwrap = (input: readonly string[]): Command => {
  let words = [...input]
  const env: Record<string, string> = {}
  for (let guard = 0; guard < MAX_DEPTH * 4 && words.length > 0; guard += 1) {
    const head = words[0] ?? ''
    if (ASSIGNMENT.test(head)) {
      const eq = head.indexOf('=')
      env[head.slice(0, eq)] = head.slice(eq + 1)
      words = words.slice(1)
      continue
    }
    if (KEYWORDS.has(head)) {
      words = words.slice(head === 'time' && words[1] === '-p' ? 2 : 1)
      continue
    }
    const base = head.split('/').pop() ?? head
    if (base === 'sudo' || base === 'doas') {
      words = words.slice(skipOptions(words, 1, 'ugpChDrtUT', ['--user', '--group', '--prompt', '--host', '--chdir']))
      continue
    }
    if (base === 'env') {
      words = words.slice(skipOptions(words, 1, 'uSC', ['--unset', '--chdir', '--split-string']))
      continue
    }
    if (base === 'timeout' || base === 'gtimeout') {
      const at = skipOptions(words, 1, 'sk', ['--signal', '--kill-after'])
      words = words.slice(at + 1)
      continue
    }
    if (base === 'nice' || base === 'ionice' || base === 'stdbuf') {
      words = words.slice(skipOptions(words, 1, 'ncpioe'))
      continue
    }
    if (base === 'watch') {
      words = words.slice(skipOptions(words, 1, 'ng', ['--interval']))
      if (words.length === 1) words = parseShell(words[0] ?? '')[0]?.[0]?.words ?? []
      continue
    }
    break
  }
  return { words, env }
}

export const baseName = (word: string): string => word.split('/').pop() ?? word
