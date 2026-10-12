import { HUMAN } from '../../mod/hooks/protocol.ts'
import { TONE_COLOR } from '../board.ts'

// The whole page: inline CSS and JS, no build step. Text goes in with textContent only, so a summary can never become markup.
// Colours take their value from --tone-* variables: the dark hues come from TONE_COLOR, the light ones are darkened below so they stay readable.
// The page script is a String.raw template: it uses no template literals and no dollar-brace, only string concatenation.

// What the feed chips match on: the structured `kind` of a timeline entry. A test pins these against the kinds the feed really holds.
export const NEEDS_YOU_KINDS: readonly string[] = ['question', 'asking', 'blocked', 'gone', 'failed', 'attention', 'promote']
export const REPORT_KINDS: readonly string[] = ['done', 'question', 'blocked', 'promote', 'progress']

// Message colours in the graph and the timeline: reports green, questions and blocked amber, verdicts violet, briefs blue.
export const KIND_TONES: Readonly<Record<string, string>> = {
  done: 'good',
  answered: 'good',
  question: 'warn',
  asking: 'warn',
  blocked: 'warn',
  attention: 'warn',
  notice: 'muted',
  promote: 'you',
  demote: 'you',
  queued: 'you',
  verdict: 'lead',
  brief: 'working',
  message: 'working',
  nudge: 'muted',
  progress: 'muted',
  hello: 'muted',
  relaunch: 'muted',
  close: 'dim',
  gone: 'alert',
  failed: 'alert',
}

export const KIND_ICONS: Readonly<Record<string, string>> = {
  brief: '➤',
  done: '✓',
  verdict: '✎',
  question: '?',
  asking: '?',
  answered: '↩',
  promote: '⇡',
  demote: '⇣',
  blocked: '⛔',
  progress: '·',
  hello: '⏵',
  message: '✉',
  nudge: '⟳',
  close: '⏻',
  gone: '✕',
  queued: '⏸',
  failed: '✕',
  attention: '⚠',
  notice: '·',
}

// Who the page draws as the lead node when it shows up in a feed entry's from or to, besides the seats' own names.
export const LEAD_NAMES: readonly string[] = ['⌘', 'lead', 'planner']

// HH:MM of an epoch-millisecond time in a timezone offset (minutes, as Date.getTimezoneOffset). Plain JS: the page runs this text as it is, and a test evaluates it.
export const CLOCK_SOURCE = `(at, offsetMinutes) => {
  const local = new Date(at - offsetMinutes * 60000)
  return String(local.getUTCHours()).padStart(2, '0') + ':' + String(local.getUTCMinutes()).padStart(2, '0')
}`

// Where the graph's boxes go: (seat count, card width) → { height, lead, seats, routes } in px, boxes as centre x, y and size w, h.
// Plain JS like CLOCK_SOURCE: the page runs this text as it is, and a test evaluates it.
export const LAYOUT_SOURCE = `(() => {
  const LEAD_W = 190
  const LEAD_H = 78
  const SEAT_H = 88
  const NODE_GAP = 12
  const PAD = 28
  const MIN_HEIGHT = 160
  const SEAT_WIDTHS = [220, 200, 180, 164]
  const EDGE_GAPS = [200, 140, 100, 70, 40]

  // The shortest distance between two boxes, as the edge between them is long.
  const distance = (a, b) => Math.hypot(Math.max(0, Math.abs(a.x - b.x) - (a.w + b.w) / 2), Math.max(0, Math.abs(a.y - b.y) - (a.h + b.h) / 2))

  // The lead in the middle with the seats on an ellipse round it, as high as the seats need and no higher, and the longest edges that fit (200 px down to 40);
  // one seat sits beside the lead; when nothing fits, the lead on top and the seats in rows below.
  const layoutOf = (count, width) => {
    const direct = (lead, seats, height) => ({ height, lead, seats, routes: seats.map((seat) => [[lead.x, lead.y], [seat.x, seat.y]]) })
    if (count === 0) return direct({ x: width / 2, y: MIN_HEIGHT / 2, w: LEAD_W, h: LEAD_H }, [], MIN_HEIGHT)
    if (count === 1) {
      for (const seatW of SEAT_WIDTHS) {
        const gap = Math.min(220, width - 2 * 10 - LEAD_W - seatW)
        if (gap < 90) continue
        const left = (width - (LEAD_W + gap + seatW)) / 2
        const lead = { x: left + LEAD_W / 2, y: MIN_HEIGHT / 2, w: LEAD_W, h: LEAD_H }
        return direct(lead, [{ x: left + LEAD_W + gap + seatW / 2, y: MIN_HEIGHT / 2, w: seatW, h: SEAT_H }], MIN_HEIGHT)
      }
    } else {
      const top = count <= 4 ? 480 : 620
      for (const gap of EDGE_GAPS) {
        for (const seatW of SEAT_WIDTHS) {
          for (let height = MIN_HEIGHT + 40; height <= top; height += 20) {
            const cx = width / 2
            const cy = height / 2
            const rx = width / 2 - seatW / 2 - 10
            const ry = height / 2 - SEAT_H / 2 - PAD
            if (rx <= 0 || ry <= 0) continue
            const lead = { x: cx, y: cy, w: LEAD_W, h: LEAD_H }
            const seats = []
            for (let at = 0; at < count; at += 1) {
              const angle = ((-90 + ((at + 0.5) * 360) / count) * Math.PI) / 180
              seats.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle), w: seatW, h: SEAT_H })
            }
            const isClear = seats.every((seat, at) => distance(lead, seat) >= gap && seats.slice(at + 1).every((other) => distance(seat, other) >= NODE_GAP))
            if (isClear) return direct(lead, seats, height)
          }
        }
      }
    }
    const gutter = 20
    const cols = Math.max(1, Math.min(count, Math.floor((width - gutter + NODE_GAP) / (160 + NODE_GAP))))
    const w = Math.max(120, Math.min(280, Math.floor((width - gutter - (cols - 1) * NODE_GAP) / cols)))
    const lead = { x: width / 2, y: 14 + LEAD_H / 2, w: Math.min(LEAD_W, width - 8), h: LEAD_H }
    const leadBottom = lead.y + LEAD_H / 2
    const firstTop = leadBottom + (count <= 2 ? 90 : 44)
    const rows = Math.ceil(count / cols)
    const origin = rows > 1 ? gutter : 0
    const seats = []
    const routes = []
    for (let at = 0; at < count; at += 1) {
      const row = Math.floor(at / cols)
      const inRow = Math.min(cols, count - row * cols)
      const total = inRow * w + (inRow - 1) * NODE_GAP
      const x = origin + (width - origin - total) / 2 + (at % cols) * (w + NODE_GAP) + w / 2
      const top = firstTop + row * (SEAT_H + 36)
      const bus = top - 18
      seats.push({ x, y: top + SEAT_H / 2, w, h: SEAT_H })
      routes.push(row === 0
        ? [[lead.x, leadBottom], [lead.x, bus], [x, bus], [x, top]]
        : [[lead.x, leadBottom], [lead.x, firstTop - 18], [8, firstTop - 18], [8, bus], [x, bus], [x, top]])
    }
    return { height: firstTop + (rows - 1) * (SEAT_H + 36) + SEAT_H + 14, lead, seats, routes }
  }
  return layoutOf
})()`

