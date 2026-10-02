"""Single source of truth for where ``harper-ls`` comes from.

Everything about the engine binary lives here: the pinned release, the per-platform
asset allowlist with the exact byte size of each asset, how a binary is located at
run time, and how a missing one is downloaded. ``dashboard/plugin_api.py`` consumes this
module and holds no release facts of its own, so bumping Harper means editing one table.

The release manifest this pins was verified against GitHub's
``Automattic/harper`` tag ``v2.12.0``; the byte sizes are the release asset sizes, not
guesses, so a truncated or substituted download is caught before anything is spawned.

The binary is NEVER part of this repository. ``POST /bootstrap`` (and
``scripts/fetch_harper_ls.py`` for development) install it into ``vendor/``, which is
gitignored. Three consequences worth knowing:

* A git clone of this repo has no engine until one is fetched, by design — an ~60 MB
  executable in a plugin repo trips Hermes' security scanner and makes the package
  uninstallable without ``--force``.
* Nothing here downloads implicitly. Locating a binary is pure filesystem work; the
  download path is only reachable from an explicit user trigger.
* An already-installed ``vendor/`` copy is reused, so bootstrap is idempotent.
"""

from __future__ import annotations

import os
import platform
import shutil
import tempfile
import urllib.request
from pathlib import Path
from typing import Dict, Optional, Tuple

PLUGIN_ID = "harper-grammar-coach"
PLUGIN_DIR = Path(__file__).resolve().parent
VENDOR_DIR = PLUGIN_DIR / "vendor"

HARPER_VERSION = "2.12.0"

#: ``(platform.system(), platform.machine())`` -> ``(release asset, exact byte size)``.
#: Keys are what ``platform.system()`` / ``platform.machine()`` actually report on those
#: builds; :func:`platform_asset` also tries the AMD64/x86_64 alias. Only assets that
#: exist in the pinned release are listed, which is why there is no Windows ARM64 entry.
RELEASE_ASSETS: Dict[Tuple[str, str], Tuple[str, int]] = {
    ("Windows", "AMD64"): ("harper-ls-x86_64-pc-windows-msvc.zip", 13_495_461),
    ("Windows", "x86_64"): ("harper-ls-x86_64-pc-windows-msvc.zip", 13_495_461),
    ("Darwin", "x86_64"): ("harper-ls-x86_64-apple-darwin.tar.gz", 13_827_650),
    ("Darwin", "arm64"): ("harper-ls-aarch64-apple-darwin.tar.gz", 9_617_607),
    ("Linux", "x86_64"): ("harper-ls-x86_64-unknown-linux-gnu.tar.gz", 14_453_853),
    ("Linux", "aarch64"): ("harper-ls-aarch64-unknown-linux-gnu.tar.gz", 9_908_659),
}

RELEASE_URL_BASE = f"https://github.com/Automattic/harper/releases/download/v{HARPER_VERSION}/"


