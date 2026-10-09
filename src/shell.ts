export type Segment = {
  words: string[]
  stdin: string[]
  stdinFile?: string
  stdoutFile?: string
  substitutions: string[]
}
export type Pipeline = Segment[]
export type Command = { words: string[]; env: Record<string, string> }

type Heredoc = { delim: string; strip: boolean; isQuoted: boolean; seg: Segment }
type Redirect = 'in' | 'out' | 'heredoc' | 'heredoc-strip' | 'herestring' | null
type Parsed = { pipelines: Pipeline[]; end: number }

const SPACE = /[ \t\r]/
const MAX_DEPTH = 8
const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }

const newSegment = (): Segment => ({ words: [], stdin: [], substitutions: [] })

const skipSingleQuoted = (src: string, from: number): number => {
  const end = src.indexOf("'", from + 1)
  return end === -1 ? src.length : end
}

const skipDoubleQuoted = (src: string, from: number): number => {
  let i = from + 1
  while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1
  return Math.min(i, src.length)
}

const backtickEnd = (src: string, from: number): number => {
  let i = from + 1
  while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1
  return Math.min(i, src.length)
}

const skipBalanced = (src: string, open: number): number => {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === "'") i = skipSingleQuoted(src, i)
    else if (c === '"') i = skipDoubleQuoted(src, i)
    else if (c === '\\') i += 1
    else if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return src.length
}

const readBacktick = (src: string, from: number, into: string[]): number => {
  const end = backtickEnd(src, from)
  into.push(src.slice(from + 1, end).replace(/\\([`$\\])/g, '$1'))
  return end
}

const readParen = (src: string, open: number, into: string[]): number => {
  const end = src[open + 1] === '(' ? skipBalanced(src, open) : parseFrom(src, open + 1, true).end
  into.push(src.slice(open + 1, end))
  return end
}

const expansionsIn = (text: string): string[] => {
  const found: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') i += 2
    else if (c === '$' && text[i + 1] === '(') i = readParen(text, i + 1, found) + 1
    else if (c === '`') i = readBacktick(text, i, found) + 1
    else i += 1
  }
  return found
}

const parseFrom = (src: string, start: number, isNested: boolean): Parsed => {
  const pipelines: Pipeline[] = []
  let pipeline: Segment[] = []
  let seg = newSegment()
  let word = ''
  let hasWord = false
  let isWordQuoted = false
  let redirect: Redirect = null
  let heredocs: Heredoc[] = []
  let parenDepth = 0
  let end = src.length
  let i = start

  const pushWord = () => {
    if (!hasWord) return
    if (redirect === 'in') seg.stdinFile = word
    else if (redirect === 'heredoc' || redirect === 'heredoc-strip') heredocs.push({ delim: word, strip: redirect === 'heredoc-strip', isQuoted: isWordQuoted, seg })
    else if (redirect === 'herestring') seg.stdin.push(word)
    else if (redirect === 'out') {
      if (!/^\d+$/.test(word)) seg.stdoutFile ??= word
    } else seg.words.push(word)
    redirect = null
    word = ''
    hasWord = false
    isWordQuoted = false
  }

  const endSegment = () => {
    pushWord()
    const isKept =
      seg.words.length > 0 ||
      seg.stdin.length > 0 ||
      seg.substitutions.length > 0 ||
      seg.stdinFile !== undefined ||
      seg.stdoutFile !== undefined ||
      heredocs.some(doc => doc.seg === seg)
    if (isKept) pipeline.push(seg)
    seg = newSegment()
  }

  const endPipeline = () => {
    endSegment()
    if (pipeline.length > 0) pipelines.push(pipeline)
    pipeline = []
  }

  const readHeredocs = (from: number): number => {
    let pos = from
    for (const doc of heredocs) {
      const body: string[] = []
      while (pos <= src.length) {
        const eol = src.indexOf('\n', pos)
        const line = src.slice(pos, eol === -1 ? src.length : eol)
        pos = eol === -1 ? src.length + 1 : eol + 1
        const probe = doc.strip ? line.replace(/^\t+/, '') : line
        if (probe.trim() === doc.delim) break
        body.push(line)
      }
      const text = body.join('\n')
      doc.seg.stdin.push(text)
      if (!doc.isQuoted) doc.seg.substitutions.push(...expansionsIn(text))
    }
    heredocs = []
    return pos
  }

  const startRedirect = (kind: Redirect) => {
    if (hasWord && /^\d+$/.test(word) && !SPACE.test(src[i - 1] ?? ' ')) {
      word = ''
      hasWord = false
    }
    pushWord()
    redirect = kind
  }

  const startWordWith = (text: string) => {
    word += text
    hasWord = true
  }

  while (i < src.length) {
    const c = src[i] ?? ''
    const next = src[i + 1] ?? ''

    if (c === '\\') {
      isWordQuoted = true
      if (next === '\n') {
        i += 2
        continue
      }
      startWordWith(next)
      i += 2
      continue
    }
    if (c === "'") {
      const close = skipSingleQuoted(src, i)
      isWordQuoted = true
      startWordWith(src.slice(i + 1, close))
      i = close + 1
      continue
    }
    if (c === '$' && next === "'") {
      let j = i + 2
      isWordQuoted = true
      hasWord = true
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
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      isWordQuoted = true
      hasWord = true
      while (j < src.length && src[j] !== '"') {
        const d = src[j]
        if (d === '\\' && '"\\$`\n'.includes(src[j + 1] ?? '')) {
          if (src[j + 1] !== '\n') word += src[j + 1]
          j += 2
          continue
        }
        if (d === '$' && src[j + 1] === '(') {
          const close = readParen(src, j + 1, seg.substitutions)
          word += src.slice(j, close + 1)
          j = close + 1
          continue
        }
        if (d === '`') {
          const close = readBacktick(src, j, seg.substitutions)
          word += src.slice(j, close + 1)
          j = close + 1
          continue
        }
        word += d
        j += 1
      }
      i = j + 1
      continue
    }
    if (c === '$' && next === '(') {
      const close = readParen(src, i + 1, seg.substitutions)
      startWordWith(src.slice(i, close + 1))
      i = close + 1
      continue
    }
    if ((c === '<' || c === '>') && next === '(') {
      const close = readParen(src, i + 1, seg.substitutions)
      startWordWith(src.slice(i, close + 1))
      i = close + 1
      continue
    }
    if (c === '`') {
      const close = readBacktick(src, i, seg.substitutions)
      startWordWith(src.slice(i, close + 1))
      i = close + 1
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
      i = heredocs.length > 0 ? readHeredocs(i + 1) : i + 1
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
    if (c === '(') {
      endPipeline()
      parenDepth += 1
      i += 1
      continue
    }
    if (c === ')') {
      if (isNested && parenDepth === 0) {
        end = i
        break
      }
      endPipeline()
      if (parenDepth > 0) parenDepth -= 1
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
    startWordWith(c)
    i += 1
  }
  endPipeline()
  if (heredocs.length > 0) readHeredocs(src.length)
  return { pipelines, end }
}

export const parseShell = (src: string): Pipeline[] => parseFrom(src, 0, false).pipelines

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

export const baseName = (word: string): string => word.split('/').pop() ?? word

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
    const base = baseName(head)
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
    if (base === 'xargs') {
      words = words.slice(skipOptions(words, 1, 'IJLnPsdEa', ['--max-args', '--max-procs', '--max-lines', '--delimiter', '--arg-file', '--eof', '--max-chars']))
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
