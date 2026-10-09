# Timed log (CCS-49)
- 09:58 start; Docker 28.3.2; README read (install = npm i -g @openrig/cli; rig setup)
07:59 setup+doctor ok, claude absent
07:59 daemon up (--no-kernel; needs tmux server running first; bind 0.0.0.0 refused w/o bearer token)
08:00 rig up of 2 codex seats: 12.7s. codex bwrap sandbox fails in docker (user namespaces), seats stall at approval prompt
08:01 duo rig live with builtin:yolo policy (needed in docker: default -s workspace-write -> bwrap fails). ~4min from first docker exec to working rig, excl 30s image build
08:03 queue create->builder->handoff->reviewer->PASS->relay worked end to end (~50s). states flip idle/working/needs_input correctly. queue list default hides done; --verify waits 30s for slack-style receipt (inert here)
08:04 tui renders ok (explorer/topology panes, vim-ish cmd bar); web UI at / is 404 (needs rig ui open? /api/rigs 200). snapshot manual ok. killed tmux session dev-build: daemon marks lifecycle att/stop, NO auto-restart
08:06 seat clean/launch need --reason/--fresh flags (manual recover); full rig down(auto snapshot)+rig up duo => fully_restored, both codex sessions resumed (codex resume id)
