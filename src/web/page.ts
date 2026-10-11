import { TONE_COLOR } from '../board.ts'

// The whole page: inline CSS and JS, no build step. Text goes in with textContent only, so a summary can never become markup.

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>drove board</title>
<style>
  :root { color-scheme: dark; --bg: #11111b; --panel: #181825; --line: #313244; --text: #cdd6f4; --muted: #7f849c; --dim: #585b70; --good: #a6e3a1; --alert: #f38ba8; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); }
  body { font: 14px/1.5 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; padding: 16px clamp(12px, 4vw, 32px) 48px; -webkit-text-size-adjust: 100%; }
  main { max-width: 1400px; margin: 0 auto; }
  .bar { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
  .bar .left, .bar .right { display: flex; flex-wrap: wrap; gap: 0 1ch; min-width: 0; }
  .bar .left { flex: 1 1 28ch; }
  .conn { position: fixed; top: 8px; right: 8px; padding: 1px 8px; border-radius: 999px; font-size: 11px; background: var(--panel); border: 1px solid var(--line); color: var(--good); }
  .conn.off { color: var(--alert); border-color: var(--alert); }
  .conn::before { content: "●"; margin-right: 6px; }
  section { margin-top: 14px; }
  .row { display: flex; flex-wrap: wrap; gap: 0 1ch; padding: 1px 0; }
  .cell { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
  .cell.flex { flex: 1 1 24ch; }
  .cell.fixed { flex: 0 0 auto; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
  .b { font-weight: 700; }
  .note { color: var(--muted); padding: 4px 0; }
  .rule { display: flex; align-items: center; gap: 1ch; margin-top: 18px; color: var(--dim); }
  .rule::before, .rule::after { content: ""; flex: 1 1 2ch; border-top: 1px solid var(--line); }
  .rule .t { color: var(--dim); } .rule .r { color: var(--muted); overflow-wrap: anywhere; }
  .feed .row { border-top: 1px solid transparent; }
  @media (max-width: 640px) {
    body { font-size: 13px; }
    .feed .row { padding: 4px 0; border-top-color: var(--line); }
    .feed .row .cell.flex { flex-basis: 100%; padding-left: 2ch; }
  }
</style>
</head>
<body>
<div id="conn" class="conn off">connecting</div>
<main id="board"><div class="note">connecting…</div></main>
<script>
(() => {
  const TONES = __TONES__
  const token = new URLSearchParams(location.search).get('t') || ''
  const q = '?t=' + encodeURIComponent(token)
  const root = document.getElementById('board')
  const conn = document.getElementById('conn')

  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  const cellOf = (cell) => {
    const node = el('span', 'cell ' + (cell.width === undefined ? 'flex' : 'fixed') + (cell.isBold ? ' b' : ''), cell.text)
    node.style.color = TONES[cell.tone] || TONES.text
    if (cell.width !== undefined) node.style.width = cell.width + 'ch'
    return node
  }

  const rowOf = (row) => {
    const node = el('div', 'row')
    for (const cell of row.cells) node.append(cellOf(cell))
    return node
  }

  const render = (data) => {
    const { model, run } = data
    const frag = document.createDocumentFragment()
    const bar = el('div', 'bar')
    const left = el('div', 'left')
    for (const cell of model.title) left.append(cellOf(cell))
    const right = el('div', 'right')
    for (const cell of model.progress) right.append(cellOf(cell))
    bar.append(left, right)
    const seats = el('section')
    seats.append(rowOf(model.lead))
    for (const row of model.workers) seats.append(rowOf(row))
    if (model.empty) seats.append(el('div', 'note', model.empty))
    const rule = el('div', 'rule')
    rule.append(el('span', 't', model.feedTitle), el('span', 'r', run))
    const feed = el('section', 'feed')
    if (model.feed.length === 0) feed.append(el('div', 'note', 'Briefs, reports and verdicts appear here.'))
    for (const row of model.feed) feed.append(rowOf(row))
    frag.append(bar, seats, rule, feed)
    root.replaceChildren(frag)
    const goal = model.title[1] ? model.title[1].text : ''
    document.title = 'drove' + (goal ? ' · ' + goal : '')
  }

  const setConn = (live) => {
    conn.textContent = live ? 'live' : 'disconnected'
    conn.className = 'conn' + (live ? '' : ' off')
  }

  let source
  let retry
  const connect = () => {
    clearTimeout(retry)
    if (source) source.close()
    source = new EventSource('/events' + q)
    source.onmessage = (event) => {
      setConn(true)
      render(JSON.parse(event.data))
    }
    source.onerror = () => {
      setConn(false)
      if (source.readyState === EventSource.CLOSED) retry = setTimeout(connect, 2000)
    }
  }
  connect()
})()
</script>
</body>
</html>
`

export const pageOf = (): string => PAGE.replace('__TONES__', JSON.stringify(TONE_COLOR))
