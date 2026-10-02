"""Harper Grammar Coach — agent-side half of a two-surface plugin.

This package registers NOTHING. All three of the plugin's real jobs are done by files the
process that needs them discovers directly:

* ``harper_ls.py`` — the pinned harper-ls release, the per-platform asset allowlist, and the
  only code that may download a binary.
* ``dashboard/plugin_api.py`` — the offline Harper engine, mounted by the web server's
  dashboard scan at ``/api/plugins/harper-grammar-coach/``.
* ``desktop/plugin.js`` — the composer UI, loaded by the Electron renderer's plugin host.

Neither runs in an agent turn, and the plugin deliberately exposes no model tools: a
grammar coach that rewrote text on the model's behalf would be editing the user's words
from a place they cannot see. ``register()`` exists because the loader treats a discovered
``plugin.yaml`` with no register function as a failed plugin (``plugins_loader``:
"no register() function"), which would list this one as broken while both surfaces work.

Its presence also matters for packaging: ``detectPluginComponents`` reports ``agent: true``
only for a ``plugin.yaml`` + ``__init__.py`` pair, and that is what makes a git install of
this repo stamp the desktop half with its package marker — one Plugins row instead of two,
and opt-in instead of default-enabled.
"""

from __future__ import annotations


def register(ctx) -> None:
    """No agent-side registration; see the module docstring."""
    return None
