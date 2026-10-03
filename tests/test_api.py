"""The mounted HTTP surface.

The engine is replaced by a recording stub (see ``conftest.client``), because every route is
a thin translation layer: request model in, one engine or ``harper_ls`` call, JSON out, with
``EngineError``/``BootstrapError`` mapped onto a status the renderer can act on. These tests
pin that contract — the renderer's behavior is built on the status codes and the reason
strings, not on the engine internals.
"""

from __future__ import annotations

import pytest

import harper_ls

PREFIX = "/api/plugins/harper-grammar-coach"
ROUTES = {f"{PREFIX}/{name}" for name in ("status", "warm", "check", "config", "restart", "bootstrap")}


# --- surface shape -----------------------------------------------------------


def _mounted(client) -> dict:
    """The declared HTTP surface of this mount, read from the OpenAPI document.

    The document is what a client actually sees and has the same shape on every FastAPI
    release; ``app.routes`` does not (an included router stopped being flattened into its
    parent), so walking it would pin an internal rather than the contract.
    """
    paths = client.app.openapi()["paths"]
    return {p: set(ops) for p, ops in paths.items() if p.startswith(PREFIX)}


def test_every_route_the_renderer_calls_is_present(client):
    assert set(_mounted(client)) >= ROUTES


def test_no_extra_route_leaks_into_this_mount(client):
    """The surface is exactly what the renderer uses; anything else is an unadvertised door.
    Only the read-only status is a GET, so no route here can be primed by a prefetch."""
    assert _mounted(client) == {
        f"{PREFIX}/status": {"get"},
        **{f"{PREFIX}/{name}": {"post"} for name in ("warm", "check", "config", "restart", "bootstrap")},
    }


def test_unknown_plugin_routes_are_not_part_of_this_router(client):
    assert client.post(f"{PREFIX}/nope").status_code == 404
    assert client.get(f"{PREFIX}/status").status_code == 200


# --- status / warm / restart -------------------------------------------------


def test_status_is_a_passthrough_and_never_starts_the_engine(client):
    body = client.get(f"{PREFIX}/status").json()
    assert body["version"] == "9.9.9"
    assert body["reason"] == "no harper-ls binary found"
    assert client.stub.calls == [("status", {})], "GET /status must not spawn or warm anything"


def test_warm_and_restart_reach_the_engine_once_each(client):
    assert client.post(f"{PREFIX}/warm").json()["state"] == "running"
    assert client.post(f"{PREFIX}/restart").json()["state"] == "idle"
    assert [name for name, _ in client.stub.calls] == ["warm", "restart"]


# --- check -------------------------------------------------------------------


@pytest.mark.parametrize("text", ["", "   ", "\n\t "])
def test_blank_drafts_are_answered_without_waking_the_engine(client, text):
    """The composer debounces but can still fire on a cleared draft; that must not be a
    subprocess round-trip, and it must not look like an error to the strip."""
    response = client.post(f"{PREFIX}/check", json={"text": text})
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "ok": True,
        "text": text,
        "suggestions": [],
        "diagnosticCount": 0,
        "technicalSuppressed": 0,
        "truncated": False,
        "engineMs": 0.0,
        "cached": False,
    }
    assert client.stub.calls == []


def test_check_forwards_the_text_and_the_default_budget(client, api):
    client.post(f"{PREFIX}/check", json={"text": "Thiss is a sentenc"})
    assert client.stub.calls == [("check", {"text": "Thiss is a sentenc", "budget_ms": api.ACTION_BUDGET_MS})]


def test_check_forwards_a_caller_budget_so_the_send_path_can_ask_for_less(client):
    client.post(f"{PREFIX}/check", json={"text": "fix me", "budgetMs": 250})
    assert client.stub.calls[-1] == ("check", {"text": "fix me", "budget_ms": 250})


def test_budget_and_text_are_bounded_at_the_edge(client, api):
    """The pydantic caps are a DoS bound, deliberately set above the engine's own limit so
    that "too long for Harper" is answered once, by the engine, with 413 + structured detail."""
    assert client.post(f"{PREFIX}/check", json={"text": "x", "budgetMs": api.MAX_ACTION_BUDGET_MS + 1}).status_code == 422
    assert client.post(f"{PREFIX}/check", json={"text": "x" * 200_001}).status_code == 422


def test_a_draft_over_the_engine_limit_still_reaches_the_engine(client, api):
    """Splitting one user-visible condition across two response shapes is the bug the generous
    model cap exists to prevent, so this boundary must stay on the engine side."""
    client.post(f"{PREFIX}/check", json={"text": "x" * (api.MAX_TEXT_CHARS + 1)})
    assert client.stub.calls[-1][1]["text"] == "x" * (api.MAX_TEXT_CHARS + 1)


