# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-04

### Added
- `harper_ls.py` as the single source of truth for the pinned harper-ls release: the
  per-platform asset allowlist with exact release-asset byte sizes, binary resolution
  (env override → configured setting → `vendor/` → `PATH`), in-memory archive extraction,
  and the download itself.
- `scripts/fetch_harper_ls.py` for contributors and CI, so a development binary does not
  have to be carried in the repository.
- Test suite (`tests/`) covering the release pin, binary resolution, extraction, the
  HTTP surface, and the repository layout invariants a Hermes install depends on.
- CI: lint, tests on Python 3.11–3.14, and `node --check desktop/plugin.js`.
- A Hermes validation job that runs `hermes plugins validate` against a checkout of upstream
  Hermes — the catalog's own admission gate, security scanner and desktop-surface lint
  included — so those rules are enforced here rather than restated.
- A scheduled job that compares the release pin in `harper_ls.py` against the live Harper
  release and verifies the download, keeping the default CI path offline.
- `SECURITY.md`, `CONTRIBUTING.md`, `NOTICE`, `LICENSE`, and this changelog.
- `technical_spans.py`: which spans of a draft are machine text — fenced code, inline code,
  URLs, Windows/UNC/Unix paths, shell prompt lines, package and file names, config keys and
  `camelCase`/`snake_case` identifiers — decided from surrounding context, with no dictionary
  of protected words anywhere in it. The same function guards the strip and submit-time
  auto-fix.
- `technicalSuppressed` in the `/check` payload: how many diagnostics Harper raised that the
  plugin dropped as machine text. Together with `diagnosticCount` it separates "Harper found
  it, we filtered it" from "Harper never saw it", so an over-eager filter cannot hide.
- A renderer test harness: `package.json` (devDependencies only — the shipped plugin still
  imports nothing but `@hermes/plugin-sdk` and `react`) plus `tests/renderer/`, which loads the
  real `desktop/plugin.js` through a resolve hook that stubs the SDK, runs the pure helpers
  under `node:test`, and mounts the strip once under jsdom.
- `statusChipView`, the statusbar chip's label decision, and a **Harper: Install Harper** palette
  command. A fresh Git install deliberately has no `vendor/` binary, and some Hermes builds do not
  render the Appearance Engine row at all — so the chip and the palette are two more routes to the
  same explicit `/bootstrap`. Neither one downloads anything by itself.
- `Harper: Diagnose`, a palette command that reports the plugin's own technical state as one
  line: whether the API answers and with which HTTP status, the engine state, the `harper-ls`
  version, the binary's source and presence, the check count, the last check's latency, and the
  last error. It is a pure function of a snapshot that has no path to the composer, so the report
  cannot carry draft text — same rule as the log and the popover.

### Changed
- Composer suggestions now auto-open once when a new visible suggestion set appears. Closing a
  set keeps identical rechecks dismissed; a distinct set can open again, and an empty result
  resets the cycle. Applying a correction preserves the popover's current open state.
- Submit-time correction is now **off by default**. Existing saved `correctOnSend` values
  remain authoritative; only unset configurations adopt the new opt-in default.
- **Correct on send** is also declared as a persisted `correct_on_send` switch in the Desktop
  Plugins settings gear. Submit middleware reads that saved plugin setting before deciding
  whether to check or rewrite a draft; false passes the submitted text through unchanged.
- Popover auto-open prevents Radix's default focus transfer, leaving the composer ready for
  immediate typing. Applying a row returns focus through the supported composer API and
  prevents that deliberate focus return from dismissing the still-open suggestion popover.
- Suggestion rows are single accessible Apply controls with Ignore as a separate sibling
  button. Enter and Space use native button activation; no nested interactive controls are
  used.
- **The harper-ls binary is no longer part of the package.** It used to be committed under
  `vendor/`; a ~60 MB executable in a plugin tree trips Hermes' security scanner into a
  `caution` verdict, which makes the package uninstallable without `--force`. A fresh
  install now fetches the pinned release on the user's first explicit request instead.
- `/bootstrap` accepts no request body. Its optional `expectedBytes` override could be used
  to bless an archive whose size did not match the pin, which is precisely the check it was
  meant to be. The pinned size is now the only authority.
- `plugin.yaml` declares `python_runtime: external`. The contributor `pyproject.toml` would
  otherwise make this package a member of Hermes' shared Python environment, which it has
  nothing to contribute to.
- A suggestion **row is now the apply control**. Click anywhere on the row, or focus it and
  press Enter/Space, and that one suggestion is applied; the per-row Apply button is gone. The
  ignore icon at the right of the row is deliberately outside that target and independently
  focusable, so dismissing a suggestion can never mean applying it.
- Applying no longer blanks the strip. The applied row disappears at once, the rows that
  survived the edit stay on screen with their offsets re-verified against the new draft while
  the recheck runs, and the count reads `2 suggestions · checking…` until Harper's fresh
  answer arrives. A survivor whose text no longer matches is dropped rather than kept at a
  stale offset, so a click can never apply an old suggestion to a changed draft.
- The statusbar chip now reads the **engine**, not only the last draft check. Every poll of an
  empty composer resets the check state to idle, which is the normal state right after a restart,
  so a plugin with no `harper-ls` at all displayed an inert `Harper · Ready` and hid the only
  reachable install action. It reads **Harper · Install required** while no binary resolves,
  **Unavailable** while the engine cannot be started, and stays clickable in both cases, with the
  engine's own reason, **Install Harper** and **Retry** in its popover. `Harper · Ready` now
  requires evidence.
- It also reads the **transport**, separately. Engine metadata only ever came from a *successful*
  response, so when the plugin's API stopped being mounted under it the chip kept vouching for a
  backend that no longer answered. A `404`/`405` is now classified as an unreachable API — it
  outranks the stale engine report and the install claim, invalidates the ready state, and is
  retried with the same bounded ladder as a startup miss. The chip then explains itself
  (**Harper backend is unavailable for the current Hermes backend.**, the HTTP condition, the
  last-known version and binary source, **Retry**) and heals on its own: while unreachable, the
  composer poll issues one read-only `GET /status` about every 30 s, so a backend that comes back
  restores **Ready** without a click. A probe that reaches an API with no usable binary reports
  reachable and deliberately keeps the check gate latched, because reaching the backend and being
  able to check are different facts.
- The **Harper: Install Harper** palette row names the thing that is actually missing. While the
  API is unreachable it reads `Harper backend unavailable` instead of `engine not installed` —
  an unmounted router cannot prove the engine is absent, and it cannot serve a download either —
  and pressing it gives the backend-unavailable explanation rather than a doomed 240-second
  request. The Appearance **Engine** row goes through the same gate. It is a re-check, not a
  latch: once the API answers again, the next press installs.

## [0.1.0] - 2026-10-02

First packaged release.

- Offline grammar and spelling checking in the Hermes Desktop chat composer, driven by a
  single resident `harper-ls` process (LSP over stdio) reached through the dashboard API at
  `/api/plugins/harper-grammar-coach/`.
- Suggestions render in a native strip below the composer; high-confidence fixes can be
  applied on Enter. Nothing is uploaded and no text leaves the machine.
- `harper_ls_path` setting and `HARPER_LS_PATH` environment override for pointing at a
  different build.

[unreleased]: https://github.com/Devhoss/harper-grammar-coach/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Devhoss/harper-grammar-coach/releases/tag/v0.2.0
[0.1.0]: https://github.com/Devhoss/harper-grammar-coach/releases/tag/v0.1.0
