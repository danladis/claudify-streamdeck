#!/usr/bin/env bash
# Copy the plugin into Stream Deck's Plugins folder and reload it in place.
#
# Reloading goes through Stream Deck's own streamdeck:// deep links rather than
# restarting the app, which usually runs elevated and cannot be killed from
# here. Those links need developer mode, and Stream Deck rewrites that setting
# from memory when it exits -- so it goes stale whenever the app has restarted.
# The reload is therefore verified against Stream Deck's log, and developer mode
# is re-enabled only if the log says the link was refused.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

SRC="$(cd "$HERE/.." && pwd)/$PLUGIN_ID"

[[ -f "$SRC/manifest.json" ]] || { echo "error: $SRC/manifest.json not found" >&2; exit 1; }
[[ -d "$SRC/bin/node_modules/ws" ]] || {
  echo "error: plugin dependencies missing. Run: npm run deps" >&2
  exit 1
}

DEST_ROOT="$(find_plugins_dir)" || {
  echo "error: could not locate the Stream Deck Plugins folder." >&2
  echo "       Set STREAMDECK_PLUGINS_DIR and try again." >&2
  exit 1
}
DEST="$DEST_ROOT/$PLUGIN_ID"

# Stream Deck's log is the only reliable witness to a reload: the plugin runs as
# a child of an elevated app, so its process is not inspectable from here.
LOG="$(find_streamdeck_log || true)"
LOG_MARK=0
[[ -f "$LOG" ]] && LOG_MARK="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"

log_since_mark() {
  [[ -f "$LOG" ]] || return 1
  tail -c "+$((LOG_MARK + 1))" "$LOG" 2>/dev/null
}

# 0 = reloaded, 1 = refused (developer mode), 2 = no verdict yet or no log.
reload_verdict() {
  local text
  text="$(log_since_mark)" || return 2
  grep -qF "[$PLUGIN_UUID] Plugin connected" <<<"$text" && return 0
  grep -qF "Reloaded plugin '$PLUGIN_UUID'" <<<"$text" && return 0
  grep -qF 'Feature only enabled in developer mode' <<<"$text" && return 1
  return 2
}

await_reload() {
  local attempt status
  for attempt in 1 2 3 4 5 6 7 8; do
    reload_verdict
    status=$?
    (( status != 2 )) && return $status
    sleep 1
  done
  return 2
}

echo "installing to $DEST"

# Stream Deck holds file handles on a running plugin, so ask it to let go first.
if [[ -d "$DEST" ]]; then
  open_deep_link "streamdeck://plugins/stop/$PLUGIN_UUID" || true
  sleep 2
fi

# The plugin directory itself cannot be unlinked while Stream Deck has it open,
# even though everything inside it is writable -- so replace the contents in
# place rather than the folder. A file still locked by a not-quite-dead plugin
# process is the reason for the retry.
sync_contents() {
  mkdir -p "$DEST"
  find "$DEST" -mindepth 1 -delete 2>/dev/null || true
  cp -r "$SRC/." "$DEST/" 2>/dev/null || true
  diff -r --brief "$SRC" "$DEST" >/dev/null 2>&1
}

mkdir -p "$DEST_ROOT"
for attempt in 1 2 3; do
  if sync_contents; then
    echo "copied $(find "$DEST" -type f | wc -l) files"
    break
  fi
  if (( attempt == 3 )); then
    echo "error: could not write the plugin into place. Quit Stream Deck and re-run." >&2
    diff -r --brief "$SRC" "$DEST" >&2 || true
    exit 1
  fi
  echo "files still locked, retrying..." >&2
  sleep 2
done

if ! open_deep_link "streamdeck://plugins/restart/$PLUGIN_UUID"; then
  echo "note: could not open the reload link. Quit and reopen Stream Deck to load the plugin."
  exit 0
fi

set +e
await_reload
STATUS=$?
set -e

if (( STATUS == 1 )); then
  echo "developer mode had lapsed — re-enabling and retrying." >&2
  bash "$HERE/dev-mode.sh" >/dev/null
  LOG_MARK="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  open_deep_link "streamdeck://plugins/restart/$PLUGIN_UUID" || true
  set +e
  await_reload
  STATUS=$?
  set -e
fi

case $STATUS in
  0) echo "plugin reloaded and connected." ;;
  1) echo "note: reload still refused. Quit and reopen Stream Deck." >&2 ;;
  *) echo "asked Stream Deck to reload the plugin. Could not verify from here." ;;
esac
