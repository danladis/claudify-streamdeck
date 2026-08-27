# Claude Agent Status for Stream Deck

A Stream Deck plugin that shows a live count of your running Claude Code
agents — a spinning ring, or Claude Code's own mascot — turning amber
when one is waiting on you.

## Supported

| Host | Status |
| --- | --- |
| WSL (Claude Code on Windows, via WSL) | ✅ Supported |
| Windows (Claude Code installed natively, no WSL) | ❔ Not yet — the probe assumes a POSIX shell, which native Windows doesn't have |
| Linux (Claude Code installed natively) | ❔ Not yet — Stream Deck itself has no official Linux release |
| macOS (Claude Code installed natively) | ✅ Supported |

## Install

Requires the Stream Deck app already installed and running, and Node.

```sh
npm run deps            # fetch the plugin's one runtime dependency (ws)
npm run install-plugin  # copy the plugin into Stream Deck and reload it
```

Then, in the Stream Deck app, drag **Claude Agents → Agent Count** (or
**Clawd**) onto a key.

`install-plugin` reloads via Stream Deck's `streamdeck://` deep links, which
need developer mode:

```sh
npm run dev-mode        # once; --off to undo
```

Without developer mode the copy still lands, but Stream Deck needs a quit and
reopen to pick it up.

## Configuring

Everything is a per-key setting in the Property Inspector (click the key in
Stream Deck) — refresh interval, what counts as an agent, which face and
animation, on-press behaviour, and how to reach Claude Code (auto-detects WSL
on Windows). Defaults work if Claude Code is installed the usual way.

## Development

```sh
npm test                # unit tests
npm run simulate        # run the plugin against a fake Stream Deck
npm run preview         # render every key state to build/preview/index.html
npm run validate        # Elgato's manifest linter
npm run pack            # build a .streamDeckPlugin file
```
