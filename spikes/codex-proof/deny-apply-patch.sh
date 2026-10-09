#!/bin/sh
# PreToolUse hook for the "planner" Codex: deny every call it is attached to (matcher limits it to file edits).
cat >/dev/null
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"planner role: file edits are not allowed, report instead"}}'
