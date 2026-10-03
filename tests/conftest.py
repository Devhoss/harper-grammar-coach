"""Shared fixtures.

``dashboard/plugin_api.py`` is not an importable package module — Hermes loads it by path
inside the web-server process, and the repository root is not a package either (a filesystem
plugin is a directory of two halves, not a wheel). The tests load it the same way the host
does, so they exercise the real import mechanics including the ``sys.path`` shim that lets it
reach its sibling ``harper_ls``.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_by_path(relative: str, module_name: str):
    path = ROOT / relative
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return ROOT


@pytest.fixture(scope="session")
def api():
    """The dashboard backend module, with no engine started and no binary required."""
    return load_by_path("dashboard/plugin_api.py", "harper_plugin_api")


@pytest.fixture
def client(api, monkeypatch):
    """A TestClient over the real router, with the engine replaced by a recording stub.

    Every route is a thin call into ``engine`` or ``harper_ls``, so stubbing the engine tests
    the HTTP contract (status codes, response shape, error mapping) without a subprocess.
    """
    fastapi = pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    class StubEngine:
        def __init__(self):
            self.calls: list[tuple[str, dict]] = []
            self.status_payload = {
                "ok": True,
                "engine": "harper-ls",
                "version": "9.9.9",
                "state": "idle",
                "binary": None,
                "binarySource": None,
                "reason": "no harper-ls binary found",
                "dialect": "American",
                "checks": 0,
                "lastCheckMs": 0.0,
                "warmupMs": 0.0,
                "uptimeSeconds": 0,
                "idleReapSeconds": 600.0,
                "stderr": None,
            }
            self.check_payload = {
                "ok": True,
                "text": "",
                "suggestions": [],
                "diagnosticCount": 0,
                "technicalSuppressed": 0,
                "truncated": False,
                "engineMs": 1.0,
                "cached": False,
            }

        def status(self):
            self.calls.append(("status", {}))
            return self.status_payload

        def warm(self):
            self.calls.append(("warm", {}))
            return {**self.status_payload, "state": "running"}

        def check(self, text, *, budget_ms=None):
            self.calls.append(("check", {"text": text, "budget_ms": budget_ms}))
            return {**self.check_payload, "text": text}

        def set_dialect(self, dialect):
            self.calls.append(("set_dialect", {"dialect": dialect}))
            return {**self.status_payload, "dialect": dialect}

        def restart(self):
            self.calls.append(("restart", {}))
            return self.status_payload

    stub = StubEngine()
    monkeypatch.setattr(api, "engine", stub)

    app = fastapi.FastAPI()
    app.include_router(api.router, prefix="/api/plugins/harper-grammar-coach")
    with TestClient(app) as test_client:
        test_client.stub = stub  # type: ignore[attr-defined]
        yield test_client
