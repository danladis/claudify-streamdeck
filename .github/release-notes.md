### What's new in v1.2.0

**A press now goes to the session's tab, not just its window.** A terminal
hosting six Claude sessions is one window as far as Windows is concerned, and
its title names only the tab in front — so a session waiting on you from a
background tab was unreachable, and the key raised the terminal on whatever tab
happened to be open. Claude Code titles each tab after the task it is working
on, and the key now finds that tab through the same accessibility interface a
screen reader uses, selects it, and then brings the window forward.

**And it stays with whoever needs you.** While any session is waiting on you,
pressing again moves between those and only those — never onto one that is
merely busy. When a single session needs you, pressing again keeps you on it.
Once nothing is waiting, presses cycle through the rest.

**Every press takes a fresh reading first.** The count behind a key is polled on
the **Refresh** interval — thirty seconds by default — and which session needs
you is exactly what changes in between. A press no longer acts on news that old.

Also in this release: the jump knows whether a session lives in a terminal or in
VS Code and raises the right one for it, and **Jump to the VS Code session that
needs you** and **…the terminal session that needs you** arrive as separate
**On press** options, for a key that only ever goes to one side. A path pasted
into the usage keys' **File** setting with quotes still around it is also
understood now, rather than being taken literally.

### Install

Download **com.claudify.agents.streamDeckPlugin** below and double-click it. The
Stream Deck app installs the plugin and asks nothing else of you.

Then drag any of **Claude Agents → Agent Count**, **Clawd**, **Usage Limits** or
**Usage (one window)** onto a key.

Needs the Stream Deck app 6.5 or newer, and Claude Code — on Windows either
natively or via WSL.