class BootstrapError(RuntimeError):
    """A user-facing download failure. ``reason`` is a stable machine-readable code."""

    def __init__(self, reason: str, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.status_code = status_code


def binary_name() -> str:
    return "harper-ls.exe" if os.name == "nt" else "harper-ls"


def release_url(asset_name: str) -> str:
    return RELEASE_URL_BASE + asset_name


def configured_binary_path() -> str:
    """``plugins.entries.harper-grammar-coach.settings.harper_ls_path`` — the knob this plugin's
    ``config_schema`` declares. Read from the config file rather than through ``PluginContext``
    because both the dashboard web server and this module's own callers load it by path, where no
    plugin ctx exists; a declared setting nothing reads would be a knob that does not turn."""
    try:
        from hermes_cli.config import load_config_readonly

        entries = ((load_config_readonly() or {}).get("plugins") or {}).get("entries") or {}
        settings = (entries.get(PLUGIN_ID) or {}).get("settings") or {}
        value = settings.get("harper_ls_path")
    except Exception:
        return ""

    return value.strip() if isinstance(value, str) else ""


def resolve_binary() -> Tuple[Optional[str], str]:
    """``(path, source)`` for the harper-ls binary, or ``(None, reason)``.

    Order: explicit env override (lets a tester point at a custom build) -> the configured
    ``harper_ls_path`` setting -> the installed ``vendor/`` copy -> ``PATH``. A configured path
    that does not exist fails loudly instead of falling through, so a typo surfaces as the
    reason rather than as a silent downgrade to a different binary. Never downloads anything
    implicitly: a network fetch inside the dashboard's startup path is not acceptable, so a
    missing binary is reported and :func:`bootstrap` is the explicit, user-triggered way to
    fetch one.
    """
    for source, knob, override in (
        ("env", "HARPER_LS_PATH", os.environ.get("HARPER_LS_PATH", "")),
        ("config", "harper_ls_path", configured_binary_path()),
    ):
        override = override.strip()
        if not override:
            continue
        candidate = Path(override).expanduser()
        if candidate.is_file():
            return str(candidate), source
        return None, f"{knob} points at a missing file: {override}"

    vendored = VENDOR_DIR / binary_name()
    if vendored.is_file():
        return str(vendored), "vendor"

    on_path = shutil.which("harper-ls")
    if on_path:
        return on_path, "path"

    return None, (
        f"no harper-ls binary found (looked for HARPER_LS_PATH, harper_ls_path, {vendored}, "
        "and PATH). Run POST /bootstrap to download the pinned release."
    )


def platform_asset(
    system: Optional[str] = None, machine: Optional[str] = None
) -> Tuple[Optional[str], Optional[int]]:
    """The release asset for this machine, or ``(None, None)`` when Harper ships none.

    A pure lookup: the table lists every spelling this platform family reports (Windows gives
    ``AMD64``, Linux gives ``x86_64``) rather than guessing that a near neighbour will do. An
    alias fallback here would hand a Windows ARM64 or 32-bit x86 machine an x86_64 binary,
    which is a silently wrong download instead of the honest refusal the settings screen
    reports as ``unsupported-platform``.
    """
    asset = RELEASE_ASSETS.get((system or platform.system(), machine or platform.machine()))
    return asset if asset else (None, None)


def extract_binary(blob: bytes, asset_name: str) -> bytes:
    """Pull the harper-ls executable out of the release archive, in memory."""
    wanted = binary_name()

    if asset_name.endswith(".zip"):
        import io
        import zipfile

        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            for name in archive.namelist():
                if Path(name).name == wanted:
                    return archive.read(name)
        raise ValueError(f"{wanted} not found in {asset_name}")

    import io
    import tarfile

    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:*") as archive:
        for member in archive.getmembers():
            if member.isfile() and Path(member.name).name == wanted:
                handle = archive.extractfile(member)
                if handle is None:
                    continue
                with handle:
                    return handle.read()
    raise ValueError(f"{wanted} not found in {asset_name}")


def bootstrap(vendor_dir: Optional[Path] = None, force: bool = False) -> Dict[str, object]:
    """Download the pinned release into ``vendor/`` and return a status payload.

    The URL comes from the fixed per-platform allowlist, so a caller cannot turn this into
    an arbitrary fetch, and the byte size is checked against the release manifest before
    anything is written. The result is written to a temporary file in the destination
    directory and renamed into place, so a half-downloaded binary is never the one spawned.

    ``force`` skips the "already have one" shortcut, for a contributor re-fetching into a
    different directory. The HTTP route never uses it: pressing install when an engine
    already resolves should be a no-op, not a surprise re-download.
    """
    target_dir = vendor_dir or VENDOR_DIR
    if not force:
        existing, source = resolve_binary()
        if existing:
            return {
                "ok": True,
                "installed": False,
                "binary": existing,
                "source": source,
                "version": HARPER_VERSION,
            }

    asset_name, expected_bytes = platform_asset()
    if asset_name is None:
        raise BootstrapError(
            "unsupported-platform",
            f"no harper-ls release asset for {platform.system()}/{platform.machine()}; "
            "install harper-ls yourself and set HARPER_LS_PATH",
            status_code=400,
        )

    url = release_url(asset_name)
    target_dir.mkdir(parents=True, exist_ok=True)

    try:
        request = urllib.request.Request(url, headers={"User-Agent": f"{PLUGIN_ID}/{HARPER_VERSION}"})
        with urllib.request.urlopen(request, timeout=180) as response:  # noqa: S310 - fixed https URL
            blob = response.read()
    except Exception as exc:  # noqa: BLE001 - network failure is a user-facing condition
        raise BootstrapError("download-failed", f"{url}: {exc}") from exc

    # The pinned size is the only authority: an override from the request body would let a
    # caller bless a truncated or substituted archive by asking for exactly what it sent.
    if len(blob) != expected_bytes:
        raise BootstrapError(
            "size-mismatch",
            f"downloaded {len(blob)} bytes for {asset_name}, expected {expected_bytes}",
        )

    try:
        extracted = extract_binary(blob, asset_name)
    except Exception as exc:  # noqa: BLE001
        raise BootstrapError("extract-failed", f"{asset_name}: {exc}") from exc

    target = target_dir / binary_name()
    tmp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(target_dir), delete=False, suffix=".part") as handle:
            tmp_path = Path(handle.name)
            handle.write(extracted)
        if os.name != "nt":
            tmp_path.chmod(0o755)
        os.replace(str(tmp_path), str(target))
        tmp_path = None
    except OSError as exc:
        raise BootstrapError("install-failed", str(exc), status_code=500) from exc
    finally:
        if tmp_path is not None and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass

    return {
        "ok": True,
        "installed": True,
        "binary": str(target),
        "source": "vendor",
        "version": HARPER_VERSION,
        "asset": asset_name,
        "bytes": len(extracted),
    }
