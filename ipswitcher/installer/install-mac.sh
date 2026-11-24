#!/usr/bin/env bash
# IP Switcher helper on macOS: build from source and register it for Chrome and Edge (per user,
# no sudo). It changes this Mac's real network services (System Settings → Network); macOS allows
# that for administrator accounts.
#
#   ipswitcher/installer/install-mac.sh                    (dev extension ID)
#   ipswitcher/installer/install-mac.sh <id1>,<id2>        (store IDs)
#   IPSWITCHER_FAKE=1 ipswitcher/installer/install-mac.sh  (demo: pretend adapters, changes nothing)
set -euo pipefail
cd "$(dirname "$0")/.."
IDS=${1:-gojmikegpclikdmngdgonghdcdemicib}
DEST="$HOME/Library/Application Support/IPSwitcher"
mkdir -p "$DEST"
if [ -f "$DEST/pending.json" ]; then
  echo "A network change is still waiting for Keep / Revert. Finish it in the extension first." >&2
  exit 1
fi
(cd host && go build -trimpath -o "$DEST/ipswitch-host" .)

# Chrome starts the host with a minimal environment: a wrapper fixes the data folder (and demo mode).
FAKE=""
[ "${IPSWITCHER_FAKE:-}" = "1" ] && FAKE="export IPSWITCHER_FAKE=1"
cat > "$DEST/host.sh" <<EOF
#!/bin/sh
export IPSWITCHER_DATA_DIR="$DEST/data"
$FAKE
exec "$DEST/ipswitch-host" "\$@"
EOF
chmod +x "$DEST/host.sh"

ORIGINS=$(python3 -c 'import json,sys; print(json.dumps(["chrome-extension://%s/" % i.strip() for i in sys.argv[1].split(",") if i.strip()]))' "$IDS")
for d in "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
         "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"; do
  [ -d "$(dirname "$d")" ] || continue
  mkdir -p "$d"
  cat > "$d/com.tcroof.ipswitcher.json" <<EOF
{
  "name": "com.tcroof.ipswitcher",
  "description": "IP Switcher helper",
  "path": "$DEST/host.sh",
  "type": "stdio",
  "allowed_origins": $ORIGINS
}
EOF
  echo "registered: $d"
done
echo "IP Switcher helper installed to $DEST ($([ -n "$FAKE" ] && echo demo || echo real) mode)"