// What the seat panel computes, apart from the DOM: the seat's thread (entries to or from it, newest first), the `kind · model · effort` line with a model
// that is never blank, a short session id, and the pane text after a read, which keeps the last good text marked stale when a read fails.
// Plain JS like LAYOUT_SOURCE, in String.raw so its regexes keep their backslashes: the page runs this text as it is, and a test evaluates it.
export const PANEL_SOURCE = String.raw`(() => {
  const THREAD_SIZE = 6
  const threadOf = (feed, name, size) => feed.filter((entry) => entry.from === name || entry.to === name).slice(-(size || THREAD_SIZE)).reverse()
  const specOf = (seat) => [seat.kind, seat.model || seat.modelLabel || 'default', seat.effort].filter(Boolean).join(' · ')
  const shortId = (id) => (id && id.length > 12 ? id.slice(0, 8) + '…' : id || '')
  const tailAfter = (prev, read, now) => {
    if (read.ok) {
      const text = read.text.replace(/\s+$/, '')
      return { text: text.trim() ? text : '(the pane is empty)', readAt: now, stale: false, reason: '' }
    }
    if (read.status === 404) return { text: 'this seat is closed', readAt: 0, stale: false, reason: '' }
    const reason = (read.text || '').trim() || 'could not read the pane'
    if (prev.readAt) return { text: prev.text, readAt: prev.readAt, stale: true, reason }
    return { text: reason, readAt: 0, stale: false, reason }
  }
  return { threadOf, specOf, shortId, tailAfter }
})()`

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>drove board</title>
<style>
  :root { color-scheme: dark light; --bg: #11111b; --panel: #181825; --line: #313244; --text: #cdd6f4; --muted: #7f849c; --dim: #585b70; --good: #a6e3a1; --alert: #f38ba8; --hover: #1e1e2e;
    --grid: rgba(127, 132, 156, 0.16); --shadow: rgba(0, 0, 0, 0.28);
    __TONE_VARS__ }
  @media (prefers-color-scheme: light) {
    :root { --bg: #eff1f5; --panel: #ffffff; --line: #ccd0da; --text: #4c4f69; --muted: #6c6f85; --dim: #7c7f93; --good: #2f7d1f; --alert: #c4143a; --hover: #e6e9ef;
      --grid: rgba(108, 111, 133, 0.18); --shadow: rgba(76, 79, 105, 0.16);
      --tone-lead: #8839ef; --tone-working: #1e66f5; --tone-good: #2f7d1f; --tone-warn: #8a5a00; --tone-alert: #c4143a; --tone-muted: #6c6f85; --tone-dim: #7c7f93; --tone-text: #4c4f69; --tone-you: #b45309; }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; background: var(--bg); color: var(--text); }
  body { font: 14px/1.5 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; padding: 16px clamp(12px, 4vw, 32px) 48px; -webkit-text-size-adjust: 100%; }
  main { max-width: 1500px; margin: 0 auto; }
  .bar { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: baseline; gap: 4px 20px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
  .bar .goal { min-width: 0; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar .right { display: flex; gap: 0 1ch; white-space: nowrap; }
  .conn { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 1.5; white-space: nowrap; background: var(--panel); border: 1px solid var(--line); color: var(--good); }
  .conn.off { color: var(--alert); border-color: var(--alert); }
  .conn::before { content: "●"; margin-right: 6px; }
  .row { display: flex; flex-wrap: wrap; gap: 0 1ch; padding: 1px 0; }
  .cell { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
  .cell.flex { flex: 1 1 24ch; }
  .cell.fixed { flex: 0 0 auto; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
  .b { font-weight: 700; }
  .note { color: var(--muted); padding: 4px 0; }
  .tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px; margin-top: 12px; }
  .runid { color: var(--dim); font-size: 12px; overflow-wrap: anywhere; }
  .tools .end { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 12px; min-width: 0; }
  .seg { display: inline-flex; padding: 2px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
  .segbtn { font: inherit; font-size: 12px; padding: 2px 14px; border: 0; border-radius: 999px; background: transparent; color: var(--muted); cursor: pointer; }
  .segbtn[aria-pressed="true"] { background: var(--line); color: var(--text); }
  .segbtn:focus-visible { outline: 1px solid var(--muted); }
  .stage { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin-top: 12px; align-items: start; }
  .stage > * { min-width: 0; }
  @media (min-width: 1100px) { .stage.view-graph { grid-template-columns: minmax(0, 1.2fr) minmax(460px, 1fr); } }
  .seats { margin-top: 2px; }
  .seat { cursor: pointer; border-radius: 3px; }
  .seat:hover, .seat:focus-visible { background: var(--hover); outline: none; }
  .seat.open { background: var(--hover); }
  .detail { --c: var(--tone-muted); margin: 6px 0 10px; padding: 10px 14px 12px; background: var(--panel); border: 1px solid var(--line); border-top: 2px solid var(--c); border-radius: 12px; }
  .slot .detail { margin: 12px 0 0; box-shadow: 0 6px 18px var(--shadow); scroll-margin: 12px; }
  .dhead { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; }
  .dhead .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--c); flex: none; }
  .dhead .dname { font-size: 15px; font-weight: 700; overflow-wrap: anywhere; }
  .dhead .dref { color: var(--dim); }
  .dhead .dstate { color: var(--c); font-size: 12px; }
  .dhead .dbadge { padding: 0 8px; font-size: 10px; font-weight: 700; line-height: 17px; color: var(--bg); background: var(--tone-alert); border-radius: 999px; }
  .dhead .x { margin-left: auto; width: 28px; height: 28px; padding: 0; font: inherit; font-size: 18px; line-height: 1; color: var(--muted); background: transparent; border: 1px solid transparent; border-radius: 8px; cursor: pointer; }
  .dhead .x:hover, .dhead .x:focus-visible { color: var(--text); border-color: var(--line); outline: none; }
  .dspec { color: var(--muted); font-size: 12px; }
  .dact { margin-top: 6px; overflow-wrap: anywhere; }
  .downes { margin-top: 2px; color: var(--tone-warn); font-size: 12px; }
  .detail dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 2ch; margin: 8px 0 0; font-size: 12px; }
  .detail dt { color: var(--muted); }
  .detail dd { display: flex; align-items: baseline; gap: 1ch; min-width: 0; margin: 0; }
  .detail dd .v { min-width: 0; overflow-wrap: anywhere; user-select: all; }
  .copy { flex: none; font: inherit; font-size: 11px; padding: 0 8px; color: var(--muted); background: transparent; border: 1px solid var(--line); border-radius: 999px; cursor: pointer; }
  .copy:hover, .copy:focus-visible { color: var(--text); border-color: var(--muted); outline: none; }
  .detail .rule { margin-top: 12px; font-size: 12px; }
  .detail .rule::before { flex: 0 0 1ch; }
  .report { margin: 6px 0 4px; padding: 6px 10px; background: var(--bg); border-left: 2px solid var(--rc, var(--line)); border-radius: 0 6px 6px 0; }
  .report .meta { color: var(--muted); font-size: 12px; }
  .report .body { white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }
  .thread .note { padding: 2px 6px; font-size: 12px; }
  .pane summary { cursor: pointer; list-style: none; }
  .pane summary::-webkit-details-marker { display: none; }
  .pane summary:focus-visible { outline: 1px solid var(--muted); border-radius: 4px; }
  .pane .lbl::before { content: "▸ "; }
  .pane[open] .lbl::before { content: "▾ "; }
  .pane .stale { color: var(--tone-warn); }
  .detail pre { margin: 8px 0 0; padding: 8px; max-height: 292px; overflow: auto; line-height: 1.4; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 12px; }

  .graph { position: relative; overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: radial-gradient(var(--grid) 1px, transparent 1.5px) 0 0 / 22px 22px, var(--bg); }
  .graph::before { content: ""; position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 70px 6px var(--bg); }
  .links { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
  .edge { fill: none; stroke: var(--dim); stroke-width: 1.5; stroke-linejoin: round; opacity: 0.55; transition: stroke 0.3s, stroke-width 0.3s, opacity 0.3s; }
  .edge.hit { stroke-width: 3; opacity: 1; }
  .flight text { font-size: 11px; font-weight: 700; text-anchor: middle; paint-order: stroke; stroke: var(--bg); stroke-width: 3px; stroke-linejoin: round; }
  .node { position: absolute; display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 9px 12px 10px; text-align: left; font: inherit; font-size: 12px; line-height: 1.35; color: var(--text);
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 6px 18px var(--shadow); --c: var(--tone-muted); }
  .node::before { content: ""; position: absolute; left: 14px; right: 14px; top: -1px; height: 2px; border-radius: 2px; background: var(--c); opacity: 0.85; }
  button.node { cursor: pointer; }
  button.node:hover, button.node:focus-visible, .node.sel { border-color: var(--c); outline: none; }
  .node.sel { box-shadow: 0 0 0 1px var(--c), 0 6px 18px var(--shadow); }
  .node .top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .node .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex: none; }
  .node .name { font-size: 13px; font-weight: 700; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .node .badge { position: absolute; top: -9px; right: 12px; padding: 0 8px; font-size: 10px; font-weight: 700; line-height: 17px; color: var(--bg); background: var(--tone-alert); border-radius: 999px; }
  .node .sub { display: flex; flex-wrap: wrap; column-gap: 6px; min-width: 0; height: 1.35em; font-size: 11px; color: var(--muted); overflow: hidden; }
  .node .sub .m { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .node .sub .k { color: var(--dim); white-space: nowrap; }
  .node .ref { flex: none; margin-left: auto; color: var(--dim); }
  .node .act { min-height: 1.35em; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .node.working::after { content: ""; position: absolute; inset: -1px; border: 2px solid var(--c); border-radius: inherit; opacity: 0; pointer-events: none; animation: pulse 2.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 0; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.03); } }
  .node.recv { animation: recv 0.9s ease-out; }
  @keyframes recv { from { box-shadow: 0 0 0 0 var(--hit); } to { box-shadow: 0 0 0 14px transparent; } }
  @media (prefers-reduced-motion: reduce) {
    .node.working::after { animation: none; opacity: 0.35; }
    .node.recv { animation: none; }
    .edge { transition: none; }
  }

  .timeline { min-width: 0; }
  .rule { display: flex; align-items: center; gap: 1ch; color: var(--dim); }
  .rule::before, .rule::after { content: ""; flex: 1 1 2ch; border-top: 1px solid var(--line); }
  .rule .r { color: var(--muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .chip { font: inherit; font-size: 12px; padding: 1px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); cursor: pointer; }
  .chip[aria-pressed="true"] { color: var(--text); border-color: var(--muted); }
  .chip .n { color: var(--dim); margin-left: 4px; }
  @media (min-width: 1100px) { .stage.view-graph .entries { max-height: calc(100vh - 210px); overflow: auto; } }
  .line { display: grid; grid-template-columns: 5ch 2ch minmax(8ch, 16ch) 9ch minmax(0, 1fr); gap: 0 1ch; align-items: baseline; padding: 2px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
  .line > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .line:hover, .line:focus-visible { background: var(--hover); outline: none; }
  .line .t { color: var(--dim); overflow: visible; }
  .line .i { text-align: center; }
  .line .s::before { content: "▸ "; color: var(--dim); }
  .line[aria-expanded="true"] .s::before { content: "▾ "; }
  .line .a { color: var(--dim); }
  .more { margin: 0 0 6px 6px; padding: 6px 10px; border-left: 2px solid var(--line); }
  .more .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .more .body { margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
  @media (max-width: 700px) {
    .bar { grid-template-columns: minmax(0, 1fr) auto; }
    .bar .goal { grid-column: 1 / -1; order: 3; text-align: left; white-space: normal; }
  }
  @media (max-width: 640px) {
    body { font-size: 13px; }
    .line { grid-template-columns: 5ch 2ch 9ch minmax(0, 1fr); }
    .line .p { display: none; }
  }
</style>
</head>
<body>
<div id="conn" class="conn off">connecting</div>
<main id="board"><div class="note">connecting…</div></main>
<script>
(() => {
  const TONES = __TONES__
  const NEEDS_YOU = __NEEDS_YOU__
  const REPORTS = __REPORTS__
  const KIND_TONE = __KIND_TONES__
  const KIND_ICON = __KIND_ICONS__
  const LEAD_NAMES = __LEAD_NAMES__
  const HUMAN = __HUMAN__
  const clockText = __CLOCK__
  const FILTERS = [['needs', 'needs you', NEEDS_YOU], ['reports', 'reports', REPORTS], ['all', 'all', null]]
  const VIEWS = [['graph', 'Graph'], ['board', 'Board']]
  const VIEW_KEY = 'drove.board.view'
  const PANE_KEY = 'drove.board.pane'
  const panelKit = __PANEL__
  const TAIL_MS = 4000
  const FLIGHT_MS = 1300
  const FLIGHT_GAP_MS = 220
  const MAX_FLIGHTS = 6
  const SVG_NS = 'http://www.w3.org/2000/svg'
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

  const svgEl = (tag, className) => {
    const node = document.createElementNS(SVG_NS, tag)
    if (className) node.setAttribute('class', className)
    return node
  }

  const toneColor = (tone) => TONES[tone] || TONES.text

  const cellOf = (cell) => {
    const node = el('span', 'cell ' + (cell.width === undefined ? 'flex' : 'fixed') + (cell.isBold ? ' b' : ''), cell.text)
    node.style.color = toneColor(cell.tone)
    if (cell.width !== undefined) node.style.width = cell.width + 'ch'
    return node
  }

  const rowOf = (row) => {
    const node = el('div', 'row')
    for (const cell of row.cells) node.append(cellOf(cell))
    return node
  }

  const onActivate = (node, handler) => {
    node.addEventListener('click', handler)
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        handler()
      }
    })
  }

  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const readView = () => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'graph'
    } catch (error) {
      return 'graph'
    }
  }

  const saveView = (value) => {
    try {
      localStorage.setItem(VIEW_KEY, value)
    } catch (error) {
      // a browser that will not store it just shows the default next time
    }
  }

  const readPaneOpen = () => {
    try {
      return localStorage.getItem(PANE_KEY) !== 'closed'
    } catch (error) {
      return true
    }
  }

  const savePaneOpen = (isOpen) => {
    try {
      localStorage.setItem(PANE_KEY, isOpen ? 'open' : 'closed')
    } catch (error) {
      // a browser that will not store it opens the pane next time
    }
  }

  const FIRST_TAIL = { text: 'reading the pane…', readAt: 0, stale: false, reason: '' }

  let data
  let view = readView()
  let openSeat = ''
  let tail = FIRST_TAIL
  let tailTimer
  let tailBusy = false
  let filter = 'all'
  let panel

  // ---------- seat detail ----------

  const fetchTail = async () => {
    if (!openSeat || tailBusy) return
    const name = openSeat
    tailBusy = true
    let read
    try {
      const res = await fetch('/api/seat/' + encodeURIComponent(name) + '/tail' + q, { cache: 'no-store' })
      read = { ok: res.ok, status: res.status, text: await res.text() }
    } catch (error) {
      read = { ok: false, status: 0, text: '' }
    } finally {
      tailBusy = false
    }
    if (name !== openSeat) return
    tail = panelKit.tailAfter(tail, read, Date.now())
    if (panel) paintTail(panel)
  }

  // The pane text follows its newest lines unless the reader has scrolled up in it.
  const settle = (target) => {
    if (!target || target.pre.clientHeight === 0) return
    target.pre.scrollTop = target.stick ? target.pre.scrollHeight : target.top
  }

  const closePanel = () => {
    openSeat = ''
    clearInterval(tailTimer)
    tailTimer = undefined
    panel = undefined
  }

  const toggleSeat = (name) => {
    if (openSeat === name) {
      closePanel()
    } else {
      closePanel()
      openSeat = name
      tail = FIRST_TAIL
      tailTimer = setInterval(fetchTail, TAIL_MS)
      fetchTail()
    }
    if (data) render(data)
    if (openSeat && panel && panel.root.isConnected) panel.root.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' })
  }

  // Close from the × or Esc; focus goes back to the seat's node when it was inside the panel.
  const dismiss = () => {
    const name = openSeat
    const wasInside = !!panel && panel.root.contains(document.activeElement)
    closePanel()
    if (data) render(data)
    if (wasInside && shell) shell.graph.focus(name)
  }

  const ageOf = (iso) => {
    const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
    if (!Number.isFinite(secs)) return '?'
    if (secs < 90) return secs + 's'
    if (secs < 5400) return Math.round(secs / 60) + 'm'
    if (secs < 172800) return Math.round(secs / 3600) + 'h'
    return Math.round(secs / 86400) + 'd'
  }

  const copyButton = (label, textOf) => {
    const button = el('button', 'copy', 'copy')
    button.type = 'button'
    button.setAttribute('aria-label', 'copy the ' + label)
    button.addEventListener('click', async () => {
      let isCopied = false
      try {
        await navigator.clipboard.writeText(textOf())
        isCopied = true
      } catch (error) {
        isCopied = false
      }
      button.textContent = isCopied ? 'copied' : 'select it'
      setTimeout(() => {
        button.textContent = 'copy'
      }, 1400)
    })
    return button
  }

  // A dt/dd pair that hides itself while empty; a copied field copies its whole value, which may be longer than the text shown.
  const fieldOf = (list, label, canCopy) => {
    const dt = el('dt', '', label)
    const dd = el('dd')
    const value = el('span', 'v')
    let whole = ''
    dd.append(value)
    if (canCopy) dd.append(copyButton(label, () => whole))
    list.append(dt, dd)
    return (text, full) => {
      whole = full === undefined ? text : full
      value.textContent = text
      value.title = whole
      dt.hidden = !text
      dd.hidden = !text
    }
  }

  const buildPanel = (name) => {
    const rootNode = el('section', 'detail')
    rootNode.setAttribute('aria-label', name + ' details')
    const head = el('div', 'dhead')
    const ref = el('span', 'dref')
    const state = el('span', 'dstate')
    const badge = el('span', 'dbadge', 'needs you')
    const close = el('button', 'x', '×')
    close.type = 'button'
    close.title = 'close (Esc)'
    close.setAttribute('aria-label', 'close the ' + name + ' details')
    close.addEventListener('click', dismiss)
    head.append(el('span', 'dot'), el('span', 'dname', name), ref, state, badge, close)
    const spec = el('div', 'dspec')
    const act = el('div', 'dact')
    const owes = el('div', 'downes')
    const list = el('dl')
    const setBranch = fieldOf(list, 'branch', false)
    const setWorktree = fieldOf(list, 'worktree', true)
    const setSession = fieldOf(list, 'session', true)
    const threadRule = el('div', 'rule')
    const threadNote = el('span', 'r', '')
    threadRule.append(el('span', '', 'thread'), threadNote)
    const report = el('div', 'report')
    const thread = el('div', 'thread')
    const pane = el('details', 'pane')
    pane.open = readPaneOpen()
    const summary = el('summary', 'rule')
    const stale = el('span', 'stale')
    stale.hidden = true
    summary.append(el('span', 'lbl', 'pane'), stale)
    const pre = el('pre', '', tail.text)
    pane.append(summary, pre)
    rootNode.append(head, spec, act, owes, list, threadRule, report, thread, pane)
    const mine = { name, root: rootNode, ref, state, badge, spec, act, owes, setBranch, setWorktree, setSession, threadNote, report, thread, cache: new Map(), signature: '', stale, pre, stick: true, top: 0 }
    pane.addEventListener('toggle', () => {
      savePaneOpen(pane.open)
      if (pane.open) settle(mine)
    })
    pre.addEventListener('scroll', () => {
      if (pre.clientHeight === 0) return
      mine.top = pre.scrollTop
      mine.stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24
    })
    return mine
  }

  const paintTail = (target) => {
    if (target.pre.textContent !== tail.text) target.pre.textContent = tail.text
    target.stale.hidden = !tail.stale
    target.stale.textContent = tail.stale ? 'stale · last read ' + clockText(tail.readAt, new Date(tail.readAt).getTimezoneOffset()) : ''
    target.stale.title = tail.reason
    settle(target)
  }

  const paintReport = (target, report) => {
    target.report.hidden = !report
    if (!report) return
    const tone = toneColor(KIND_TONE[report.kind] || 'muted')
    target.report.style.setProperty('--rc', tone)
    const meta = el('div', 'meta', 'latest report · ')
    const kind = el('span', '', report.kind)
    kind.style.color = tone
    const expects = report.expects && report.expects !== 'none' ? ' · expects ' + report.expects : ''
    meta.append(kind, expects + ' · ' + clockText(report.at, new Date(report.at).getTimezoneOffset()))
    const body = el('div', 'body', report.summary)
    body.title = report.summary
    target.report.replaceChildren(meta, body)
  }

  // The seat's own lines, built like the timeline's and kept by id, so one the reader expanded stays expanded.
  const paintThread = (target, entries) => {
    target.threadNote.textContent = entries.length ? 'last ' + entries.length + ' · newest first' : ''
    const next = entries.map((entry) => entry.id).join(',')
    if (next === target.signature) return
    target.signature = next
    const live = new Set(entries.map((entry) => entry.id))
    for (const id of [...target.cache.keys()]) if (!live.has(id)) target.cache.delete(id)
    const nodes = entries.map((entry) => {
      if (!target.cache.has(entry.id)) target.cache.set(entry.id, entryOf(entry))
      return target.cache.get(entry.id)
    })
    if (nodes.length === 0) nodes.push(el('div', 'note', 'No brief or report yet.'))
    target.thread.replaceChildren(...nodes)
  }

  // One panel per open seat: its fields are rewritten on every update, its pane text only when a read brings new text, so a scrolled pane stays where it is.
  // The graph view and the board view show the same panel.
  const panelFor = (seat) => {
    if (!panel || panel.name !== seat.name) panel = buildPanel(seat.name)
    const mine = panel
    mine.root.style.setProperty('--c', toneColor(seat.tone))
    mine.ref.textContent = seat.cairn || ''
    mine.ref.hidden = !seat.cairn
    mine.state.textContent = seat.state + ' · ' + ageOf(seat.stateAt)
    mine.badge.hidden = !seat.needsYou
    mine.spec.textContent = panelKit.specOf(seat)
    const owes = seat.owes && seat.owes !== 'none' ? seat.owes : ''
    mine.owes.textContent = owes ? 'waiting for the planner: ' + owes : ''
    mine.owes.hidden = !owes
    mine.act.textContent = seat.activity || ''
    mine.act.hidden = !seat.activity || !!owes
    mine.setBranch(seat.branch || '')
    mine.setWorktree(seat.worktree || '')
    mine.setSession(panelKit.shortId(seat.sessionId), seat.sessionId || '')
    paintReport(mine, seat.lastReport)
    paintThread(mine, panelKit.threadOf((data && data.feed) || [], seat.name))
    paintTail(mine)
    return mine.root
  }

  // ---------- timeline ----------

  const nameOf = (name) => (name === HUMAN ? 'you' : name)
  const personTone = (name) => (name === HUMAN ? 'you' : LEAD_NAMES.includes(name) ? 'lead' : 'working')

  const entryOf = (entry) => {
    const node = el('div', 'entry')
    const line = el('div', 'line')
    line.tabIndex = 0
    line.setAttribute('role', 'button')
    line.setAttribute('aria-expanded', 'false')
    const tone = toneColor(KIND_TONE[entry.kind] || 'muted')
    const time = el('span', 't', clockText(entry.at, new Date(entry.at).getTimezoneOffset()))
    const icon = el('span', 'i', KIND_ICON[entry.kind] || '•')
    icon.style.color = tone
    const pair = el('span', 'p')
    const from = el('span', '', nameOf(entry.from))
    from.style.color = toneColor(personTone(entry.from))
    const to = el('span', '', nameOf(entry.to))
    to.style.color = toneColor(personTone(entry.to))
    pair.append(from, el('span', 'a', ' → '), to)
    const kind = el('span', 'k', entry.kind)
    kind.style.color = tone
    line.append(time, icon, pair, kind, el('span', 's', entry.summary))
    const more = el('div', 'more')
    more.hidden = true
    more.append(
      el('div', 'meta', nameOf(entry.from) + ' → ' + nameOf(entry.to) + ' · ' + entry.kind + ' · ' + new Date(entry.at).toLocaleString()),
      el('div', 'body', entry.full || entry.summary),
    )
    onActivate(line, () => {
      const isOpen = line.getAttribute('aria-expanded') !== 'true'
      line.setAttribute('aria-expanded', String(isOpen))
      more.hidden = !isOpen
    })
    node.append(line, more)
    return node
  }

  const createTimeline = () => {
    const rootNode = el('aside', 'timeline')
    const rule = el('div', 'rule')
    const count = el('span', 'r', '')
    rule.append(el('span', '', 'timeline'), count)
    const chips = el('div', 'chips')
    const chipNodes = new Map()
    for (const [id, label] of FILTERS) {
      const chip = el('button', 'chip', label)
      chip.type = 'button'
      const n = el('span', 'n', '')
      chip.append(n)
      chip.addEventListener('click', () => {
        filter = id
        if (data) render(data)
      })
      chips.append(chip)
      chipNodes.set(id, { chip, n })
    }
    const list = el('div', 'entries')
    rootNode.append(rule, chips, list)
    const cache = new Map()
    let signature = ''

    const update = (feed) => {
      const live = new Set(feed.map((entry) => entry.id))
      for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id)
      for (const [id, label, kinds] of FILTERS) {
        const node = chipNodes.get(id)
        node.chip.setAttribute('aria-pressed', String(filter === id))
        node.n.textContent = String(kinds ? feed.filter((entry) => kinds.includes(entry.kind)).length : feed.length)
      }
      count.textContent = feed.length + (feed.length === 1 ? ' entry' : ' entries') + ' · newest first'
      const wanted = FILTERS.find(([id]) => id === filter)[2]
      const shown = (wanted ? feed.filter((entry) => wanted.includes(entry.kind)) : feed).slice().reverse()
      const next = filter + '|' + shown.map((entry) => entry.id).join(',')
      if (next === signature) return
      signature = next
      const nodes = shown.map((entry) => {
        if (!cache.has(entry.id)) cache.set(entry.id, entryOf(entry))
        return cache.get(entry.id)
      })
      if (feed.length === 0) nodes.push(el('div', 'note', 'Briefs, reports and verdicts appear here.'))
      else if (shown.length === 0) nodes.push(el('div', 'note', 'Nothing in the feed matches this filter.'))
      const active = document.activeElement
      const height = list.scrollHeight
      list.replaceChildren(...nodes)
      if (list.scrollTop > 0) list.scrollTop += list.scrollHeight - height
      if (active && active !== document.body && list.contains(active)) active.focus({ preventScroll: true })
    }
    return { root: rootNode, update }
  }

  // ---------- graph ----------

  const layoutOf = __LAYOUT__

  const lengthsOf = (points) => {
    const lengths = [0]
    for (let at = 1; at < points.length; at += 1) lengths.push(lengths[at - 1] + Math.hypot(points[at][0] - points[at - 1][0], points[at][1] - points[at - 1][1]))
    return lengths
  }

  const pointAt = (points, lengths, ratio) => {
    const target = lengths[lengths.length - 1] * ratio
    for (let at = 1; at < points.length; at += 1) {
      if (target <= lengths[at] || at === points.length - 1) {
        const span = lengths[at] - lengths[at - 1] || 1
        const part = Math.max(0, Math.min(1, (target - lengths[at - 1]) / span))
        return [points[at - 1][0] + (points[at][0] - points[at - 1][0]) * part, points[at - 1][1] + (points[at][1] - points[at - 1][1]) * part]
      }
    }
    return points[0]
  }

  const nodeParts = (isButton) => {
    const rootNode = el(isButton ? 'button' : 'div', 'node')
    if (isButton) rootNode.type = 'button'
    const top = el('span', 'top')
    const name = el('span', 'name')
    const ref = el('span', 'ref')
    top.append(el('span', 'dot'), name, ref)
    const badge = el('span', 'badge', 'needs you')
    const sub = el('span', 'sub')
    const m = el('span', 'm')
    const k = el('span', 'k')
    sub.append(m, k)
    const act = el('span', 'act')
    rootNode.append(badge, top, sub, act)
    return { root: rootNode, name, badge, m, k, ref, act }
  }

  const createGraph = () => {
    const wrap = el('div', 'graph')
    const svg = svgEl('svg', 'links')
    svg.setAttribute('aria-hidden', 'true')
    const edgeLayer = svgEl('g')
    const flightLayer = svgEl('g')
    svg.append(edgeLayer, flightLayer)
    wrap.append(svg)
    const lead = nodeParts(false)
    lead.root.setAttribute('aria-label', 'lead')
    lead.name.textContent = 'lead'
    lead.ref.hidden = true
    lead.badge.hidden = true
    wrap.append(lead.root)
    const seatNodes = new Map()
    const edges = new Map()
    let routes = new Map()
    let width = 0
    let current

    const place = () => {
      const w = wrap.clientWidth
      if (w === 0 || !current) return
      width = w
      const seats = current.seats
      const spot = layoutOf(seats.length, w)
      wrap.style.height = Math.round(spot.height) + 'px'
      const put = (node, box) => {
        node.style.left = Math.round(box.x - box.w / 2) + 'px'
        node.style.top = Math.round(box.y - box.h / 2) + 'px'
        node.style.width = Math.round(box.w) + 'px'
        node.style.height = Math.round(box.h) + 'px'
      }
      put(lead.root, spot.lead)
      routes = new Map()
      seats.forEach((seat, at) => {
        const node = seatNodes.get(seat.name)
        const edge = edges.get(seat.name)
        if (!node || !edge) return
        put(node.root, spot.seats[at])
        routes.set(seat.name, spot.routes[at])
        edge.setAttribute('points', spot.routes[at].map((point) => Math.round(point[0]) + ',' + Math.round(point[1])).join(' '))
      })
    }

    const update = (next) => {
      current = next
      const seats = next.seats || []
      const lord = next.lead
      lead.m.textContent = lord.modelLabel + ' · ' + lord.effort
      lead.k.textContent = lord.kind
      lead.act.textContent = lord.activity || 'idle'
      lead.root.style.setProperty('--c', toneColor('lead'))
      lead.root.classList.toggle('working', lord.isBusy)
      lead.root.title = lord.activity || ''
      const names = new Set(seats.map((seat) => seat.name))
      for (const name of [...seatNodes.keys()]) {
        if (names.has(name)) continue
        seatNodes.get(name).root.remove()
        edges.get(name).remove()
        seatNodes.delete(name)
        edges.delete(name)
      }
      for (const seat of seats) {
        let node = seatNodes.get(seat.name)
        if (!node) {
          node = nodeParts(true)
          node.name.textContent = seat.name
          onActivate(node.root, () => toggleSeat(seat.name))
          wrap.append(node.root)
          seatNodes.set(seat.name, node)
          const edge = svgEl('polyline', 'edge')
          edgeLayer.append(edge)
          edges.set(seat.name, edge)
        }
        node.m.textContent = seat.modelLabel + ' · ' + seat.effort
        node.k.textContent = seat.kind
        node.ref.textContent = seat.cairn || ''
        node.ref.hidden = !seat.cairn
        node.badge.hidden = !seat.needsYou
        node.act.textContent = seat.activity || seat.state
        node.root.title = (seat.activity || seat.state) + '\n' + seat.modelLabel + ' · ' + seat.effort + ' · ' + seat.kind
        node.root.style.setProperty('--c', toneColor(seat.tone))
        node.root.classList.toggle('working', seat.state === 'working' && !seat.needsYou)
        node.root.classList.toggle('sel', openSeat === seat.name)
        node.root.setAttribute('aria-label', seat.name + ', ' + seat.state + (seat.needsYou ? ', needs you' : '') + '. Show details')
      }
      place()
    }

    const endpointOf = (name) => {
      if (seatNodes.has(name)) return name
      return LEAD_NAMES.includes(String(name).toLowerCase()) || LEAD_NAMES.includes(name) ? 'lead' : ''
    }

    const pathOf = (from, to) => {
      const part = (name) => routes.get(name)
      if (from !== 'lead' && !part(from)) return undefined
      if (to !== 'lead' && !part(to)) return undefined
      const up = from === 'lead' ? [] : part(from).slice().reverse()
      const down = to === 'lead' ? [] : part(to)
      const points = up.concat(down)
      return points.length > 1 ? points : undefined
    }

    const nodeOf = (name) => (name === 'lead' ? lead.root : seatNodes.has(name) ? seatNodes.get(name).root : undefined)

    const timers = new Set()
    const later = (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id)
        fn()
      }, ms)
      timers.add(id)
    }

    const highlight = (names, color) => {
      for (const name of names) {
        const edge = edges.get(name)
        if (!edge) continue
        edge.style.stroke = color
        edge.classList.add('hit')
        later(() => {
          edge.classList.remove('hit')
          edge.style.stroke = ''
        }, 900)
      }
    }

    const arrive = (name, color) => {
      const node = nodeOf(name)
      if (!node) return
      node.style.setProperty('--hit', color)
      node.classList.remove('recv')
      void node.offsetWidth
      node.classList.add('recv')
      later(() => node.classList.remove('recv'), 900)
    }

    const fly = (entry, delay) => {
      const from = endpointOf(entry.from)
      const to = endpointOf(entry.to)
      if (!from || !to || from === to || width === 0) return
      const points = pathOf(from, to)
      if (!points) return
      const color = toneColor(KIND_TONE[entry.kind] || 'muted')
      later(() => {
        if (!pathOf(from, to)) return
        if (reduceMotion()) {
          highlight([from, to], color)
          return
        }
        const lengths = lengthsOf(points)
        const flight = svgEl('g', 'flight')
        const halo = svgEl('circle')
        halo.setAttribute('r', '11')
        halo.setAttribute('fill', color)
        halo.setAttribute('opacity', '0.22')
        const dot = svgEl('circle')
        dot.setAttribute('r', '5')
        dot.setAttribute('fill', color)
        const label = svgEl('text')
        label.setAttribute('y', '-14')
        label.setAttribute('fill', color)
        label.textContent = entry.kind
        flight.append(halo, dot, label)
        flightLayer.append(flight)
        const started = performance.now()
        const step = (now) => {
          const t = Math.min(1, (now - started) / FLIGHT_MS)
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
          const at = pointAt(points, lengths, eased)
          flight.setAttribute('transform', 'translate(' + at[0].toFixed(1) + ' ' + at[1].toFixed(1) + ')')
          flight.style.opacity = String(Math.min(1, t * 8, (1 - t) * 6 + 0.15))
          if (t < 1) {
            requestAnimationFrame(step)
          } else {
            flight.remove()
            arrive(to, color)
          }
        }
        requestAnimationFrame(step)
      }, delay)
    }

    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (wrap.clientWidth !== width) place()
      }).observe(wrap)
    }

    return {
      root: wrap,
      update,
      place,
      focus: (name) => {
        const node = seatNodes.get(name)
        if (node && !wrap.hidden) node.root.focus()
      },
      send: (entries) => entries.slice(-MAX_FLIGHTS).forEach((entry, at) => fly(entry, at * FLIGHT_GAP_MS)),
    }
  }

  // ---------- page ----------

  let shell
  const seen = new Set()
  let isFirst = true

  const buildShell = () => {
    const bar = el('div', 'bar')
    const tools = el('div', 'tools')
    const seg = el('div', 'seg')
    seg.setAttribute('role', 'group')
    seg.setAttribute('aria-label', 'view')
    const buttons = new Map()
    for (const [id, label] of VIEWS) {
      const button = el('button', 'segbtn', label)
      button.type = 'button'
      button.addEventListener('click', () => {
        view = id
        saveView(id)
        applyView()
        if (data) render(data)
      })
      seg.append(button)
      buttons.set(id, button)
    }
    const runLabel = el('span', 'runid')
    const end = el('div', 'end')
    end.append(runLabel, conn)
    tools.append(seg, end)
    const stage = el('div', 'stage')
    const primary = el('div', 'primary')
    const graph = createGraph()
    const seats = el('section', 'seats')
    const slot = el('div', 'slot')
    primary.append(graph.root, seats, slot)
    const timeline = createTimeline()
    stage.append(primary, timeline.root)
    root.replaceChildren(bar, tools, stage)
    shell = { bar, runLabel, buttons, stage, graph, seats, slot, timeline }
    applyView()
  }

  const applyView = () => {
    shell.stage.className = 'stage view-' + view
    shell.graph.root.hidden = view !== 'graph'
    shell.slot.hidden = view !== 'graph'
    shell.seats.hidden = view !== 'board'
    for (const [id, button] of shell.buttons) button.setAttribute('aria-pressed', String(id === view))
  }

  const seatRowOf = (row, seat) => {
    const node = rowOf(row)
    const isOpen = openSeat === seat.name
    node.className = 'row seat' + (isOpen ? ' open' : '')
    node.tabIndex = 0
    node.setAttribute('role', 'button')
    node.setAttribute('aria-expanded', String(isOpen))
    onActivate(node, () => toggleSeat(seat.name))
    return node
  }

  const renderBoard = (byName) => {
    const { model } = data
    const nodes = [rowOf(model.lead)]
    for (const row of model.workers) {
      const seat = byName.get(row.key.replace(/^w:/, ''))
      if (!seat) {
        nodes.push(rowOf(row))
        continue
      }
      nodes.push(seatRowOf(row, seat))
      if (openSeat === seat.name) nodes.push(panelFor(seat))
    }
    if (model.empty) nodes.push(el('div', 'note', model.empty))
    shell.seats.replaceChildren(...nodes)
  }

  const render = (next) => {
    data = next
    if (!shell) buildShell()
    const active = document.activeElement
    const { model, run } = data
    const seatList = data.seats || []
    const byName = new Map(seatList.map((seat) => [seat.name, seat]))
    if (openSeat && !byName.has(openSeat)) closePanel()
    const brand = el('span', 'brand b', model.title[0] ? model.title[0].text : 'drove')
    brand.style.color = toneColor(model.title[0] ? model.title[0].tone : 'lead')
    const goalText = model.title.slice(1).map((cell) => cell.text).join(' · ')
    const goal = el('span', 'goal' + (model.title[1] && model.title[1].isBold ? ' b' : ''), goalText)
    goal.title = goalText
    goal.style.color = toneColor(model.title[1] ? model.title[1].tone : 'muted')
    const right = el('div', 'right')
    for (const cell of model.progress) {
      const stat = el('span', cell.isBold ? 'b' : '', cell.text)
      stat.style.color = toneColor(cell.tone)
      right.append(stat)
    }
    shell.bar.replaceChildren(brand, goal, right)
    shell.runLabel.textContent = run
    const feed = data.feed || []
    shell.graph.update({ seats: seatList, lead: data.lead })
    if (view === 'board') renderBoard(byName)
    const slotted = view === 'graph' && openSeat && byName.has(openSeat) ? panelFor(byName.get(openSeat)) : undefined
    if (shell.slot.firstChild !== slotted || shell.slot.childNodes.length > 1) shell.slot.replaceChildren(...(slotted ? [slotted] : []))
    shell.timeline.update(feed)
    settle(panel)
    if (panel && active && active !== document.activeElement && panel.root.contains(active)) active.focus({ preventScroll: true })
    const fresh = feed.filter((entry) => !seen.has(entry.id))
    for (const entry of feed) seen.add(entry.id)
    if (!isFirst && view === 'graph' && !document.hidden) shell.graph.send(fresh)
    isFirst = false
    const named = model.title[1] ? model.title[1].text : ''
    document.title = 'drove' + (named ? ' · ' + named : '')
  }

  const setConn = (live) => {
    conn.textContent = live ? 'live' : 'disconnected'
    conn.className = 'conn' + (live ? '' : ' off')
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openSeat) dismiss()
  })

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

const TONE_VARS = Object.entries(TONE_COLOR)
  .map(([tone, color]) => `--tone-${tone}: ${color};`)
  .join(' ')
const TONE_REFS = Object.fromEntries(Object.keys(TONE_COLOR).map(tone => [tone, `var(--tone-${tone})`]))

export const pageOf = (): string =>
  PAGE.replace('__TONE_VARS__', () => TONE_VARS)
    .replace('__TONES__', () => JSON.stringify(TONE_REFS))
    .replace('__NEEDS_YOU__', () => JSON.stringify(NEEDS_YOU_KINDS))
    .replace('__REPORTS__', () => JSON.stringify(REPORT_KINDS))
    .replace('__KIND_TONES__', () => JSON.stringify(KIND_TONES))
    .replace('__KIND_ICONS__', () => JSON.stringify(KIND_ICONS))
    .replace('__LEAD_NAMES__', () => JSON.stringify(LEAD_NAMES))
    .replace('__HUMAN__', () => JSON.stringify(HUMAN))
    .replace('__CLOCK__', () => CLOCK_SOURCE)
    .replace('__LAYOUT__', () => LAYOUT_SOURCE)
    .replace('__PANEL__', () => PANEL_SOURCE)
