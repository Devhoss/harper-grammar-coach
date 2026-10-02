# Contributing

## Layout

```
plugin.yaml               native manifest: identity, kind, requires_hermes, config_schema
__init__.py               agent half — deliberately registers nothing, see its docstring
harper_ls.py              THE ENGINE PIN: version, per-platform asset allowlist + byte sizes,
                          resolution order, extraction, download
dashboard/manifest.json   dashboard surface; "api" points at plugin_api.py
dashboard/plugin_api.py   the LSP engine + the mounted HTTP routes
desktop/plugin.js         the renderer half: composer strip and settings section
tests/                    pytest; no network, no real harper-ls
scripts/fetch_harper_ls.py  contributor/CI helper; same code path as POST /bootstrap
scripts/report_hermes_validation.py  makes `hermes plugins validate --json` legible in a log
.github/workflows/        ci.yml and hermes-validate.yml
licenses/                 third-party license text (Apache-2.0 for Harper)
vendor/                   gitignored. Where the engine binary goes at runtime.
```

`harper_ls.py` sits at the top level, not in `dashboard/`, because `plugin_api.py` is loaded
by path by the web server and reaches its sibling through a `sys.path` shim. It is also the
file a contributor wants when the question is "where does the binary come from", which is not
a dashboard question.

Three rules fall out of that layout and are worth internalizing before you change anything:

1. **No binary in the repository, ever.** A ~60 MB executable in a plugin tree makes Hermes'
   security scanner return a `caution` verdict (bundled binaries are warn-tier by design),
   which means the package cannot be installed without `--force` — and not installed at all
   from a non-interactive context, which includes the Desktop "Install from Git" dialog.
   `vendor/` is gitignored for that reason. Do not "temporarily" commit one to debug.
2. **Release facts live in exactly one place: `harper_ls.py`.** `plugin_api.py` must not
   learn a version string, an asset name or a URL. If you find yourself hardcoding `2.12.0`
   somewhere outside that module, that is the bug.
3. **Draft text never reaches a log line.** The engine sees the user's unpublished writing;
   log exception text, timings and diagnostic codes only.

## Setting up

Python 3.11+. The plugin has **no runtime dependencies of its own** — FastAPI and pydantic
are already present in the Hermes process that mounts it, which is also why `plugin.yaml`
declares `python_runtime: external`. For development you need pytest, ruff, and a FastAPI
to import against:

```bash
python -m venv .venv && .venv/Scripts/activate            # Windows; bin/ elsewhere
pip install -e '.[dev]' fastapi httpx
```

