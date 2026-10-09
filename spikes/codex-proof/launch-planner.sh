#!/bin/sh
# Stretch (CCS-48): like launch.sh, but the Codex gets an inline PreToolUse hook that denies apply_patch.
# Deliberately WITHOUT --dangerously-bypass-hook-trust, to record the hook-trust prompt. Accept it if shown and say what it said.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SANDBOX="$HERE/sandbox"
OUTBOX="$HERE/outbox.jsonl"
NAME="${1:-codex-planner}"
TOKEN="tok-$(date +%s)"

PANE="$(herdr pane split --current --direction right --cwd "$SANDBOX" --no-focus | jq -r '.result.pane.pane_id')"
echo "pane: $PANE"

i=0
until herdr agent start "$NAME" --kind codex --pane "$PANE" -- \
  -s workspace-write \
  -C "$SANDBOX" \
  -c check_for_update_on_startup=false \
  -c "projects.\"$SANDBOX\".trust_level=\"trusted\"" \
  -c mcp_servers.orch.command=\"node\" \
  -c "mcp_servers.orch.args=[\"$HERE/orch-mcp.mjs\"]" \
  -c "mcp_servers.orch.env={ORCH_OUTBOX=\"$OUTBOX\", ORCH_WORKER=\"$NAME\", ORCH_TOKEN=\"$TOKEN\"}" \
  -c mcp_servers.orch.default_tools_approval_mode=\"approve\" \
  -c "hooks.PreToolUse=[{matcher=\"apply_patch|Edit|Write\", hooks=[{type=\"command\", command=\"sh $HERE/deny-apply-patch.sh\", timeout=10}]}]" \
  > "$HERE/planner-start.json" 2> "$HERE/planner-start.err"
do
  i=$((i + 1))
  if [ "$i" -ge 15 ] || ! grep -q agent_pane_busy "$HERE/planner-start.json" "$HERE/planner-start.err"; then
    echo "agent start failed:"; cat "$HERE/planner-start.json" "$HERE/planner-start.err"; exit 1
  fi
  sleep 2
done

echo "agent: $NAME   pane: $PANE   token: $TOKEN"
