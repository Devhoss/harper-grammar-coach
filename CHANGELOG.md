# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [0.1.0] - 2026-10-02

First packaged release.

- Offline grammar and spelling checking in the Hermes Desktop chat composer, driven by a
  single resident `harper-ls` process (LSP over stdio) reached through the dashboard API at
  `/api/plugins/harper-grammar-coach/`.
- Suggestions render in a native strip below the composer; high-confidence fixes can be
  applied on Enter. Nothing is uploaded and no text leaves the machine.
- `harper_ls_path` setting and `HARPER_LS_PATH` environment override for pointing at a
  different build.

[unreleased]: https://github.com/Devhoss/harper-grammar-coach/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Devhoss/harper-grammar-coach/releases/tag/v0.1.0
