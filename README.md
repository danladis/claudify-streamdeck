# Claude Agent Status for Stream Deck

A Stream Deck plugin for keeping an eye on Claude Code. Four keys:

| Key | Shows |
| --- | --- |
| **Agent Count** | A live count of your running agents, on a ring that spins while they work and turns amber when one is waiting on you |
| **Clawd** | The same thing, as Claude Code's own mascot, wiggling along |
| **Usage Limits** | How much of your 5-hour and weekly Claude limits is spent, as two bars |
| **Usage (one window)** | One of those limits, large, with the time it resets |

The two usage keys read the same unofficial endpoint the `claude` CLI uses for
its own `/usage`, with the login it already has. Nothing to paste, nothing
stored — and nothing guaranteed: that endpoint is not a public API and can
change without notice.

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

Then, in the Stream Deck app, drag any of **Claude Agents → Agent Count**,
**Clawd**, **Usage Limits** or **Usage (one window)** onto a key.

`install-plugin` reloads via Stream Deck's `streamdeck://` deep links, which
need developer mode:

```sh
npm run dev-mode        # once; --off to undo
```

Without developer mode the copy still lands, but Stream Deck needs a quit and
reopen to pick it up.

## Configuring

Everything is a per-key setting in the Property Inspector (click the key in
Stream Deck), and the defaults work if Claude Code is installed the usual way.

The agent keys take a refresh interval, what counts as an agent, which face and
animation, what a press does, and how to reach Claude Code (auto-detects WSL on
Windows).

The usage keys take a refresh interval, the percentages the colours change at,
which window and reset format the single-window key shows, and — under
**Where the credentials are** — an override if your credentials file is
somewhere unusual. Leave that blank: the login is read from
`~/.claude/.credentials.json`, or from the login Keychain on macOS, where Claude
Code writes no file. Naming a path there turns the Keychain lookup off.

Every key can be **transparent**, **blue** or **gray**; transparent is the
default and lets the key show Stream Deck's own black.

### Polling and rate limits

The usage endpoint throttles hard — roughly five requests per five minutes,
then a 429 with a long `Retry-After` — so a minute is the floor on the refresh
interval, and every usage key on the deck shares one reading. When a refresh
does fail, the key keeps showing the last good numbers with a small dot in the
corner rather than blanking.

## Development

```sh
npm test                # unit tests
npm run simulate        # run the plugin against a fake Stream Deck
npm run preview         # render every key state to build/preview/index.html
npm run validate        # Elgato's manifest linter
npm run pack            # build a .streamDeckPlugin file
```

## Credits

The usage keys are a port of
[stream-deck-ai-limits](https://github.com/Sing3Rous/stream-deck-ai-limits) by
David Utyuganov, used under the MIT licence, with a macOS Keychain fix from two
unmerged pull requests against it and some additional coloring options. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
