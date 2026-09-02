### What's new in v1.2.1

**A security fix.** The **Claude binary** and **Folder** key settings are pasted
into the small script the plugin runs inside WSL, and a value containing certain
punctuation could escape the quotes around it and run as commands. Settings travel inside a shared Stream Deck profile, so importing
someone else's profile was enough to be caught by this — it was not only a way
to hurt yourself. Both values are now inserted literally and can no longer be
anything but text.

Present since v1.0.0. The same hazard in the jump-to-a-session code was fixed in
v1.2.0; this is its twin, missed at the time.

Nothing else changed, and there is nothing you need to do differently. If you
have never pasted anything unusual into those two boxes, and never imported a
profile from someone else, you were never affected.

### Install

Download **com.claudify.agents.streamDeckPlugin** below and double-click it. The
Stream Deck app installs the plugin and asks nothing else of you.

Then drag any of **Claude Agents → Agent Count**, **Clawd**, **Usage Limits** or
**Usage (one window)** onto a key.

Needs the Stream Deck app 6.5 or newer, and Claude Code — on Windows either
natively or via WSL.
