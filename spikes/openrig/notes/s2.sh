#!/bin/bash
set -e
D=/usr/local/lib/node_modules/@openrig/cli/daemon/specs
mkdir -p ~/duo/agents/development ~/work
cp -r $D/agents/shared ~/duo/agents/shared
cp -r $D/agents/development/implementer ~/duo/agents/development/
cp -r $D/agents/development/qa ~/duo/agents/development/
cp -r /notes/duo.yaml ~/duo/rig.yaml
cd ~/work
git init -q . 2>/dev/null || true
git config user.email a@b.c; git config user.name spike
echo "# work" > README.md; git add . ; git commit -qm init || true
rig specs preview ~/duo/rig.yaml 2>&1 | head -40
rig up ~/duo/rig.yaml --cwd ~/work --plan 2>&1 | head -60
