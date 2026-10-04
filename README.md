# Harper Grammar Coach

Grammar and spelling coaching for the Hermes Desktop chat composer, powered by
[Harper](https://github.com/Automattic/harper). It lints your draft as you type and opens a
composer popover for new suggestions. High-confidence fixes on Enter are optional and off by
default. **Everything runs on your machine** — no text is uploaded, and the engine is a local
subprocess, not a cloud API.

| | |
|---|---|
| Type | Unified Hermes plugin (agent + dashboard API + Desktop surface) |
| Engine | `harper-ls` over LSP/stdio, one resident process, reaped after 10 idle minutes |
| Networks | One: the pinned `harper-ls` release download, and only when you press **Install Harper** |
| License | MIT (this plugin) · Apache-2.0 (Harper, see [NOTICE](NOTICE)) |

## Install

Harper is one Git repository containing an Agent half and a Desktop half. The Agent half is
installed separately in each Hermes profile. On a local Hermes Desktop backend, Hermes
materializes one shared Desktop half from an installed Agent package. The Desktop half is
app-wide; it is not copied into each profile.

The public source repository is `Devhoss/harper-grammar-coach`.

### From the Hermes CLI

```bash
hermes plugins install Devhoss/harper-grammar-coach --enable
```

Run this in the profile that should use Harper. `--enable` enables its Agent half. If the
profile's gateway is already running and does not activate the new plugin immediately, restart
that gateway (or restart Hermes Desktop) so it mounts the plugin's dashboard API.

### From Hermes Desktop

Open **Capabilities ▸ Plugins ▸ Install from Git**, enter the public GitHub repository, choose
the target Agent profile, and select the Agent and Desktop halves. With a local backend, Hermes
installs the Agent package in that profile and materializes the Desktop half from that same Git
checkout. Enable the Agent and Desktop switches on the Plugins page as needed. The shared
Desktop half is not cloned a second time.

### Install into another Agent profile

The Agent half does not carry over when you switch profiles. Select the other profile in the
Agent column and use **Install from Git** for the same repository, or choose **Install here** on
the existing unified package row when that action is available. Hermes uses the package's Git
provenance and installs the Agent half into the selected profile; there is no folder-copy step.
Each profile has its own enable decision. The Desktop half remains shared by the app.

### First run: install the engine

The `harper-ls` binary is **not** in this repository. It is a large platform-specific
executable, so the plugin downloads the verified asset only when you request it. Fetch it
once, on purpose:

1. Open **Settings ▸ Appearance** in Hermes. Use the top-level Appearance page (not a
   deep-linked Appearance subpage), then scroll to the **Harper Grammar Coach** contribution.
2. Press **Install Harper** on its **Engine** row. This row is in Appearance settings, not in
   the plugin card's `config_schema` form under **Capabilities ▸ Plugins**.

That downloads the pinned release asset for your platform (~13–14 MB compressed), checks its
exact byte size against the release manifest, extracts the executable, and drops it into the
plugin's `vendor/` directory. The response reports which binary and version it installed.
Skip the download entirely if you already have a binary — see *Using your own harper-ls*.

Two more routes reach that same action, in case the Appearance page does not render the row:
the statusbar chip reads **Harper · Install required** while the binary is missing and its
popover carries an **Install Harper** button, and the command palette has **Harper: Install
Harper**. None of them fetches anything until you press one — there is no startup download.
None of them offers a download while the plugin's own API is unreachable either: the palette
row then reads **Harper backend unavailable**, and pressing it explains that instead of sending
a request the same backend could not answer. Once the API answers again, the next press installs.

Supported platforms for the automatic install: Windows x86_64, macOS Intel, macOS Apple
silicon, Linux x86_64, Linux ARM64. Anything else (e.g. Windows ARM64, musl/Alpine) is
refused with `unsupported-platform` rather than guessed at; use the setting below.

## Use

Type. When Harper finds suggestions, the composer shows **Harper · N** and opens a popover
with spelling, capitalisation and grammar rewrites plus their confidence levels. **Click a
row to apply that suggestion**: the correction row is one accessible button, and Ignore is a
separate control. **Apply all** stays at the top. The underside list remains available in
**Suggestion display** settings, and the statusbar provides fallback access when multiple
composer surfaces are mounted.

The statusbar chip names the state you are actually in — **Harper · Install required**,
**Starting**, **Ready**, **Unavailable**, **Too long**, or **Harper · N** with suggestions — and
it reads two separate things to decide: the *engine*, from the payload of the last request that
answered, and the *transport*, from whether any request answers at all. An empty composer is not
evidence that anything works, and neither is a `running` engine report from before the API stopped
answering, so the chip stays clickable whenever there is a reason and an action and only goes
inert text once a request has vouched for the backend.

Clicking it explains the specific problem. A missing binary reads *Harper engine is not
installed.* with the engine's own reason, **Install Harper** and **Retry**; the API not answering
reads *Harper backend is unavailable for the current Hermes backend.* with the HTTP condition,
the last-known `harper-ls` version and where its binary came from, and **Retry**. Neither one
shows what you were typing — no diagnostic surface in this plugin does.

**Harper: Diagnose** in the command palette reports that same state as a single line you can
paste into a bug report: whether the API answers and with which status, the engine state, the
`harper-ls` version, the binary's source and presence, the check count and last latency, and the
last error. It re-probes first, so the line describes the backend as of right now. Afterwards the
renderer keeps working on its own: while the API is filed as unreachable, the composer poll
re-checks it with a read-only `GET /status` about every 30 seconds, so a backend that comes back
restores the chip without a click.

The popover opens once for a new set of visible suggestions. Closing it keeps that set
dismissed through identical rechecks. A set is distinct when its rule, category, incorrect
word, or replacement changes; moving the same suggestion to a different offset does not reopen
it. An empty result resets the cycle. Applying a correction keeps the current open state and
verified remaining suggestions while Harper re-checks.

After you apply one, its row disappears immediately and the remaining rows stay on screen
while the updated draft is re-checked — the count reads `2 suggestions · checking…` instead
of blanking the list. Rows carried across that recheck are re-verified against the new text,
so an old suggestion can never be applied to a draft it was not computed for.

Your code and paths are left alone. Fenced blocks, inline `code`, URLs, Windows and Unix
paths, shell commands, package and file names, config keys and `camelCase`/`snake_case`
identifiers are recognised from **context**, not from a word list, and are never offered for
rewrite — by Harper suggestions or submit-time auto-fix. This draft:

```
I think the backend dont respond when I run `npm run dev` from E:\hermes\profiles\coder.
```

yields exactly one suggestion, `dont` → `don't`, and changes nothing inside the command or
the path. The same word is judged on its context — in this draft only the prose occurrence is
offered for rewrite, while the code span and the file name are not:

```
The config key is config, but `config` is code and config.yaml is a file.
```

The **Correct on send** switch is a manifest-backed setting in the Harper plugin's settings gear
under **Capabilities → Plugins**. It persists as `plugins.entries.harper-grammar-coach.settings.correct_on_send` and defaults to false. The renderer reads that saved value when a message is submitted. Other preference controls are in Harper's Appearance contribution:

- **Check while typing** on/off, with a **debounce** of Fast (400 ms) / Normal (700 ms) /
  Relaxed (1500 ms).
- **Correct on send** is **off by default**. Enable it to opt into
  eligible high-confidence prose corrections when sending. Categories (spelling,
  capitalisation, grammar rewrites) and **minimum confidence** (High or Medium) are
  configurable. Existing saved on/off preferences are preserved.
- **Dialect**: American, British, Canadian, Australian.
- **Engine**: state, version, dialect, check count and last check latency; **Install Harper**
  and **Restart** actions.

Applying a suggestion moves the caret to the end of the draft. That is a documented limit of
the composer API available to a plugin, not a choice made per case.

Palette commands: **Harper: Check draft now**, **Harper: Open suggestions**, **Harper: Apply
all suggestions**, and a toggle for live checking. Keyboard shortcuts are available for
opening suggestions and applying all.

### What Harper itself will not tell you

The engine is Harper (`harper-ls`), and the plugin shows what Harper returns — no more.
Measured on harper-ls 2.12.0: `Thiss is a sentenc whit two mistaks` produces three
suggestions, but `This are a simple test.` and `There is many reasons why this happens.`
produce nothing at all, because Harper's agreement rules cover pronoun-plus-*be*
(`I is ready.`, `He are working.`) and a bare plural (`There is dogs.`), not
demonstrative or quantified subjects. Nothing in this plugin's filtering or configuration can
recover a lint the engine never raises, and the plugin does not fake one with a model: it
reports what the engine saw (`diagnosticCount`) separately from what it filtered out
(`technicalSuppressed`), so an over-eager filter is visible instead of silent.

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
hermes plugins update harper-grammar-coach
hermes plugins uninstall harper-grammar-coach
```

Run those commands in the profile being updated or removed. To target a named profile from the
CLI, prefix either command with `hermes -p PROFILE`. Uninstalling removes that profile's
Agent half and its provenance record. The shared Desktop half remains while another profile
still has the package installed; Hermes removes it when no installed profile supplies it and
the Desktop plugin inventory is reconciled.

`harper_ls.py` owns the engine version pin, so a plugin update can move to a different
`harper-ls` release. The new binary is fetched on the next **Install Harper** action rather
than silently replaced under a running process. `vendor/` is gitignored and belongs to the
profile's plugin installation; it is not part of the Git repository.

## Troubleshooting

| Symptom | What it means |
|---|---|
| Settings section shows *no* engine row, or the composer never checks | The plugin's dashboard API is not mounted for this Hermes process. Enable the plugin, restart Hermes, and check `GET /api/plugins/harper-grammar-coach/status`. |
| Engine row reads `harper-ls not found` | Nothing was installed yet — press **Install Harper** (on that row, in the chip's popover, or as **Harper: Install Harper** in the palette), or set `HARPER_LS_PATH`. |
| Chip reads **Harper · Install required** but you cannot find the Settings row | Some Hermes builds do not render an Appearance contribution. The chip's popover and the palette command both install without it. |
| Chip reads **Harper · Unavailable** and the popover names the backend, not the engine | The plugin's dashboard API is not answering on this Hermes process. A `404`/`405` here means the router is absent, which is Hermes' plugin lifecycle, not a broken `harper-ls` — Harper reports it and cannot fix it. **Harper: Diagnose** prints the same state as one line; **Retry** and the periodic read-only `/status` probe both restore the chip once the API answers again, with no reinstall. |
| `harper_ls_path points at a missing file: …` | The configured path is wrong or the file was moved. Fix the path; the plugin will not substitute a different binary behind your back. |
| `unsupported-platform` | No pinned release asset for this OS/architecture. Install `harper-ls` yourself and point `HARPER_LS_PATH` at it. |
| `size-mismatch` on install | The download did not match the pinned byte size. Do not retry around it — something between you and GitHub changed the payload. |
| First check is slow, later ones are fast | Expected. Harper's dictionary warmup (~2 s) is paid once, at startup, not per keystroke. |
| A mistake you can see is not offered | Usually Harper, not the filter. `GET …/check` reports `diagnosticCount` (what Harper raised) and `technicalSuppressed` (what the plugin dropped as machine text); if both are 0 the engine never flagged it. See "What Harper itself will not tell you". |
| Long drafts stop getting suggestions | The text is truncated to a bound and the Harper UI says so; Harper re-parses the whole document per action, so cost grows with length. |
| Engine vanished after a while | It reaps itself after 10 minutes idle, by design, and restarts on the next check. |

## Known Hermes Desktop install blocker

On current Hermes builds, a normal **Install from Git** can be blocked by Hermes' plugin security scanner even though Harper itself is packaged and validated correctly. The current reproducible case reports three caution findings:

- **HIGH** `inline_shell_exec` at `technical_spans.py:34` — a false positive on the Markdown-backtick regex used to recognise inline code. This expression is not executable shell syntax.
- **MEDIUM** `python_subprocess` at `dashboard/plugin_api.py:341` — the required `harper-ls` process launch.
- **LOW** loopback URL fixture at `tests/test_technical_spans.py:106`.

The high finding causes the overall verdict to be **CAUTION**, so Hermes' normal community-source install gate reports **BLOCKED**. The same package can be installed with **Force reinstall**, which explicitly overrides that caution gate, and the plugin then loads normally. No Hermes-core or Harper-side scanner workaround is used by this repository.

This is a **Hermes scanner issue**, not a Harper Grammar Coach runtime failure. The plugin keeps the scanner-visible implementation unchanged rather than rewriting harmless code merely to evade the detector. Until Hermes correctly distinguishes regex syntax from executable inline-shell syntax, use the explicit force-install override only when you trust the repository. Once the Hermes scanner is fixed, the normal Git installation path should work without any Harper changes.

The blocker has been reproduced from both the Hermes CLI and the Desktop **Install from Git** flow. This note should remain until the upstream scanner behavior is corrected.

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
