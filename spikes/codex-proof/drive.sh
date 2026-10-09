#!/bin/sh
# Spike CCS-48: drive the Codex session that launch.sh started.
#   sh drive.sh thread            print the Codex thread id herdr knows for the agent
#   sh drive.sh status            herdr agent state (idle/working/done/blocked)
#   sh drive.sh queue "message"   inject a message into the live session (no keystrokes)
#   sh drive.sh outbox            show reports so far
#   sh drive.sh wait N            block until the outbox has N lines (timeout 180s)
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="${NAME:-codex-proof}"
OUTBOX="$HERE/outbox.jsonl"

thread() { herdr agent get "$NAME" | jq -r '.result.agent.agent_session.value'; }

case "${1:-}" in
  thread) thread ;;
  status) herdr agent get "$NAME" | jq -c '.result.agent | {agent, agent_status, name, pane_id, agent_session}' ;;
  queue) codex queue --thread "$(thread)" --message "$2" ;;
  outbox) cat "$OUTBOX" ;;
  wait)
    n="$2"; t=0
    while [ "$(wc -l < "$OUTBOX")" -lt "$n" ]; do
      t=$((t + 1)); [ "$t" -gt 90 ] && { echo "timeout"; exit 1; }; sleep 2
    done
    cat "$OUTBOX" ;;
  *) echo "usage: sh drive.sh thread|status|queue MSG|outbox|wait N"; exit 2 ;;
esac
