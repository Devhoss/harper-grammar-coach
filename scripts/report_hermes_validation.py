"""Turn ``hermes plugins validate --json`` into a readable CI report.

The command already exits non-zero on failure, so this only makes the failure legible: the gate is a
list of named checks, and "Validation failed" without the failing line is a wasted log scroll.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path("hermes-validate.json")
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"::error::no validation report at {path}: the validate step never produced one", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"::error::{path} is not JSON ({exc}); the validate step died before reporting", file=sys.stderr)
        return 1

    lines = []
    for check in report.get("checks", []):
        mark = "✓" if check.get("ok") else "✗"
        lines.append(f"{mark} {check.get('name')}: {check.get('detail') or ''}".rstrip(": "))
    for warning in report.get("warnings", []):
        lines.append(f"⚠ {warning}")

    print("\n".join(lines))
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        Path(summary_path).write_text("## Hermes validation\n\n" + "\n".join(lines) + "\n", encoding="utf-8")

    if not report.get("ok"):
        failed = [check.get("name") for check in report.get("checks", []) if not check.get("ok")]
        print(f"::error::Hermes validation failed: {', '.join(failed) or 'no check reported'}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
