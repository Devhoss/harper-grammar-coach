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

### Changed
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
