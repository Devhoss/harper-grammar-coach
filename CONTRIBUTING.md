# Contributing

## Layout

```
plugin.yaml               native manifest: identity, kind, requires_hermes, config_schema
__init__.py               agent half — deliberately registers nothing, see its docstring
harper_ls.py              THE ENGINE PIN: version, per-platform asset allowlist + byte sizes,
                          resolution order, extraction, download
dashboard/manifest.json   dashboard surface; "api" points at plugin_api.py
dashboard/plugin_api.py   the LSP engine + the mounted HTTP routes
technical_spans.py        which spans of a draft are machine text, from context alone
desktop/plugin.js         the renderer half: composer strip and settings section
tests/                    pytest; no network, no real harper-ls
tests/renderer/           node:test for the renderer's pure helpers + one jsdom mount test
package.json              dev-only: the JS test harness. The plugin imports no dependency.
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

1. **No binary in the repository, ever.** The language server is a large, platform-specific
   executable. Users fetch the pinned release asset on demand through the plugin's checked
   bootstrap path. `vendor/` is gitignored; do not commit a local engine binary.
2. **Release facts live in exactly one place: `harper_ls.py`.** `plugin_api.py` must not
   learn a version string, an asset name or a URL. If you find yourself hardcoding `2.12.0`
   somewhere outside that module, that is the bug.
3. **Draft text never reaches a log line.** The engine sees the user's unpublished writing;
   log exception text, timings and diagnostic codes only.

## Setting up

Python 3.11+. The plugin has **no runtime dependencies of its own** — FastAPI and pydantic
are already present in the Hermes process that mounts it, which is also why `plugin.yaml`
declares `python_runtime: external`. Development, renderer validation, and Hermes validation
dependencies are listed in the `dev` extra and pinned by `uv.lock`:

```bash
uv sync --locked --extra dev
```

Activate the environment after syncing:

```bash
# Windows PowerShell
.venv\Scripts\Activate.ps1
# macOS / Linux
source .venv/bin/activate
```

The renderer tests need Node 22+ (they use the built-in `node:test` runner with a glob
argument). Nothing in the shipped plugin depends on it: `npm ci` installs jsdom, react and
react-dom as **devDependencies only**, pinned to the versions the host app uses so the mount
test exercises the same reconciler.

## Running the checks

```bash
pytest                       # unit + route tests; offline, no binary needed
ruff check .
python -m compileall -q harper_ls.py dashboard scripts tests
npm ci && npm test           # renderer: pure helpers + one jsdom mount
node --check desktop/plugin.js
```

All of them run in CI, along with `hermes plugins validate`. `node --check` is not
decoration: `desktop/plugin.js` is a single hand-authored ES module and a syntax error in it
fails the renderer's import silently — run it whenever you touch that file. Formatting is
not enforced (`ruff format` would reflow the engine's measured-number comments); lint is.

The renderer half is deliberately not under a bundler or a JSX transform, so it cannot import
test helpers either. `tests/renderer/` therefore reaches the real file through a
`module.register()` resolve hook that stubs only `@hermes/plugin-sdk` — the same import map the
Hermes renderer provides — and the assertions that matter (`survivorsAfterApply`,
`foldReplacements`, `pickForAutoFix`, the row's single control) run against the exported
functions in `plugin.js` itself. Do not add a build step to make testing easier; the file
being copy-paste-loadable by the host is the feature.

## Continuous integration

Two workflows, and the split is deliberate:

- **`ci.yml`** runs on every push and pull request: `ruff check`, `compileall`, the suite on
  Python 3.11–3.14 (3.11 is the declared floor, 3.14 is what Hermes ships on), and a Node 22
  job that runs `npm ci`, `node --check desktop/plugin.js` and `npm test`. Both jobs only reach
  a package registry; nothing in the pull-request path depends on the live Harper release.
  A third job compares the pin table against
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

The table's shape is checked offline; the live comparison in `tests/test_harper_ls.py` needs
`HARPER_PIN_TEST=1` and runs in the scheduled CI job, so a stale pin fails there rather than
silently on a user's machine. To move versions:

1. Open the release page for the new tag and read the asset name and size for each of the five
   release assets (`RELEASE_ASSETS` has six rows because `platform.machine()` reports Windows
   x86_64 as both `AMD64` and `x86_64`).
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
