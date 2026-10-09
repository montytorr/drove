#!/bin/bash
cd ~/work
echo "== ui"; curl -s -o /dev/null -w "%{http_code} %{content_type}\n" localhost:7433/; curl -s localhost:7433/healthz | head -c 300; echo
echo "== mcp"; rig mcp --help 2>&1 | head -20
echo "== mcp tools"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | timeout 10 rig mcp serve 2>&1 | tail -1 | jq -r '.result.tools[] | "\(.name)\t\(.description[0:90])"' 2>&1 | head -30
echo "== snapshot"; rig snapshot --help 2>&1 | head -15
echo "== config / transcript / whoami"
rig whoami --help 2>&1 | head -5
rig transcript dev-build@duo --tail 5 2>&1 | head -15
rig tui --help 2>&1 | head -10
