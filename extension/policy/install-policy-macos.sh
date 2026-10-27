#!/usr/bin/env bash
# Lets a Chromium-based browser on macOS install the OctoHatchery extension from a .crx file.
# Browsers on macOS read machine policies from configuration profiles, so this script writes a profile
# (.mobileconfig) with ExtensionInstallSources (where a .crx may come from) and ExtensionInstallAllowlist
# (the extension ID), then opens it. Install it in System Settings, then restart the browser.
#
#   ./install-policy-macos.sh [--browser NAME]... [--source PATTERN]... [--id ID] [--out FILE] [--no-open]
#
#   --browser  chrome, chromium, brave, edge, vivaldi or all. Default: every one of them in /Applications.
#   --source   a URL pattern a .crx may be downloaded from, e.g. "https://github.com/*". Repeat for more.
#              file:///* (a file dragged onto the extensions page) is always included.
#   --id       the extension ID. Default: the ID of the build this script came with.
#   --out      where to write the profile. Default: ./octohatchery-extension-policy.mobileconfig
#   --no-open  write the profile only.
# To undo, remove the profile "OctoHatchery extension install" in System Settings.
set -euo pipefail

EXTENSION_ID="__EXTENSION_ID__"
browsers=()
sources=("file:///*")
out="./octohatchery-extension-policy.mobileconfig"
open_it=1

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --browser) browsers+=("${2:?--browser needs a name}"); shift 2 ;;
    --source) sources+=("${2:?--source needs a URL pattern}"); shift 2 ;;
    --id) EXTENSION_ID="${2:?--id needs an extension ID}"; shift 2 ;;
    --out) out="${2:?--out needs a file}"; shift 2 ;;
    --no-open) open_it=0; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done
# The build fills in the ID; an unfilled placeholder means none (split so the build does not replace it here).
[ "$EXTENSION_ID" = "__EXTENSION""_ID__" ] && EXTENSION_ID=""
if [ -n "$EXTENSION_ID" ] && ! [[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "not an extension ID: $EXTENSION_ID (32 letters a to p)" >&2; exit 1
fi

domain_for() {
  case "$1" in
    chrome) echo "com.google.Chrome" ;;
    chromium) echo "org.chromium.Chromium" ;;
    brave) echo "com.brave.Browser" ;;
    edge) echo "com.microsoft.Edge" ;;
    vivaldi) echo "com.vivaldi.Vivaldi" ;;
    *) echo "unknown browser: $1 (chrome, chromium, brave, edge, vivaldi, all)" >&2; exit 1 ;;
  esac
}
app_for() {
  case "$1" in
    chrome) echo "Google Chrome.app" ;;
    chromium) echo "Chromium.app" ;;
    brave) echo "Brave Browser.app" ;;
    edge) echo "Microsoft Edge.app" ;;
    vivaldi) echo "Vivaldi.app" ;;
  esac
}

all=(chrome chromium brave edge vivaldi)
if [ ${#browsers[@]} -eq 0 ]; then
  for b in "${all[@]}"; do
    app=$(app_for "$b")
    { [ -d "/Applications/$app" ] || [ -d "$HOME/Applications/$app" ]; } && browsers+=("$b")
  done
  [ ${#browsers[@]} -gt 0 ] || { echo "no supported browser found in /Applications; name one with --browser" >&2; exit 1; }
elif [ "${browsers[0]}" = all ]; then
  browsers=("${all[@]}")
fi

uuid() { if command -v uuidgen >/dev/null; then uuidgen; else cat /proc/sys/kernel/random/uuid | tr a-z A-Z; fi; }
# sed, not ${var//}: in bash 5.2 an & in the replacement stands for the match.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

{
  cat <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
EOF
  for b in "${browsers[@]}"; do
    d=$(domain_for "$b")
    echo "    <dict>"
    echo "      <key>PayloadType</key><string>$d</string>"
    echo "      <key>PayloadIdentifier</key><string>octohatchery-extension.policy.$d</string>"
    echo "      <key>PayloadUUID</key><string>$(uuid)</string>"
    echo "      <key>PayloadVersion</key><integer>1</integer>"
    echo "      <key>PayloadDisplayName</key><string>$(app_for "$b" | sed 's/\.app$//'): extension install sources</string>"
    echo "      <key>ExtensionInstallSources</key>"
    echo "      <array>"
    for s in "${sources[@]}"; do echo "        <string>$(xml "$s")</string>"; done
    echo "      </array>"
    if [ -n "$EXTENSION_ID" ]; then
      echo "      <key>ExtensionInstallAllowlist</key>"
      echo "      <array><string>$EXTENSION_ID</string></array>"
    fi
    echo "    </dict>"
  done
  cat <<EOF
  </array>
  <key>PayloadDisplayName</key><string>OctoHatchery extension install</string>
  <key>PayloadDescription</key><string>Lets the browser install the OctoHatchery extension from a .crx file.</string>
  <key>PayloadIdentifier</key><string>octohatchery-extension.policy</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadScope</key><string>System</string>
  <key>PayloadUUID</key><string>$(uuid)</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
EOF
} > "$out"

echo "wrote $out for: ${browsers[*]}"
command -v plutil >/dev/null && plutil -lint "$out" >/dev/null && echo "profile is a valid property list"
[ -n "$EXTENSION_ID" ] || echo "note: no extension ID given, so no ExtensionInstallAllowlist was written (pass --id if a blocklist is set)." >&2
if [ "$open_it" -eq 1 ] && command -v open >/dev/null; then
  open "$out"
  echo "Now open System Settings > General > Device Management (on older macOS: Profiles),"
  echo "double-click \"OctoHatchery extension install\" and click Install."
else
  echo "Double-click $out, then install it in System Settings > General > Device Management."
fi
echo "Restart the browser, open <browser>://policy and check that both policies show the status OK."