def test_engine_failures_map_to_the_status_the_renderer_acts_on(client, api):
    """4xx means "your input, the engine is fine"; 503 means "Harper is unavailable".

    Collapsing the two would tell a user who pasted a very long draft that the plugin had
    crashed. This walks the module's own table, so a new reason cannot ship unmapped.
    """
    for reason, expected in api._CLIENT_ERROR_REASONS.items():
        client.stub.check = make_raise(api, reason)
        response = client.post(f"{PREFIX}/check", json={"text": "hello there"})
        assert response.status_code == expected, reason
        assert response.json()["detail"] == {"reason": reason, "message": "detail for the user"}


def make_raise(api, reason):
    def explode(_text, *, budget_ms=None):  # noqa: ARG001
        raise api.EngineError(reason, "detail for the user")

    return explode


def test_an_unavailable_engine_is_a_503(client, api):
    def dead(_text, *, budget_ms=None):  # noqa: ARG001
        raise api.EngineError("engine-dead", "harper-ls is not running")

    client.stub.check = dead
    response = client.post(f"{PREFIX}/check", json={"text": "hello there"})
    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "engine-dead"


# --- config ------------------------------------------------------------------


def test_config_without_a_dialect_is_a_read_of_the_same_status(client):
    assert client.post(f"{PREFIX}/config", json={}).json()["version"] == "9.9.9"
    assert [name for name, _ in client.stub.calls] == ["status"]


@pytest.mark.parametrize("dialect", ["American", "British", "Canadian", "Australian"])
def test_dialect_is_applied_and_echoed(client, dialect):
    assert client.post(f"{PREFIX}/config", json={"dialect": dialect}).json()["dialect"] == dialect


# --- bootstrap ---------------------------------------------------------------


def test_bootstrap_takes_no_input_the_caller_could_use_to_aim_the_download(client, monkeypatch):
    """No body, no arguments. The pinned allowlist chooses the URL and the size, so a hostile
    or merely buggy renderer cannot redirect the download or bless a mismatched payload."""
    seen: dict = {}

    def spy(*args, **kwargs):
        seen["args"] = args
        seen["kwargs"] = kwargs
        return {"ok": True, "installed": False, "binary": "/somewhere/harper-ls", "source": "path",
                "version": harper_ls.HARPER_VERSION}

    monkeypatch.setattr(client.stub, "restart", lambda: seen.setdefault("restarted", True))
    monkeypatch.setattr(harper_ls, "bootstrap", spy)

    response = client.post(f"{PREFIX}/bootstrap", json={"url": "https://evil.example/x", "expectedBytes": 1})
    assert response.status_code == 200
    assert seen["args"] == () and seen["kwargs"] == {}


def test_bootstrap_only_restarts_the_engine_when_it_installed_something(client, monkeypatch):
    monkeypatch.setattr(harper_ls, "bootstrap", lambda **kw: {"ok": True, "installed": False, "binary": "x"})
    client.post(f"{PREFIX}/bootstrap")
    assert [name for name, _ in client.stub.calls] == []

    monkeypatch.setattr(harper_ls, "bootstrap", lambda **kw: {"ok": True, "installed": True, "binary": "x"})
    client.post(f"{PREFIX}/bootstrap")
    assert [name for name, _ in client.stub.calls] == ["restart"]


def test_download_failures_come_back_as_structured_reasons(client, monkeypatch):
    for reason, status in [("unsupported-platform", 400), ("size-mismatch", 502), ("install-failed", 500)]:
        def raise_for(reason=reason, status=status):
            raise harper_ls.BootstrapError(reason, f"message about {reason}", status_code=status)

        monkeypatch.setattr(harper_ls, "bootstrap", raise_for)
        response = client.post(f"{PREFIX}/bootstrap")
        assert response.status_code == status
        assert response.json()["detail"]["reason"] == reason


def test_bootstrap_does_not_report_an_install_the_downloader_refused(client, monkeypatch):
    """A pre-existing binary is a no-op, reported as such: the settings row must not flip to
    "installed" when nothing was fetched."""
    monkeypatch.setattr(
        harper_ls, "bootstrap", lambda **kw: {"ok": True, "installed": False, "binary": "/p/harper-ls",
                                              "source": "vendor", "version": harper_ls.HARPER_VERSION}
    )
    body = client.post(f"{PREFIX}/bootstrap").json()
    assert body["installed"] is False and body["source"] == "vendor"
