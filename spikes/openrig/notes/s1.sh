#!/bin/bash
tmux new-session -d -s base
rig daemon start --no-kernel 2>&1 | tail
rig status 2>&1 | head -20
ls ~/.openrig
tail -20 ~/.openrig/*.log 2>/dev/null
