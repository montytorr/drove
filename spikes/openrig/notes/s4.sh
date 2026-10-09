#!/bin/bash
cd ~/work
date +%T
rig queue create --source operator@host --destination dev-build@duo --summary "hello.py" --body "Create hello.py in ~/work that prints hello openrig. Run it once. Then hand this qitem off with: rig queue handoff <id> --to dev-review@duo asking the reviewer to check hello.py and reply with one line verdict. Keep it tiny." --verify 2>&1 | tail -15
for i in 1 2 3 4 5 6 7 8; do sleep 8; date +%T; rig ps --nodes --rig duo 2>&1 | tail -2; done
rig queue list --limit 20 2>&1 | head -20
ls ~/work
