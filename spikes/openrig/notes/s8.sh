#!/bin/bash
cd ~/work
date +%T
rig seat clean dev-build@duo 2>&1 | tail -5
rig seat launch dev-build@duo 2>&1 | tail -8
sleep 25
date +%T
rig ps --nodes --rig duo 2>&1
rig capture dev-build@duo --lines 14
echo "== full down + restore latest"
rig down duo 2>&1 | tail -4
rig snapshot list 01M4FTWSRCMEREVP56YSE7E8N7 2>&1 | head
rig up duo 2>&1 | tail -6
sleep 20
rig ps --nodes --rig duo 2>&1
