#!/bin/bash
cd ~/work
rig send dev-build@duo "What file did you create earlier and what did the reviewer say? One line." --wait-for-idle 20 2>&1 | tail -4
sleep 20
rig capture dev-build@duo --lines 8
echo "== send while needs-input guard / raw envelope"
rig capture dev-review@duo --lines 4 >/dev/null
echo "== hook relay"
sed -n 1,40p /usr/local/lib/node_modules/@openrig/cli/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs
echo "== sizes"
ls /usr/local/lib/node_modules/@openrig/cli/daemon/dist | head -30
du -sh /usr/local/lib/node_modules/@openrig ~/.openrig
ls ~/.openrig/state ~/.openrig/skills | head -30
echo "== agents.md written"
head -30 ~/work/AGENTS.md
