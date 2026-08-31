### What's new in v1.1.0

**Claude Code installed natively on Windows now works.** The Agent Count and
Clawd keys used to assume a POSIX shell, which native Windows does not have, so
they only ever worked through WSL. They now take the reading in the plugin
itself — no shell — and a press opens Windows Terminal (falling back to `cmd`)
instead of a distro shell. Set **Where Claude runs → Host** to **This machine**;
**Auto** still means WSL on Windows, so nothing changes for an existing key.
The two usage keys already worked either way.

Also in this release: Clawd throws a party when an agent finishes, an **Only
running** count mode that leaves idle sessions out of the number, slow / normal /
fast animation speeds, usage keys that leave a sleeping WSL alone, and a
double-clickable installer attached to every release.

### Install

Download **com.claudify.agents.streamDeckPlugin** below and double-click it. The
Stream Deck app installs the plugin and asks nothing else of you.

Then drag any of **Claude Agents → Agent Count**, **Clawd**, **Usage Limits** or
**Usage (one window)** onto a key.

Needs the Stream Deck app 6.5 or newer, and Claude Code — on Windows either
natively or via WSL.
