# Shared helpers for locating and talking to Stream Deck. Sourced, not run.

PLUGIN_UUID="com.claudify.agents"
PLUGIN_ID="$PLUGIN_UUID.sdPlugin"

is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

# Windows' APPDATA, as a path this shell can use.
windows_appdata() {
  local appdata
  if command -v powershell.exe >/dev/null 2>&1; then
    appdata="$(powershell.exe -NoProfile -Command 'Write-Output $env:APPDATA' 2>/dev/null | tr -d '\r')"
    [[ -n "$appdata" ]] && { printf '%s' "$(wslpath -u "$appdata")"; return 0; }
  fi
  return 1
}

find_plugins_dir() {
  if [[ -n "${STREAMDECK_PLUGINS_DIR:-}" ]]; then
    printf '%s' "$STREAMDECK_PLUGINS_DIR"
    return 0
  fi
  if is_macos; then
    printf '%s' "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins"
    return 0
  fi
  local appdata candidate
  if appdata="$(windows_appdata)"; then
    printf '%s' "$appdata/Elgato/StreamDeck/Plugins"
    return 0
  fi
  for candidate in /mnt/c/Users/*/AppData/Roaming/Elgato/StreamDeck/Plugins; do
    [[ -d "$candidate" ]] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

find_streamdeck_log() {
  if [[ -n "${STREAMDECK_LOG:-}" ]]; then
    printf '%s' "$STREAMDECK_LOG"
    return 0
  fi
  if is_macos; then
    printf '%s' "$HOME/Library/Logs/ElgatoStreamDeck/StreamDeck0.log"
    return 0
  fi
  local appdata candidate
  if appdata="$(windows_appdata)"; then
    printf '%s' "$appdata/Elgato/StreamDeck/logs/StreamDeck.log"
    return 0
  fi
  for candidate in /mnt/c/Users/*/AppData/Roaming/Elgato/StreamDeck/logs/StreamDeck.log; do
    [[ -f "$candidate" ]] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

open_deep_link() {
  local url="$1"
  if is_macos; then
    open "$url" >/dev/null 2>&1
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Start-Process '$url'" >/dev/null 2>&1
  else
    return 1
  fi
}
