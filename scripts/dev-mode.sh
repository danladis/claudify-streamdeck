#!/usr/bin/env bash
# Toggle Stream Deck's developer mode.
#
# Developer mode is what lets the streamdeck:// deep links work, which is how
# scripts/install.sh reloads the plugin without restarting the whole app.
#
#   scripts/dev-mode.sh          enable
#   scripts/dev-mode.sh --off    disable
set -euo pipefail

VALUE=1
LABEL="enabled"
if [[ "${1:-}" == "--off" ]]; then
  VALUE=0
  LABEL="disabled"
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  defaults write com.elgato.StreamDeck developer_mode -bool "$([[ $VALUE == 1 ]] && echo true || echo false)"
elif command -v reg.exe >/dev/null 2>&1; then
  reg.exe add 'HKCU\Software\Elgato Systems GmbH\StreamDeck' \
    /v developer_mode /t REG_DWORD /d "$VALUE" /f >/dev/null
else
  echo "error: no way to reach Stream Deck's settings from here." >&2
  exit 1
fi

echo "Stream Deck developer mode $LABEL."
# Stream Deck reads this value when it handles a deep link, so the change is
# live -- but it also writes its own in-memory copy back on exit, which resets
# it. scripts/install.sh re-runs this whenever it finds a reload was refused.
echo "Takes effect immediately, but Stream Deck resets it when the app exits."
