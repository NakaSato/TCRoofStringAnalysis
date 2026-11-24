#!/usr/bin/env bash
# Build the Windows helper on any OS and package the extension + installer.
#   ipswitcher/build.sh            -> ipswitcher/dist/IPSwitcher-<version>.zip
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c 'import json;print(json.load(open("extension/manifest.json"))["version"])')
OUT=dist/IPSwitcher-$VERSION
rm -rf "$OUT" && mkdir -p "$OUT/helper"
(cd host && go test ./... >/dev/null && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "../$OUT/helper/ipswitch-host.exe" .)
cp installer/install.ps1 installer/install.cmd installer/uninstall.ps1 installer/uninstall.cmd installer/ipswitcher.ico "$OUT/helper/"
rsync -a --exclude test --exclude .DS_Store extension/ "$OUT/extension/"
cp README.md "$OUT/"
(cd dist && rm -f "IPSwitcher-$VERSION.zip" && zip -qr "IPSwitcher-$VERSION.zip" "IPSwitcher-$VERSION")
# Store upload (Chrome Web Store / Edge Add-ons): the extension alone, without the dev "key"
# (the store assigns its own ID; install the helper with -ExtensionId <that id>).
STORE=dist/store-$VERSION && rm -rf "$STORE" && mkdir -p "$STORE"
rsync -a --exclude test --exclude .DS_Store extension/ "$STORE/"
python3 - "$STORE/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]; m = json.load(open(p)); m.pop("key", None)
json.dump(m, open(p, "w"), indent=2, ensure_ascii=False)
PY
(cd "$STORE" && rm -f "../ipswitcher-extension-store-$VERSION.zip" && zip -qr "../ipswitcher-extension-store-$VERSION.zip" .)
rm -rf "$STORE"
echo "built $(pwd)/dist/IPSwitcher-$VERSION.zip"
echo "store $(pwd)/dist/ipswitcher-extension-store-$VERSION.zip"
