#!/bin/sh
# Spike CCS-48: open an interactive Codex session in a new herdr pane, wired to the
# `orch` MCP server (report tool). Run from inside a herdr pane: sh launch.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SANDBOX="$HERE/sandbox"          # throwaway cwd for Codex
OUTBOX="$HERE/outbox.jsonl"      # report tool appends one JSON line per report here
NAME="${1:-codex-proof}"         # herdr agent name
WORKER="$NAME"
TOKEN="tok-$(date +%s)"

mkdir -p "$SANDBOX"
: > "$OUTBOX"

# 1. New pane to the right of this one, cwd = sandbox, focus stays here.
PANE="$(herdr pane split --current --direction right --cwd "$SANDBOX" --no-focus | jq -r '.result.pane.pane_id')"
echo "pane: $PANE"

# 2. Start Codex in it. A fresh pane can answer agent_pane_busy while zsh loads, so retry.
#    - sandbox cwd is pre-trusted via a per-launch override (no trust prompt, config.toml untouched)
#    - the orch MCP server is injected with -c only; report tool calls need no approval
i=0
until herdr agent start "$NAME" --kind codex --pane "$PANE" -- \
  -s workspace-write \
  -C "$SANDBOX" \
  -c check_for_update_on_startup=false \
  -c "projects.\"$SANDBOX\".trust_level=\"trusted\"" \
  -c mcp_servers.orch.command=\"node\" \
  -c "mcp_servers.orch.args=[\"$HERE/orch-mcp.mjs\"]" \
  -c "mcp_servers.orch.env={ORCH_OUTBOX=\"$OUTBOX\", ORCH_WORKER=\"$WORKER\", ORCH_TOKEN=\"$TOKEN\"}" \
  -c mcp_servers.orch.default_tools_approval_mode=\"approve\" \
  > "$HERE/agent-start.json" 2> "$HERE/agent-start.err"
do
  i=$((i + 1))
  if [ "$i" -ge 15 ] || ! grep -q agent_pane_busy "$HERE/agent-start.json" "$HERE/agent-start.err"; then
    echo "agent start failed:"; cat "$HERE/agent-start.json" "$HERE/agent-start.err"; exit 1
  fi
  sleep 2
done

echo "agent: $NAME   pane: $PANE   outbox: $OUTBOX   token: $TOKEN"
cat "$HERE/agent-start.json"
echo
echo "If Codex still shows a trust or approval prompt in the new pane, accept it, then tell the orchestrator."
