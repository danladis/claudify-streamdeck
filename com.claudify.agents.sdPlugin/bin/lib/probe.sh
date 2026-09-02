#!/bin/sh
# Snapshot of every live Claude Code session on this machine, as one JSON blob.
#
# Fed to `sh -s` on stdin through `wsl.exe`, so nothing has to be installed on
# the Linux side and no shell quoting crosses the Windows boundary. Placeholders
# are substituted by lib/probe.js before the script is piped in.
#
# WSL is the only host that needs this. Everywhere else the plugin is already a
# Node process on the machine Claude runs on and takes the same snapshot itself
# -- see lib/probe-native.js, which must keep answering exactly as this does.

CLAUDE_OVERRIDE='__CLAUDE_BIN__'
CWD_FILTER='__CWD_FILTER__'

find_claude() {
  # An explicit path is a promise, not a hint: if it is wrong, say so instead of
  # quietly counting agents from some other binary.
  if [ -n "$CLAUDE_OVERRIDE" ]; then
    [ -x "$CLAUDE_OVERRIDE" ] || return 1
    printf '%s' "$CLAUDE_OVERRIDE"
    return 0
  fi
  # `sh -s` under wsl.exe is not a login shell, so ~/.local/bin is usually
  # missing from PATH. Probe the standard install locations by hand.
  for candidate in \
    "$(command -v claude 2>/dev/null)" \
    "$HOME/.local/bin/claude" \
    "$HOME/.claude/local/claude" \
    /usr/local/bin/claude \
    /opt/homebrew/bin/claude
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

json_string() {
  # Minimal JSON string escaper for the diagnostic fields we emit.
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

# Output is a sequence of CLAUDIFY-<SECTION> markers, each followed by one JSON
# document. Keeping the sections separate means a job state file caught
# mid-write costs only that job's detail, not the whole reading.
CLAUDE="$(find_claude)"
if [ -z "$CLAUDE" ]; then
  printf 'CLAUDIFY-ERROR\n{"error":"claude-not-found"}\n'
  exit 0
fi

if [ -n "$CWD_FILTER" ]; then
  AGENTS="$("$CLAUDE" agents --json --cwd "$CWD_FILTER" 2>/dev/null)"
else
  AGENTS="$("$CLAUDE" agents --json 2>/dev/null)"
fi
STATUS=$?

if [ $STATUS -ne 0 ] || [ -z "$AGENTS" ]; then
  printf 'CLAUDIFY-ERROR\n{"error":"agents-command-failed","exitCode":%d,"claude":%s}\n' \
    "$STATUS" "$(json_string "$CLAUDE")"
  exit 0
fi

printf 'CLAUDIFY-META\n{"claude":%s}\n' "$(json_string "$CLAUDE")"
printf 'CLAUDIFY-AGENTS\n%s\n' "$AGENTS"

# Which of those sessions live inside VS Code? The extension host stamps its
# children's environment with VSCODE_* variables, and /proc keeps a copy for
# the life of the process -- so this needs no tool beyond the shell. The pid
# scrape leans on `claude agents --json` printing plain integer pids; a pid
# that fails the environ read (already gone, or not ours) is simply not listed.
VSCODE_PIDS=''
for pid in $(printf '%s\n' "$AGENTS" | grep -o '"pid"[ :]*[0-9]*' | grep -o '[0-9]*$'); do
  [ -r "/proc/$pid/environ" ] || continue
  if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -q '^VSCODE_'; then
    VSCODE_PIDS="$VSCODE_PIDS${VSCODE_PIDS:+,}$pid"
  fi
done
printf 'CLAUDIFY-CLIENTS\n{"vscodePids":[%s]}\n' "$VSCODE_PIDS"

# What each session's terminal tab is called. Claude Code titles the tab after
# the task and writes that same string into the session transcript as
# `aiTitle`, so the transcript is the only place a session id can be turned
# back into the title its tab is showing -- the session `name` is a different
# string entirely (cwd-derived for interactive sessions), and a window title
# only ever reflects the *active* tab. Without this a press can raise the right
# window and still leave you looking at the wrong tab.
#
# Read from the tail: the field is rewritten whenever the title changes and the
# transcript grows without bound, so the last occurrence is the current title.
# The value keeps its JSON escaping, which is exactly what re-emitting it
# inside quotes needs. A session too new to have been titled yet simply has no
# entry, and the plugin falls back to matching on window title alone.
TITLES=''
for sid in $(printf '%s\n' "$AGENTS" | grep -o '"sessionId"[ :]*"[0-9a-fA-F-]*"' | grep -o '[0-9a-fA-F-]\{36\}'); do
  for transcript in "$HOME"/.claude/projects/*/"$sid".jsonl; do
    [ -f "$transcript" ] || continue
    title="$(tail -c 65536 "$transcript" \
      | grep -o '"aiTitle"[ :]*"\([^"\\]\|\\.\)*"' \
      | tail -1 \
      | sed -e 's/^"aiTitle"[ :]*"//' -e 's/"$//')"
    [ -n "$title" ] || continue
    TITLES="$TITLES${TITLES:+,}\"$sid\":\"$title\""
    break
  done
done
printf 'CLAUDIFY-TITLES\n{"titles":{%s}}\n' "$TITLES"

# `claude agents --json` reports busy/idle but not *why* a background agent is
# idle. The per-job state file carries that ("tempo":"blocked", "needs":"..."),
# so ship it along and let the plugin join the two on sessionId.
for state in "$HOME"/.claude/jobs/*/state.json; do
  [ -f "$state" ] || continue
  printf 'CLAUDIFY-JOB\n'
  cat "$state"
  printf '\n'
done
printf 'CLAUDIFY-END\n'
