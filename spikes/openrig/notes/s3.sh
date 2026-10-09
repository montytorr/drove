#!/bin/bash
rig down duo 2>&1 | tail -3
cp /notes/duo.yaml ~/duo/rig.yaml
cd ~/work
rig up ~/duo/rig.yaml --cwd ~/work 2>&1 | tail -6
sleep 25
rig ps --nodes --rig duo 2>&1
rig capture dev-build@duo --lines 20 2>&1
ps -eo args | grep "[c]odex --no-daemon" | head -1
