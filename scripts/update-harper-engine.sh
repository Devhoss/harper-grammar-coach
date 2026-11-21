#!/usr/bin/env bash
# Update or reinstall the HARPER_LS_PATH binary that survives plugin updates.
#
# hermes plugins update replaces the whole plugin tree, so the vendored
# vendor/harper-ls.exe (and any plugin-dir binary) is deleted. Keep the
# executable OUTSIDE every profile tree and point HARPER_LS_PATH at it.
#
# Usage:
#   bash scripts/update-harper-engine.sh            # check latest GitHub release, download if newer
#   bash scripts/update-harper-engine.sh --force    # re-download even if current
#   bash scripts/update-harper-engine.sh 2.13.0     # pin a specific version
#
# Notes:
#   - Latest can be ahead of the plugin's pinned release (v2.12.0, v3.0.0). The pin
#     in harper_ls.py is only the download target for the normal Install path; with
#     HARPER_LS_PATH set the plugin runs whatever binary this script installs.
#   - Requires: curl, unzip/tar, and a GitHub token ONLY if rate-limited (set
#     GITHUB_TOKEN to raise the 60 req/hr limit).
#
# First run: set the env var in your profile's ~/.bashrc:
#   export HARPER_LS_PATH="E:/hermes/harper-bin/harper-ls.exe"
set -euo pipefail

BINS_DIR="${HARPER_BINS_DIR:-E:/hermes/harper-bin}"
BIN="$BINS_DIR/harper-ls.exe"
API="https://api.github.com/repos/Automattic/harper/releases"
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: token $GITHUB_TOKEN")

OS="$(uname -s | cut -c1-7)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  MINGW*|MSYS*|CYGWIN*) [ "$ARCH" = "x86_64" ] && ASSET="harper-ls-x86_64-pc-windows-msvc.zip" ;;
  Darwin/x86_64) ASSET="harper-ls-x86_64-apple-darwin.tar.gz" ;;
  Darwin/arm64) ASSET="harper-ls-aarch64-apple-darwin.tar.gz" ;;
  Linux/x86_64) ASSET="harper-ls-x86_64-unknown-linux-gnu.tar.gz" ;;
  Linux/aarch64) ASSET="harper-ls-aarch64-unknown-linux-gnu.tar.gz" ;;
  *) echo "unsupported: $OS/$ARCH (set HARPER_LS_PATH manually)" >&2; exit 2 ;;
esac

FORCE=""
PIN="${1:-}"
[ "$PIN" = "--force" ] && FORCE=1 && PIN=""

if [ -z "$PIN" ]; then
  LATEST="$(curl -fsSL "${AUTH[@]}" "$API/latest" | grep -oE '"tag_name":\s*"v[^"]+"' | head -n1 | sed -E 's/.*"v([^"]+)".*/\1/')"
  [ -z "$LATEST" ] && echo "could not read latest release" >&2 && exit 3
  PIN="$LATEST"
fi
PIN="${PIN#v}"

CURRENT=""
[ -f "$BIN" ] && CURRENT="$("$BIN" --version 2>/dev/null | awk '{print $2}')"
if [ "$CURRENT" = "$PIN" ] && [ -z "$FORCE" ]; then
  echo "harper-ls $PIN already installed at $BIN"
  exit 0
fi

mkdir -p "$BINS_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Use python's urllib (deterministic on this MSYS box, where the mingw curl build
# errors mid-body with "client returned ERROR on write"), and download from the
# tag page rather than the API path (`releases/download/<tag>/<asset>` 404s for
# the `harper-ls-*` assets even though they are attached: measured api 404,
# github.com 200). The file lands in the Python tempfile dir, NOT a shell
# `mktemp -d`: a native Windows Python maps /tmp to a path MSYS cannot write.
echo "downloading v$PIN $ASSET"
DEST="$(python -c "import tempfile, os; print(os.path.join(tempfile.mkdtemp(prefix='harper-dl-'), 'asset'))")"
python - "https://github.com/Automattic/harper/releases/download/v$PIN/$ASSET" "$DEST" <<'PY'
import sys, urllib.request
url, dest = sys.argv[1], sys.argv[2]
for attempt in range(1, 6):
    try:
        with urllib.request.urlopen(url, timeout=300) as resp, open(dest, "wb") as out:
            out.write(resp.read())
        sys.exit(0)
    except Exception as exc:
        print(f"  attempt {attempt} failed: {exc}", file=sys.stderr)
sys.exit(5)
PY
mkdir -p "$BINS_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ "${ASSET##*.}" = "zip" ]; then
  unzip -o -q "$DEST" -d "$TMP"
else
  tar -xzf "$DEST" -C "$TMP"
fi
SRC="$(find "$TMP" -type f \( -name 'harper-ls.exe' -o -name 'harper-ls' \) | head -n1)"
[ -n "$SRC" ] || { echo "harper-ls not found in $ASSET" >&2; exit 4; }
chmod +x "$SRC"
mv -f "$SRC" "$BIN"
echo "installed: $("$BIN" --version) -> $BIN"