#!/usr/bin/env bash
# Follow the Stream Deck log, filtered to this plugin.
#
# Anything the plugin sends via logMessage lands here, as do the app's own
# notes about loading, reloading and launching it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

LOG="$(find_streamdeck_log)" || {
  echo "error: could not find StreamDeck.log; set STREAMDECK_LOG" >&2
  exit 1
}

echo "tailing $LOG" >&2
tail -n 200 -f "$LOG" | grep --line-buffered -iE 'claudify|claude-agents'