Or with no environment at all, if you have [uv](https://docs.astral.sh/uv/):

```bash
uv run --with pytest,fastapi,httpx pytest
uvx ruff check .
```

## Running the checks

```bash
pytest                       # unit + route tests; offline, no binary needed
ruff check .
python -m compileall -q .
node --check desktop/plugin.js
```

The first three run in CI, along with `hermes plugins validate`. `node --check` is not
decoration: `desktop/plugin.js` is a single hand-authored ES module and a syntax error in it
fails the renderer's import silently — run it whenever you touch that file. Formatting is
not enforced (`ruff format` would reflow the engine's measured-number comments); lint is.

## Continuous integration

Two workflows, and the split is deliberate:

- **`ci.yml`** runs on every push and pull request: `ruff check`, `compileall`, the suite on
  Python 3.11–3.14 (3.11 is the declared floor, 3.14 is what Hermes ships on), and
  `node --check desktop/plugin.js`. It is offline. A third job compares the pin table against
  the live Harper release and runs `fetch_harper_ls.py --verify-only`; it fires weekly and on
  `workflow_dispatch` only, because a red X that depends on github.com being up is a red X
  nobody can act on in review.
- **`hermes-validate.yml`** checks out `NousResearch/hermes-agent` at `main` and runs
  `hermes plugins validate .` from that source with a trimmed environment — no gateway, no full
  install, which is the configuration Hermes documents for this command. This is the gate the
  catalog uses to admit the plugin, including the security scanner and the desktop-surface lint,
  so the rules are not duplicated here and cannot drift from what an installer actually enforces.

`node --check` is not decoration: `desktop/plugin.js` is a single hand-authored ES module and a
syntax error in it fails the renderer's import silently — run it whenever you touch that file.
Formatting is not enforced (`ruff format` would reflow the engine's measured-number comments);
lint is.

Before opening a PR, run the validation job's command locally — it is stricter than
`hermes plugins install`, so a tree can install fine locally and still fail review:

```bash
hermes plugins validate .
```

## Working against a real Hermes

The plugin's two halves are discovered by two different processes, from two different
places, and each has its own enable switch. Knowing which one you are looking at saves an
hour:

- **Agent + dashboard half** — installed at `<HERMES_HOME>/plugins/harper-grammar-coach/`
  (for a profile: `<HERMES_HOME>/profiles/<name>/plugins/…`). Enabled by
  `plugins.enabled` in that profile's `config.yaml`. `plugin_api.py` is mounted by the
  dashboard web server at `/api/plugins/harper-grammar-coach/`, **at startup** — so after an
  install or enable you restart Hermes before the routes answer anything.
- **Desktop half** — the renderer does not read `plugins/`. On start it *materializes* a
  unified package's `desktop/` directory into `<HERMES_HOME>/desktop-plugins/<package>/`
  (note: app-level, **not** profile-scoped) and stamps a `.hermes-package.json` marker.
  Enabled state for it lives in renderer `localStorage`, per app, not in `config.yaml`.

Two consequences that bite:

- A materialized copy is only re-copied when the source `plugin.js` is **newer than the
  marker's recorded mtime**, so a same-length edit can look applied and not be. If the
  renderer seems to run old code, compare
  `<HERMES_HOME>/desktop-plugins/harper-grammar-coach/plugin.js` against your working copy
  before debugging further.
- The marker makes the desktop half **opt-in**: it will not self-activate just because the
  folder is there. Flip the switch on the Plugins page.

Fastest honest loop: install from a local clone so provenance and updates behave, then edit
`dashboard/` and restart; for `desktop/plugin.js`, edit, then re-materialize (restart the
app, or trigger the reconcile from the Plugins page) and confirm the bytes moved.

## Bumping the harper-ls pin

`tests/test_harper_ls.py` asserts the allowlist against the release manifest, so a stale pin
fails loudly. To move versions:

1. Open the release page for the new tag and read the asset names and sizes for the six
   supported targets.
2. Edit `HARPER_VERSION` and every entry in `RELEASE_ASSETS` in `harper_ls.py`. The docstring
   says where the numbers come from; keep that true.
3. `python scripts/fetch_harper_ls.py --verify-only` — downloads, checks the size gate,
   extracts, and prints the hash without installing anything.
4. Re-run the suite, then read `dashboard/plugin_api.py`'s module docstring: it names the
   three `harper-ls` protocol behaviors the engine depends on. If a release changes one of
   them, that is an engine change, not a version bump.

## Style

- `ruff` config lives in `pyproject.toml`: line length 120, rules `E,F,I,B`, `E501`/`E402`
  ignored. `UP` is deliberately off — the engine module is written in `typing.Optional`
  style and migrating ~80 annotations is its own change, not a packaging fix. Revisit it in
  a dedicated PR.
- Comments explain **why**, and the ones in this repo earn their space by recording measured
  numbers and protocol behavior that the code cannot express. Match that standard; do not add
  comments that restate the next line.
- No new runtime dependency, no download outside `harper_ls.py`, no `shell=True`, no
  reaching into the Hermes app's own DOM from `desktop/plugin.js`, and no import-time side
  effects in either half.

## Proposing changes

Open an issue first for anything that changes what the user sees or that touches the engine
lifecycle (process ownership, warmup, idle reaping, document uri handling). Those are the
parts with measurements behind them, and the reasoning is in the docstrings — read them
before proposing an alternative.
