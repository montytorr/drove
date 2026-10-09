#!/bin/bash
cd ~/work
echo "== ui paths"; for p in /app /ui /dashboard /api/rigs; do echo -n "$p "; curl -s -o /dev/null -w "%{http_code}\n" localhost:7433$p; done
echo "== tui"
tmux new-session -d -s tuiview -x 140 -y 40 "rig tui"
sleep 6
tmux capture-pane -p -t tuiview | head -40
tmux kill-session -t tuiview
echo "== snapshot"
RID=$(rig ps --json 2>/dev/null | jq -r '.[0].rigId // .[0].id' )
echo rigid=$RID
rig snapshot $RID 2>&1 | tail -5
rig snapshot list $RID 2>&1 | head -8
echo "== kill build seat"
date +%T
tmux kill-session -t dev-build@duo
for i in 1 2 3 4 5 6; do sleep 6; date +%T; rig ps --nodes --rig duo 2>&1 | tail -2; done
tmux ls
