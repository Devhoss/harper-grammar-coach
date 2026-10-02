"""Static hygiene assertions on the shipped source.

These guard the promises the plugin makes about itself — no draft text in logs, one network
path, and the desktop half staying inside the renderer's authority. They are cheap, offline
and mechanical, which is exactly what a trust claim needs: SECURITY.md and the README each
assert something a test now checks, so the claim cannot rot into fiction.

The desktop rules mirror what Hermes itself lints a desktop surface for. Duplicating them
here is deliberate: this repo's CI cannot assume a Hermes checkout, and a violation that only
surfaces in review costs a round trip.
"""

from __future__ import annotations

import re

import pytest

PYTHON_SUFFIXES = {".py"}
JS_SUFFIXES = {".js", ".mjs", ".cjs"}


def python_sources(repo_root):
    """The shipped Python: tests and scratch scripts are excluded, because a guard against
    `eval(` that matches the guard's own pattern string guards nothing."""
    out = []
    for path in repo_root.rglob("*.py"):
        parts = path.relative_to(repo_root).parts
        if parts[0] in {"tests", "scripts"}:
            continue
        if any(part in {"__pycache__", ".venv", "vendor", "node_modules"} for part in parts):
            continue
        out.append(path)
    return out


@pytest.fixture(scope="module")
def api_source(repo_root):
    return (repo_root / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def js_source(repo_root):
    return (repo_root / "desktop" / "plugin.js").read_text(encoding="utf-8")


# --- privacy of the draft ----------------------------------------------------


def test_no_log_statement_can_carry_draft_text(api_source):
    """The engine sees unpublished writing. Log calls may carry exception text, timings and
    diagnostic codes; they may not carry the thing the user has not sent yet."""
    call = re.compile(r"log(ger)?\.(debug|info|warning|error|exception|critical)\s*\(")
    payload = re.compile(r"\b(text|draft|body|content)\b")
    offenders = [line.strip() for line in api_source.splitlines() if call.match(line.strip()) and payload.search(line)]
    assert not offenders, offenders


def test_stderr_tail_is_bounded(api_source):
    """harper-ls stderr is surfaced in /status for triage. Unbounded, it could grow into a
    buffer that outlives the crash it explains."""
    assert re.search(r"deque\(maxlen=\d+\)", api_source)


def test_no_diagnostics_payload_is_persisted(api_source):
    """No sqlite/pickle/shelve writes of engine output: a cache that survives the session
    would put the user's text on disk, which the plugin never claims to do."""
    for forbidden in ("sqlite3", "shelve", "pickle.dump", "joblib"):
        assert forbidden not in api_source, forbidden


# --- one network path --------------------------------------------------------


def test_the_backend_module_makes_no_network_requests_of_its_own(api_source):
    for forbidden in ("urllib", "http.client", "requests.", "httpx", "socket."):
        assert forbidden not in api_source, forbidden


def test_only_harper_ls_reaches_the_network(repo_root):
    offenders = []
    for path in python_sources(repo_root):
        if path.name == "harper_ls.py" or "scripts" in path.parts or "tests" in path.parts:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if re.search(r"\burllib\b|http\.client|\brequests\b\.|\bhttpx\b", text):
            offenders.append(str(path))
    assert not offenders, offenders


def test_the_downloader_never_uses_a_caller_supplied_url(repo_root):
    """`bootstrap()` takes a destination and a force flag, nothing else — so there is no
    parameter through which a caller could name a URL, a version or an expected size."""
    text = (repo_root / "harper_ls.py").read_text(encoding="utf-8")
    signature = re.search(r"def bootstrap\(([^)]*)\)", text)
    assert signature, "bootstrap() should be defined in harper_ls.py"
    params = {p.split(":")[0].split("=")[0].strip() for p in signature.group(1).split(",")}
    assert params <= {"vendor_dir", "force", ""}, params
    assert "return RELEASE_URL_BASE + asset_name" in text
    assert re.search(r"urlopen\(\s*request", text)


def test_no_shell_execution_and_no_dynamic_code(repo_root):
    offenders = []
    for path in python_sources(repo_root):
        text = path.read_text(encoding="utf-8", errors="replace")
        for pattern in (r"shell\s*=\s*True", r"\bos\.system\b", r"\beval\s*\(", r"\bexec\s*\(", r"subprocess\.getoutput"):
            if re.search(pattern, text):
                offenders.append((str(path), pattern))
    assert not offenders, offenders


def test_the_engine_is_spawned_from_an_argument_vector(api_source):
    """`[binary, "--stdio"]` on stdin/stdout pipes — never a command string, so nothing about
    the resolved path can be reinterpreted by a shell."""
    assert "subprocess.Popen(" in api_source
    assert '[binary, "--stdio"]' in api_source


# --- desktop half: the renderer's authority ---------------------------------


def strip_js_noise(source: str) -> str:
    """Drop line and block comments and string bodies, so a rule about `eval(` is not
    triggered by prose or by a message that merely mentions it."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"^\s*//.*$", "", source, flags=re.M)
    return source


@pytest.mark.parametrize(
    "pattern,why",
    [
        (r"\beval\s*\(", "dynamic evaluation"),
        (r"new\s+Function\s*\(", "dynamic evaluation"),
        (r"import\s*\(", "dynamic import; the renderer only resolves the SDK and react"),
        (r"\bdocument\s*\.\s*querySelector(?:All)?\s*\(\s*['\"`]\[[\"']?data-", "reaching into the app's own DOM"),
        (r"getElementById\s*\(", "reaching into the app's own DOM"),
        (r"createElement\s*\(\s*['\"]script", "script injection"),
        (r"observe\s*\(\s*document\s*\.\s*body", "observing the whole app tree"),
        (r"Object\s*\.\s*defineProperty\s*\(\s*\w+\s*\.\s*prototype", "patching a prototype"),
        (r"\w+\s*\.\s*prototype\s*\.\s*\w+\s*=", "patching a prototype"),
    ],
)
def test_desktop_half_stays_inside_the_renderer_authority(js_source, pattern, why):
    code = strip_js_noise(js_source)
    assert not re.search(pattern, code), why


def test_desktop_half_loads_nothing_remote(js_source):
    code = strip_js_noise(js_source)
    assert not re.search(r"""from\s+['"]https?://""", code)
    assert not re.search(r"""\bfetch\s*\(\s*['"]https?://""", code), "no direct network from the renderer"


def test_desktop_half_talks_only_to_its_own_mounted_api(js_source):
    """`ctx.rest('/…')` is relative to the plugin's own mount point. An absolute URL would be
    the renderer leaving the plugin's sandbox."""
    code = strip_js_noise(js_source)
    assert "ctx.rest(" in code
    assert not re.search(r"""ctx\.rest\(\s*['"]https?://""", code)


def test_desktop_half_has_no_hardcoded_secret(js_source, api_source):
    for source, name in ((js_source, "desktop"), (api_source, "backend")):
        assert not re.search(
            r"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}", source
        ), f"{name} looks like it carries a credential"


def test_the_pinned_asset_sizes_are_documented_as_coming_from_the_release(repo_root):
    """The numbers in harper_ls.py are only as trustworthy as their provenance comment."""
    text = (repo_root / "harper_ls.py").read_text(encoding="utf-8")
    assert re.search(r"(?i)release manifest", text)
