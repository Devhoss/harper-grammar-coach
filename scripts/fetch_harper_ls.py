#!/usr/bin/env python3
"""Fetch the pinned harper-ls binary the same way ``POST /bootstrap`` does.

For contributors and CI, so a development engine never has to be committed. It calls the
plugin's own code (:mod:`harper_ls`), which means it exercises the resolution order, the
allowlisted URL, the exact byte-size gate and the in-memory extraction rather than a
copy of them.

    python scripts/fetch_harper_ls.py                 # install into vendor/
    python scripts/fetch_harper_ls.py --verify-only   # download + check, write nothing
    python scripts/fetch_harper_ls.py --dest /tmp/bin # install somewhere else

Exits non-zero on any failure, printing the same ``reason`` codes the HTTP route returns.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import harper_ls  # noqa: E402  - needs the sys.path line above


def verify_only(dest: Path) -> int:
    """Download, gate on the pinned byte size, extract, report. Writes nothing."""
    asset_name, expected_bytes = harper_ls.platform_asset()
    if asset_name is None:
        print("unsupported-platform: no pinned asset for this machine", file=sys.stderr)
        return 2

    url = harper_ls.release_url(asset_name)
    print(f"asset   {asset_name}")
    print(f"url     {url}")
    print(f"expected {expected_bytes} bytes")

    try:
        request = urllib.request.Request(url, headers={"User-Agent": f"harper-ls-fetch/{harper_ls.HARPER_VERSION}"})
        with urllib.request.urlopen(request, timeout=300) as response:  # noqa: S310 - fixed https URL
            blob = response.read()
    except Exception as exc:  # noqa: BLE001
        print(f"download-failed: {exc}", file=sys.stderr)
        return 3

    if len(blob) != expected_bytes:
        print(f"size-mismatch: got {len(blob)}, expected {expected_bytes}", file=sys.stderr)
        return 4

    try:
        binary = harper_ls.extract_binary(blob, asset_name)
    except Exception as exc:  # noqa: BLE001
        print(f"extract-failed: {exc}", file=sys.stderr)
        return 5

    print(f"archive sha256 {hashlib.sha256(blob).hexdigest()}")
    print(f"binary  {len(binary)} bytes  sha256 {hashlib.sha256(binary).hexdigest()}")
    print(f"would install to {dest / harper_ls.binary_name()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dest", type=Path, default=None, help="directory to install into (default: vendor/)")
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="download, check the pinned size and extract, but write nothing",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-download even when a binary already resolves",
    )
    args = parser.parse_args(argv)

    dest = args.dest or harper_ls.VENDOR_DIR

    if args.verify_only:
        return verify_only(dest)

    existing, source = harper_ls.resolve_binary()
    if existing and not args.force:
        print(f"already available: {existing} (source: {source}) — nothing to do, use --force")
        return 0

    try:
        result = harper_ls.bootstrap(vendor_dir=dest, force=args.force)
    except harper_ls.BootstrapError as exc:
        print(f"{exc.reason}: {exc.message}", file=sys.stderr)
        return 1

    if not result.get("installed"):
        print(f"resolved without downloading: {result.get('binary')} (source: {result.get('source')})")
        return 0

    print(f"installed {result['binary']}")
    print(f"  version {result['version']}  asset {result.get('asset')}  {result.get('bytes')} bytes")
    digest = hashlib.sha256(Path(str(result["binary"])).read_bytes()).hexdigest()
    print(f"  sha256  {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
