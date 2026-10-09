#!/bin/sh
# Print "HH:MM:SS agent_status outbox_lines" every second for N seconds: sh poll.sh 60
HERE="$(cd "$(dirname "$0")" && pwd)"
i=0
while [ "$i" -lt "${1:-30}" ]; do
  s="$(herdr agent get codex-proof | jq -r '.result.agent.agent_status')"
  echo "$(date +%T) $s $(wc -l < "$HERE/outbox.jsonl" | tr -d ' ')"
  i=$((i + 1)); sleep 1
done
