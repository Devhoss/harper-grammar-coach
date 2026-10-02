# Harper Grammar Coach

Grammar and spelling coaching for the Hermes Desktop chat composer, powered by
[Harper](https://github.com/Automattic/harper). It lints your draft as you type, shows
suggestions in a strip below the composer, and can apply high-confidence fixes when you
press Enter. **Everything runs on your machine** — no text is uploaded, and the engine is a
local subprocess, not a cloud API.

| | |
|---|---|
| Type | Unified Hermes plugin (agent + dashboard API + Desktop surface) |
| Engine | `harper-ls` over LSP/stdio, one resident process, reaped after 10 idle minutes |
| Networks | One: the pinned `harper-ls` release download, and only when you press **Install Harper** |
| License | MIT (this plugin) · Apache-2.0 (Harper, see [NOTICE](NOTICE)) |

## Install

Either door installs the same complete package; use whichever you have.

### From the Hermes CLI

```bash
hermes plugins install Devhoss/harper-grammar-coach --enable
hermes gateway restart          # or restart the Hermes app
```

The restart is what mounts the plugin's dashboard API. Hermes mounts plugin API routes when
the server starts, so a freshly installed plugin answers 404 until then.

### From Hermes Desktop

**Capabilities ▸ Plugins ▸ Install from Git**, paste `Devhoss/harper-grammar-coach`, and
leave both halves ticked. For a local backend the desktop half is materialized out of the
same installed package rather than cloned separately, so one install gives you one row on the
Plugins page. Then flip the plugin's switch on that page and restart Hermes.

### First run: install the engine

The `harper-ls` binary is **not** in this repository — a ~60 MB executable in a plugin tree
trips Hermes' security scanner and makes the package uninstallable without `--force`. Fetch
it once, on purpose:

1. Open the Desktop settings section for this plugin (below the composer, or
   **Settings ▸ Plugins ▸ Harper Grammar Coach**).
2. Press **Install Harper** on the **Engine** row.

That downloads the pinned release asset for your platform (~13–14 MB compressed), checks its
exact byte size against the release manifest, extracts the executable, and drops it into the
plugin's `vendor/` directory. The response reports which binary and version it installed.
Skip the download entirely if you already have a binary — see *Using your own harper-ls*.

Supported platforms for the automatic install: Windows x86_64, macOS Intel, macOS Apple
silicon, Linux x86_64, Linux ARM64. Anything else (e.g. Windows ARM64, musl/Alpine) is
refused with `unsupported-platform` rather than guessed at; use the setting below.

## Use

Type. A strip appears under the composer with Harper's suggestions — spelling,
capitalisation and grammar rewrites — each with a confidence level and an **Apply** action.

Settings, all in the plugin's own settings section:

- **Check while typing** on/off, with a **debounce** of Fast (400 ms) / Normal (700 ms) /
  Relaxed (1500 ms).
- **Correct high-confidence issues on send**, per category (spelling, capitalisation,
  grammar rewrites), with a **minimum confidence** of High or Medium.
- **Dialect**: American, British, Canadian, Australian.
- **Engine**: state, version, dialect, check count and last check latency; **Install Harper**
  and **Restart** actions.

Palette commands: **Harper: Check draft now**, **Harper: Apply all suggestions**, and a
toggle for live checking.

## Using your own harper-ls

Two knobs, checked in this order, both without touching the plugin's code:

1. `HARPER_LS_PATH` — environment variable, absolute path to a binary. Wins over everything.
2. `harper_ls_path` — the plugin's own setting in `config.yaml`
   (`plugins.entries.harper-grammar-coach.settings.harper_ls_path`), editable from the CLI
   config or the plugin settings.

An override that points at a missing file **fails loudly** and is reported as the engine
reason; it does not quietly fall back to `vendor/` or `PATH`. If neither knob is set, the
plugin uses the `vendor/` copy it installed, then `harper-ls` on `PATH`.

## Updating and removing

```bash
hermes plugins update harper-grammar-coach   # pulls the pinned-source revision
hermes gateway restart
hermes plugins disable harper-grammar-coach
hermes plugins uninstall harper-grammar-coach
```

`harper_ls.py` owns the engine version pin, so a plugin update can move to a different
`harper-ls` release; the new binary is fetched on the next **Install Harper** press rather
than silently replaced under a running process. `vendor/` is gitignored and is yours to keep
across updates.

## Troubleshooting

| Symptom | What it means |
|---|---|
| Settings section shows *no* engine row, or the composer never checks | The plugin's dashboard API is not mounted for this Hermes process. Enable the plugin, restart Hermes, and check `GET /api/plugins/harper-grammar-coach/status`. |
| Engine row reads `harper-ls not found` | Nothing was installed yet — press **Install Harper**, or set `HARPER_LS_PATH`. |
| `harper_ls_path points at a missing file: …` | The configured path is wrong or the file was moved. Fix the path; the plugin will not substitute a different binary behind your back. |
| `unsupported-platform` | No pinned release asset for this OS/architecture. Install `harper-ls` yourself and point `HARPER_LS_PATH` at it. |
| `size-mismatch` on install | The download did not match the pinned byte size. Do not retry around it — something between you and GitHub changed the payload. |
| First check is slow, later ones are fast | Expected. Harper's dictionary warmup (~2 s) is paid once, at startup, not per keystroke. |
| Long drafts stop getting suggestions | The text is truncated to a bound and the strip says so; Harper re-parses the whole document per action, so cost grows with length. |
| Engine vanished after a while | It reaps itself after 10 minutes idle, by design, and restarts on the next check. |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, the test/lint commands, how to work
against a live Hermes profile, and how to bump the `harper-ls` pin.
Behavior notes and the design of the LSP layer live in the module docstrings —
`dashboard/plugin_api.py` explains why one resident server and why a fresh document uri per
check, which are the two things a reviewer is most likely to want to change.

## Reporting a problem

- Bugs and feature requests: open an [issue](https://github.com/Devhoss/harper-grammar-coach/issues).
  Please paste the JSON from `GET /api/plugins/harper-grammar-coach/status` — it names the
  binary, its source, the engine state and the last latency, which is most of the triage.
- Security issues: read [SECURITY.md](SECURITY.md) and report privately, not in an issue.

## License

Harper Grammar Coach is MIT-licensed. It drives `harper-ls`, copyright Automattic, under
Apache-2.0; the license text and attribution are in [NOTICE](NOTICE) and
`licenses/APACHE-2.0-harper-ls.txt`. Naming Harper is descriptive only and implies no
affiliation or endorsement.
