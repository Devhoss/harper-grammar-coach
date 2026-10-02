# Security policy

Harper Grammar Coach is a local-only plugin: it checks the text you are composing by
running a language server on your own machine. This page states exactly what it does that
touches trust boundaries, so the claims can be checked rather than taken on faith.

## What the plugin does with your text

- Draft text is sent from the Desktop renderer to the plugin's own dashboard API
  (`/api/plugins/harper-grammar-coach/check`), which is served by the local Hermes process.
- That API passes the text to a `harper-ls` subprocess over stdio and returns Harper's
  diagnostics.
- Nothing is uploaded. There is no analytics, telemetry, crash reporting or update pinger
  in either half of the plugin. The only outbound network request the plugin can make is
  the pinned release download described below, and only when you ask for it.

## The engine download (`POST /bootstrap`)

`harper-ls` is not distributed in this repository. It is fetched on demand, and this is the
one code path in the plugin that has anything to do with the network:

- **User-triggered only.** Nothing runs at import time. A network fetch inside the
  dashboard's startup path would be slow and a surprise, so a missing binary is reported
  instead, and the UI offers to install one.
- **Fixed URL, built from an allowlist.** The URL is `harper_ls.RELEASE_URL_BASE` plus a
  filename taken from `harper_ls.RELEASE_ASSETS`, keyed by `(platform.system(),
  platform.machine())`. The caller supplies no URL, no version, and no body at all, so this
  endpoint cannot be turned into an arbitrary fetch.
- **Exact byte-size gate.** Each allowlisted asset carries the byte size recorded from the
  GitHub release manifest. A download whose length differs is rejected before anything is
  written. The request body cannot override the expected size; an earlier version let it,
  which would have let a caller bless a truncated or substituted archive by asking for
  exactly the bytes it sent.
- **Extracted in memory, then renamed into place.** The executable is pulled out of the
  `.zip`/`.tar.gz` in memory and written to a temporary file inside `vendor/`, then
  `os.replace`d into position. A half-written binary is never the one that gets spawned.
  On non-Windows the file is marked `0o755`; no elevated rights are requested anywhere.
- **Unsupported platforms are refused**, not guessed at: you get
  `reason: "unsupported-platform"` and the `HARPER_LS_PATH` escape hatch.

Review the pin before you trust it: `harper_ls.py` names the tag and the six asset sizes,
and GitHub's release page for that tag is the source of truth for them.

## The engine subprocess

- Spawned as `[binary, "--stdio"]` — an argument vector, never `shell=True`, so no command
  string is interpreted by a shell.
- `binary` comes from resolution order `HARPER_LS_PATH` → the `harper_ls_path` plugin
  setting → `vendor/harper-ls(.exe)` → `PATH`. An override that points at a missing file
  **fails loudly** rather than silently falling through to a different binary, so a typo
  cannot quietly swap in an unrelated `harper-ls` from elsewhere on `PATH`.
- Because `HARPER_LS_PATH` and the configured path are honored, treat them as you would any
  other executable path: pointing them at a binary you have not looked at is your call.

## Logging discipline

The plugin's own log statements carry exception text, timings and diagnostic *codes* only —
never draft content. Verified by `tests/test_hygiene.py`, which fails if the backend module
gains a log call that interpolates the checked text.

## The Desktop half

`desktop/plugin.js` runs as an ES module inside the Hermes Desktop renderer, which holds the
app's full authority. It therefore stays inside the constraints Hermes lints desktop surfaces
for: no dynamic code evaluation, no dynamic `import()` outside `@hermes/plugin-sdk` and
`react`, no script injection, no reaching into the application's own DOM, and no observing
`document.body`. It adds its own suggestion strip below the composer and edits text only
through the plugin SDK's own surface.

## Reporting a vulnerability

Report privately through [GitHub security advisories](https://github.com/Devhoss/harper-grammar-coach/security/advisories/new).
For issues in the grammar engine itself, file against
[Automattic/harper](https://github.com/Automattic/harper) — this plugin is a client of it,
and does not patch it.
