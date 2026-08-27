# Third-party notices

## stream-deck-ai-limits

The usage keys in this plugin — everything under
`com.claudify.agents.sdPlugin/bin/lib/usage/`, plus the `ui/usage.html` settings
panel — are a port of
[stream-deck-ai-limits](https://github.com/Sing3Rous/stream-deck-ai-limits) by
David Utyuganov, rewritten from TypeScript into this plugin's plain-ESM
structure and reduced to the Claude provider. The endpoints, the OAuth flow, the
snapshot model, the caching and rate-limit rules, and the two key layouts are
all its work.

The macOS Keychain fallback in `usage/keychain.js` and `usage/credentials.js`
comes from two unmerged pull requests against that repository, which arrived at
the same design independently:

- [#4, Read Claude credentials from the macOS Keychain](https://github.com/Sing3Rous/stream-deck-ai-limits/pull/4) — darshjoshi
- [#2, Add macOS Keychain fallback for Claude credentials](https://github.com/Sing3Rous/stream-deck-ai-limits/pull/2) — khunjon

Both are contributions to an MIT-licensed repository and are covered by the
licence below.

```
The MIT License (MIT)

Copyright © 2026 David Utyuganov

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## ws

`com.claudify.agents.sdPlugin/bin/node_modules/ws` is fetched at install time
and ships with its own MIT licence in that directory.
