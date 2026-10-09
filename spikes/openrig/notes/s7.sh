#!/bin/bash
cd ~/work
rig ps --nodes --rig duo --json | jq -c '.[] | {s:.canonicalSessionName,l:.lifecycleState,a:.agentActivity,ss:.sessionStatus}'
rig parked 2>&1 | head -10
rig seat --help 2>&1 | head -25
date +%T
rig up duo --existing 2>&1 | tail -8
sleep 20
rig ps --nodes --rig duo 2>&1
rig capture dev-build@duo --lines 12
