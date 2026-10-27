#!/usr/bin/env bash
# Lets a Chromium-based browser on Linux install the OctoHatchery extension from a .crx file.
# Writes one policy file per browser: ExtensionInstallSources (where a .crx may come from) and
# ExtensionInstallAllowlist (the extension ID). Run it as root, then restart the browser.
#
#   sudo ./install-policy-linux.sh [--browser NAME]... [--source PATTERN]... [--id ID] [--remove] [--dry-run]
#
#   --browser  chrome, chromium, brave, edge, vivaldi or all. Default: every one of them that is installed.
#   --source   a URL pattern a .crx may be downloaded from, e.g. "https://github.com/*". Repeat for more.
#              file:///* (a file dragged onto the extensions page) is always included.
#   --id       the extension ID. Default: the ID of the build this script came with.
#   --remove   delete the policy files this script wrote.
#   --dry-run  print what would be written, change nothing.
# POLICY_ROOT puts every path under another folder (for tests).
set -euo pipefail

EXTENSION_ID="__EXTENSION_ID__"
FILE_NAME="octohatchery-extension.json"
root="${POLICY_ROOT:-}"
browsers=()
sources=("file:///*")
remove=0
dry=0

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --browser) browsers+=("${2:?--browser needs a name}"); shift 2 ;;
    --source) sources+=("${2:?--source needs a URL pattern}"); shift 2 ;;
    --id) EXTENSION_ID="${2:?--id needs an extension ID}"; shift 2 ;;
    --remove) remove=1; shift ;;
    --dry-run) dry=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done
# The build fills in the ID; an unfilled placeholder means none (split so the build does not replace it here).
[ "$EXTENSION_ID" = "__EXTENSION""_ID__" ] && EXTENSION_ID=""
if [ -n "$EXTENSION_ID" ] && ! [[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "not an extension ID: $EXTENSION_ID (32 letters a to p)" >&2; exit 1
fi

# Policy folders. Chromium uses /etc/chromium on most distributions and /etc/chromium-browser on Ubuntu.
dirs_for() {
  case "$1" in
    chrome) echo "/etc/opt/chrome/policies/managed" ;;
    chromium) echo "/etc/chromium/policies/managed /etc/chromium-browser/policies/managed" ;;
    brave) echo "/etc/brave/policies/managed" ;;
    edge) echo "/etc/opt/edge/policies/managed" ;;
    vivaldi) echo "/etc/vivaldi/policies/managed" ;;
    *) echo "unknown browser: $1 (chrome, chromium, brave, edge, vivaldi, all)" >&2; exit 1 ;;
  esac
}
installed() {
  case "$1" in
    chrome) command -v google-chrome >/dev/null || command -v google-chrome-stable >/dev/null || [ -d /opt/google/chrome ] ;;
    chromium) command -v chromium >/dev/null || command -v chromium-browser >/dev/null ;;
    brave) command -v brave-browser >/dev/null || command -v brave >/dev/null || [ -d /opt/brave.com ] ;;
    edge) command -v microsoft-edge >/dev/null || [ -d /opt/microsoft/msedge ] ;;
    vivaldi) command -v vivaldi >/dev/null || command -v vivaldi-stable >/dev/null || [ -d /opt/vivaldi ] ;;
  esac
}

all=(chrome chromium brave edge vivaldi)
if [ ${#browsers[@]} -eq 0 ]; then
  for b in "${all[@]}"; do installed "$b" && browsers+=("$b"); done
  [ ${#browsers[@]} -gt 0 ] || { echo "no supported browser found; name one with --browser" >&2; exit 1; }
elif [ "${browsers[0]}" = all ]; then
  browsers=("${all[@]}")
fi

if [ "$dry" -eq 0 ] && [ -z "$root" ] && [ "$(id -u)" -ne 0 ]; then
  echo "run this as root (sudo $0 ...): the policy folders under /etc belong to root" >&2; exit 1
fi

json() {
  local first=1
  printf '{\n  "ExtensionInstallSources": ['
  for s in "${sources[@]}"; do
    [ $first -eq 1 ] && first=0 || printf ', '
    printf '"%s"' "${s//\"/\\\"}"
  done
  printf ']'
  [ -n "$EXTENSION_ID" ] && printf ',\n  "ExtensionInstallAllowlist": ["%s"]' "$EXTENSION_ID"
  printf '\n}\n'
}

for b in "${browsers[@]}"; do
  for d in $(dirs_for "$b"); do
    dir="$root$d"
    file="$dir/$FILE_NAME"
    if [ "$remove" -eq 1 ]; then
      if [ -f "$file" ]; then
        [ "$dry" -eq 1 ] && echo "would remove $file" || { rm -f "$file"; echo "removed $file"; }
      fi
      continue
    fi
    # Two files that set the same policy do not add up: the browser takes one of them. Say so.
    if [ -d "$dir" ]; then
      for other in "$dir"/*.json; do
        [ -e "$other" ] && [ "$other" != "$file" ] || continue
        if grep -qE '"ExtensionInstall(Sources|Allowlist)"' "$other"; then
          echo "warning: $other also sets ExtensionInstallSources or ExtensionInstallAllowlist." >&2
          echo "         The browser uses only one of the two values: merge the entries into one file." >&2
        fi
      done
    fi
    if [ "$dry" -eq 1 ]; then
      echo "would write $file:"; json
    else
      mkdir -p "$dir"
      json > "$file"
      chmod 644 "$file"
      echo "wrote $file"
    fi
  done
done

[ "$remove" -eq 1 ] && exit 0
[ -n "$EXTENSION_ID" ] || echo "note: no extension ID given, so no ExtensionInstallAllowlist was written (pass --id if a blocklist is set)." >&2
echo "Restart the browser, open <browser>://policy and check that both policies show the status OK."
