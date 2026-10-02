"""Harper Grammar Coach backend — mounted at ``/api/plugins/harper-grammar-coach/``.

Owns ONE persistent ``harper-ls`` subprocess (LSP over stdio) and turns the Desktop
renderer's ``ctx.rest('/check')`` calls into grammar/spelling suggestions.

Why a persistent server and not ``harper-cli lint`` per call: measured on the target
machine, a fresh ``harper-cli`` process costs 2.1-2.3 s EVERY invocation (the dictionary
is loaded per process, nothing is cached across them), which cannot back a debounced live
check. One resident ``harper-ls`` pays ~2.2 s of dictionary warmup once at startup and then
answers a short draft in ~22-70 ms. That cost is not flat, though: Harper re-parses the whole
document for every ``textDocument/codeAction``, so a check is ``lint + (diagnostics x per-action
cost)``, and the per-action cost runs from ~14 ms at 1k chars to ~254 ms at 20k.
``ACTION_BUDGET_MS`` bounds the second term; the lint itself stays in a few hundred ms.

Three protocol facts this module depends on, all verified against harper-ls 2.12.0:

* The server sends ``workspace/configuration`` as a server->client REQUEST and BLOCKS until
  it is answered. Never answering means no diagnostics are ever published — the process
  looks dead while being perfectly healthy. It asks four times during startup alone.
* ``publishDiagnostics`` never carries a document ``version``, even when the client declares
  ``textDocument.publishDiagnostics.versionSupport``. Combined with the re-publish the
  server performs after each configuration answer, a reused document uri makes stale results
  indistinguishable from current ones. So every check gets its own uri. See
  :data:`DOC_URI_BASE`.
* Diagnostics for CLEAN text are published as an empty array, not omitted. A missing publish
  therefore always means "something went wrong", never "the draft is fine".

Diagnostics carry no replacement text; that only arrives from ``textDocument/codeAction``
(``edit.changes[uri][].newText``). The ``HarperIgnoreLint`` action additionally carries
Harper's ``priority``, ``lint_kind`` and a FLAT CHAR span, which is what makes confidence
filtering and offset conversion possible.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

router = APIRouter()

PLUGIN_ID = "harper-grammar-coach"

# Loaded by path from two different hosts (the dashboard web server, and a dev script), so the
# plugin root is not reliably on sys.path for a sibling import. Mirrors what the published
# filesystem plugins do.
_PLUGIN_DIR = Path(__file__).resolve().parent.parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

import harper_ls  # noqa: E402  - needs the sys.path shim above

# Every release fact (version, per-platform asset allowlist, byte sizes, download) lives in
# harper_ls.py, not here. Re-exported under the historical names so the engine and the routes
# read the same single source of truth.
HARPER_VERSION = harper_ls.HARPER_VERSION
VENDOR_DIR = harper_ls.VENDOR_DIR

# Every check runs on its OWN document uri (``hermes-composer-<n>.md``), opened, linted and
# closed in turn. A single reused uri is not viable: harper-ls re-lints after every
# ``workspace/configuration`` answer (it asks four times during startup alone) and republishes
# for the text that was current then, and it never echoes the document ``version`` in
# ``publishDiagnostics`` even when the client declares ``versionSupport``. With one uri those
# stale frames are indistinguishable from the answer, so each check consumes the PREVIOUS
# text's diagnostics — measured: check #1 returned 0 diagnostics, check #2 returned #1's 6,
# whose char spans then pointed at the wrong words. The uri is the only discriminator the
# server gives us, so the uri is what we match on.
DOC_URI_BASE = "file:///hermes-composer"
DOC_LANGUAGE_ID = "markdown"

# harper-ls blocks on this until the client answers. Omitted linters keep Harper defaults.
_HARPER_CONFIG_SECTION = {"dialect": "American", "linters": {}}

MAX_TEXT_CHARS = 20_000
MAX_DIAGNOSTICS = 40
MAX_SUGGESTIONS_PER_LINT = 4
#: Wall-clock ceiling on the codeAction phase of one check. Harper re-parses the WHOLE document
#: for every codeAction, so this is the only part of a check that grows with the draft: measured
#: on 2.12.0, one action averages ~14 ms at 1k chars, ~62 ms at 4k and ~254 ms at 20k. Times the
#: 40-diagnostic cap that is 0.6 s on a short draft and over 10 s on a long one, which no
#: composer UI can wait for. Work past the budget is SKIPPED, not failed: whatever resolved is
#: returned and ``truncated`` tells the renderer the list is partial.
ACTION_BUDGET_MS = 1_200
#: Upper bound a caller may ask for. Without it one POST /check could hold the engine lock (and
#: therefore every other check) for minutes.
MAX_ACTION_BUDGET_MS = 3_000
LSP_REQUEST_TIMEOUT = 5.0
START_TIMEOUT = 25.0
IDLE_REAP_SECONDS = 600.0
REAPER_POLL_SECONDS = 60.0
RESTART_WINDOW_SECONDS = 60.0
RESTART_LIMIT = 3

_EOF = object()


class EngineError(RuntimeError):
    """The engine could not answer. Carries a short user-facing ``reason``."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail or reason


# --- offset conversion -------------------------------------------------------
#
# Harper spans are Rust `char` (Unicode scalar) indices. The renderer is JavaScript,
# whose string indices are UTF-16 code units. Astral characters (emoji, most CJK
# extension B, mathematical symbols) are ONE char but TWO UTF-16 units, so handing the
# renderer raw char offsets makes `text.slice(start, end)` grab the wrong substring —
# and this plugin SPLICES TEXT, so a wrong offset corrupts the user's draft.


def utf16_map(text: str) -> Optional[List[int]]:
    """char index -> UTF-16 code-unit index, plus a terminal total at ``[len(text)]``.

    Returns ``None`` for BMP-only text, where the mapping is the identity. That is the
    overwhelmingly common case, and building an 8000-entry list per keystroke pause for
    nothing would be pure waste on the hot path.
    """
    if len(text.encode("utf-16-le")) == 2 * len(text):
        return None

    out: List[int] = []
    pos = 0
    for ch in text:
        out.append(pos)
        pos += 2 if ord(ch) > 0xFFFF else 1
    out.append(pos)
    return out


def to_utf16(mapping: Optional[List[int]], char_index: int) -> int:
    if mapping is None:
        return char_index
    if char_index < 0:
        return 0
    if char_index >= len(mapping):
        return mapping[-1]
    return mapping[char_index]


def char_line_starts(text: str) -> List[int]:
    """Char offset of the start of each line, for turning an LSP line/character position
    into a flat char offset when Harper's own flat span is unavailable."""
    starts = [0]
    idx = 0
    for ch in text:
        idx += 1
        if ch == "\n":
            starts.append(idx)
    return starts


def range_to_char_offset(position_range: Dict[str, Any], line_starts: List[int], key: str) -> Optional[int]:
    point = position_range.get(key)
    if not isinstance(point, dict):
        return None
    line = point.get("line")
    character = point.get("character")
    if not isinstance(line, int) or not isinstance(character, int):
        return None
    if line < 0 or line >= len(line_starts):
        return None
    return line_starts[line] + character


# --- classification ----------------------------------------------------------


def category_of(code: str, lint_kind: Optional[str]) -> str:
    """Bucket a lint into one of the three user-toggleable auto-fix categories.

    Harper's ``lint_kind`` is coarse (Spelling / Grammar / Style / Readability) and folds
    capitalisation into Grammar, so the rule code decides capitalisation; ``lint_kind``
    decides spelling when the code is not the canonical ``SpellCheck``.
    """
    lowered = (code or "").lower()
    if lowered == "spellcheck" or (lint_kind or "").lower() == "spelling":
        return "spelling"
    if "capital" in lowered:
        return "capitalisation"
    return "grammar"


# --- LSP framing -------------------------------------------------------------


def lsp_frame(payload: Dict[str, Any]) -> bytes:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    head = (
        "Content-Length: %d\r\n"
        "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n" % len(body)
    )
    return head.encode("ascii") + body


def read_frame(stream) -> Optional[Dict[str, Any]]:
    """Parse one LSP frame. ``None`` on clean EOF, ``EngineError`` on a malformed stream."""
    headers: Dict[bytes, bytes] = {}
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            break
        if b":" in line:
            key, value = line.split(b":", 1)
            headers[key.strip().lower()] = value.strip()

    raw_length = headers.get(b"content-length", b"0")
    try:
        length = int(raw_length)
    except ValueError as exc:
        raise EngineError("bad-frame", f"non-numeric Content-Length: {raw_length!r}") from exc
    if length <= 0:
        return {}

    body = b""
    while len(body) < length:
        chunk = stream.read(length - len(body))
        if not chunk:
            return None
        body += chunk

    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise EngineError("bad-frame", f"undecodable frame: {exc}") from exc


# --- binary resolution -------------------------------------------------------


# --- locating and fetching the binary ----------------------------------------
# That is harper_ls.py's job, entirely. This module deliberately holds no release facts:
# it calls ``harper_ls.resolve_binary()`` to find the engine and ``harper_ls.bootstrap()``
# to fetch it.


# --- the engine --------------------------------------------------------------


class HarperEngine:
    """One resident harper-ls, shared by every request.

    All protocol interaction happens under ``self._lock``, held for the whole
    didOpen -> publishDiagnostics -> codeAction sequence. Serialising is correct here:
    a warm check is tens of milliseconds so contention is invisible, and it removes every
    interleaving hazard (two lints racing for the same publish, or a code action asked about
    a document another thread already closed) plus the stdin write race — only the lock
    holder ever writes.

    The lock is REENTRANT because the ``*_locked`` helpers are written to be called by a
    holder, and the public entry points compose: ``warm``/``set_dialect`` finish by
    returning ``status()``, and ``status`` takes the lock itself to snapshot consistently.
    A plain ``Lock`` there deadlocks the very first request — the whole engine hangs with
    harper-ls alive and idle.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._proc: Optional[subprocess.Popen] = None
        self._inbox: "queue.Queue" = queue.Queue()
        self._stderr_tail: deque = deque(maxlen=32)
        self._next_id = 1
        self._uri_seq = 0
        self._open_uri: Optional[str] = None
        self._dead = False
        # Monotonic token identifying the CURRENT child process. Bumped by ``start_locked``
        # (a new process) and by ``_kill_locked`` (a process we retired), so a reader thread
        # still unwinding from an old process can tell it no longer speaks for the engine.
        self._session = 0
        self._binary: Optional[str] = None
        self._binary_source = ""
        self._dialect = "American"
        self._last_used = time.monotonic()
        self._restarts: deque = deque()
        self._started_at: Optional[float] = None
        self._checks = 0
        self._last_check_ms = 0.0
        self._warm_ms = 0.0
        self._reaper: Optional[threading.Thread] = None
        # Identical-text short circuit: re-focusing a composer or an unchanged draft must
        # cost zero subprocess work. Small LRU — drafts churn fast and a stale entry is
        # harmless only if it is keyed by the exact text.
        self._cache: "deque[Tuple[str, Any]]" = deque(maxlen=16)

    # -- lifecycle --

    def start_locked(self) -> None:
        """Spawn and initialise. Caller holds ``self._lock``."""
        if self._proc is not None and not self._dead:
            return

        # Only an UNEXPECTED death spends the crash budget. A cold start (plugin load) and a
        # deliberate one (stop, idle reap, dialect change) must not, or a user toggling the
        # dialect three times inside the window would wedge the engine into refusing to boot.
        if self._dead:
            self._note_restart()

        binary, source = harper_ls.resolve_binary()
        if binary is None:
            self._dead = True
            raise EngineError("binary-missing", source)

        self._binary = binary
        self._binary_source = source
        self._inbox = queue.Queue()
        self._stderr_tail = deque(maxlen=32)
        self._open_uri = None
        self._uri_seq = 0
        self._next_id = 1
        self._session += 1
        session = self._session
        inbox = self._inbox
        tail = self._stderr_tail

        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        try:
            self._proc = subprocess.Popen(  # noqa: S603 - fixed argv, resolved absolute path
                [binary, "--stdio"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
                creationflags=creationflags,
            )
        except OSError as exc:
            self._proc = None
            self._dead = True
            raise EngineError("spawn-failed", f"could not start {binary}: {exc}") from exc

        self._dead = False
        # Both loops take their process and buffers as ARGUMENTS. Reading them off ``self``
        # would let a thread outliving a teardown write into the next process's queue.
        threading.Thread(
            target=self._reader_loop,
            args=(self._proc, inbox, tail, session),
            name=f"harper-ls-reader-{session}",
            daemon=True,
        ).start()
        threading.Thread(
            target=self._stderr_loop,
            args=(self._proc, tail, session),
            name=f"harper-ls-stderr-{session}",
            daemon=True,
        ).start()
        self._ensure_reaper()

        try:
            self._handshake()
        except BaseException:
            self._kill_locked()
            raise

        self._started_at = time.monotonic()

    def _note_restart(self) -> None:
        """Bound restarts so a binary that dies on launch cannot become a spawn loop."""
        now = time.monotonic()
        while self._restarts and now - self._restarts[0] > RESTART_WINDOW_SECONDS:
            self._restarts.popleft()
        if len(self._restarts) >= RESTART_LIMIT:
            raise EngineError(
                "crash-loop",
                f"harper-ls restarted {len(self._restarts)} times in "
                f"{int(RESTART_WINDOW_SECONDS)}s; refusing to spawn again. Last stderr: "
                + (self._stderr_text() or "(empty)"),
            )
        self._restarts.append(now)

    def _handshake(self) -> None:
        result = self._request(
            "initialize",
            {
                "processId": os.getpid(),
                "rootUri": None,
                "capabilities": {},
                "workspaceFolders": None,
            },
            timeout=START_TIMEOUT,
        )
        if not isinstance(result, dict):
            raise EngineError("bad-initialize", f"unexpected initialize result: {result!r}")

        self._notify("initialized", {})
        # Pay Harper's dictionary warmup NOW, off the user's first keystroke burst. Linting a
        # real word (rather than "") is what forces the dictionary to load, which is the part
        # that costs the seconds; an empty document would warm nothing.
        #
        # This gets the startup budget, not the 5 s check budget, and a failure here is FATAL
        # rather than a warning. At 25 s (7x the measured warmup) a timeout means the binary is
        # genuinely broken, and reporting ``running`` for an engine that cannot lint would leave
        # the user with a plugin that fails every check and no explanation in settings.
        started = time.perf_counter()
        self._lint_locked("Harper", timeout=START_TIMEOUT)
        self._warm_ms = (time.perf_counter() - started) * 1000.0

    def _purge_locked(self) -> int:
        """Drop every frame already queued, so the next drain starts from a clean slate.

        Server->client requests are still answered on the way out — silently discarding a
        ``workspace/configuration`` request would block harper-ls forever, which is the
        failure mode this whole engine is built to avoid.
        """
        dropped = 0
        while True:
            try:
                message = self._inbox.get_nowait()
            except queue.Empty:
                return dropped
            if message is _EOF:
                self._inbox.put(_EOF)  # a death signal must survive the purge
                return dropped
            if "id" in message and "method" in message:
                self._answer_server_request(message)
            dropped += 1

    def _kill_locked(self, deliberate: bool = False) -> None:
        """Tear the child down. ``deliberate`` keeps the engine reporting ``idle`` instead of
        ``crashed`` — an idle reap or a dialect restart is not a failure, and telling the user
        it is would be a lie in the settings panel."""
        # Retire the session FIRST. Killing the child wakes its reader thread, which then runs
        # its ``finally`` block; the stale session is what stops that thread from overwriting
        # ``_dead`` here and reporting a deliberate shutdown as a crash.
        self._session += 1
        proc, self._proc = self._proc, None
        self._dead = not deliberate
        self._open_uri = None
        if proc is None:
            return
        try:
            if proc.poll() is None:
                # Best-effort clean LSP shutdown, then kill() as the backstop. Every step is
                # bounded: a wedged child must never hang the request thread.
                #
                # The frames go straight to the local handle rather than through ``_write``.
                # ``_write`` guards on ``self._proc``/``self._dead`` — both already cleared two
                # lines up — so routing through it raised ``engine-dead``, the raise was
                # swallowed by the except below, and ``_dead`` was left True. That silently
                # turned every deliberate stop into a reported crash AND skipped the graceful
                # shutdown entirely, so each teardown was a hard kill.
                try:
                    stdin = proc.stdin
                    if stdin is not None:
                        stdin.write(lsp_frame({"jsonrpc": "2.0", "id": self._take_id(), "method": "shutdown", "params": None}))
                        # LSP only terminates the process on ``exit``; ``shutdown`` alone leaves
                        # it parked, which would burn the whole wait timeout on every stop.
                        stdin.write(lsp_frame({"jsonrpc": "2.0", "method": "exit", "params": None}))
                        stdin.flush()
                    proc.wait(timeout=1.5)
                except Exception:  # noqa: BLE001 - teardown must never raise
                    pass
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2.0)
        except Exception as exc:  # noqa: BLE001
            log.warning("harper-ls teardown: %s", exc)
        finally:
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    if stream is not None:
                        stream.close()
                except Exception:  # noqa: BLE001
                    pass

    def stop(self) -> None:
        with self._lock:
            self._kill_locked(deliberate=True)

    def _ensure_reaper(self) -> None:
        if self._reaper is not None and self._reaper.is_alive():
            return

        def reap() -> None:
            while True:
                time.sleep(REAPER_POLL_SECONDS)
                with self._lock:
                    if self._proc is None:
                        return
                    if time.monotonic() - self._last_used > IDLE_REAP_SECONDS:
                        log.info("harper-ls idle for %.0fs, reaping", IDLE_REAP_SECONDS)
                        self._kill_locked(deliberate=True)
                        return

        self._reaper = threading.Thread(target=reap, name="harper-ls-reaper", daemon=True)
        self._reaper.start()

    def shutdown_at_exit(self) -> None:
        try:
            self.stop()
        except Exception:  # noqa: BLE001 - interpreter teardown
            pass

    # -- transport --

    def _reader_loop(self, proc: subprocess.Popen, inbox: "queue.Queue", tail: deque, session: int) -> None:
        """Drain stdout into ``inbox``. A blocking read must never sit on the request
        thread: that is how a silent server turns into a hung HTTP call.

        ``inbox``/``tail``/``session`` are CAPTURED rather than read from ``self``, because
        ``start_locked`` replaces both containers. A reader outliving a teardown would
        otherwise push ``_EOF`` into the NEXT engine's queue and mark a healthy process dead.
        Only the reader of the current session may report a death — which is precisely what
        separates "harper-ls crashed" from "we killed it on purpose".
        """
        stream = proc.stdout
        if stream is None:
            inbox.put(_EOF)
            return
        try:
            while True:
                frame = read_frame(stream)
                if frame is None:
                    break
                inbox.put(frame)
        except EngineError as exc:
            if session == self._session:
                tail.append(f"reader: {exc}")
        except Exception as exc:  # noqa: BLE001
            if session == self._session:
                tail.append(f"reader: {exc!r}")
        finally:
            if session == self._session:
                inbox.put(_EOF)
                self._dead = True

    def _stderr_loop(self, proc: subprocess.Popen, tail: deque, session: int) -> None:
        """Keep a bounded stderr tail. Without a reader the child blocks once it fills the
        OS pipe buffer, which presents as a hung engine with no explanation.

        Writes only while ``session`` is current, so a retired process cannot pollute the tail
        of the one that replaced it."""
        stream = proc.stderr
        if stream is None:
            return
        try:
            while True:
                line = stream.readline()
                if not line:
                    return
                text = line.decode("utf-8", "replace").rstrip()
                if text and session == self._session:
                    tail.append(text[-400:])
        except Exception:  # noqa: BLE001
            return

    def _stderr_text(self) -> str:
        return " | ".join(self._stderr_tail)[-800:]

    def _write(self, payload: Dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            self._dead = True
            raise EngineError("engine-dead", "harper-ls is not running")
        try:
            proc.stdin.write(lsp_frame(payload))
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            self._dead = True
            raise EngineError("engine-dead", f"write to harper-ls failed: {exc}") from exc

    def _take_id(self) -> int:
        value = self._next_id
        self._next_id += 1
        return value

    def _notify(self, method: str, params: Dict[str, Any]) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _answer_server_request(self, message: Dict[str, Any]) -> None:
        """harper-ls asks for ``workspace/configuration`` as a REQUEST and blocks until it is
        answered. Anything else server-initiated gets a null result so it cannot stall."""
        method = message.get("method")
        params = message.get("params") or {}
        if method == "workspace/configuration":
            items = params.get("items") or [None]
            count = len(items) if isinstance(items, list) else 1
            result: Any = [
                {"harper-ls": dict(_HARPER_CONFIG_SECTION, dialect=self._dialect)} for _ in range(count)
            ]
        else:
            result = None
        try:
            self._write({"jsonrpc": "2.0", "id": message.get("id"), "result": result})
        except EngineError:
            pass

    def _drain(self, predicate, timeout: float) -> Optional[Dict[str, Any]]:
        """Pull frames until ``predicate`` matches, answering server requests inline.

        Caller holds the lock, so this thread is the only consumer of ``_inbox`` and the
        only writer to stdin — the probe-verified shape that makes inline answering safe.
        """
        deadline = time.perf_counter() + timeout
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                raise EngineError("timeout", f"harper-ls did not respond within {timeout:.1f}s")
            try:
                message = self._inbox.get(timeout=remaining)
            except queue.Empty:
                raise EngineError(
                    "timeout",
                    f"harper-ls did not respond within {timeout:.1f}s. stderr: {self._stderr_text() or '(empty)'}",
                ) from None

            if message is _EOF:
                self._dead = True
                raise EngineError("engine-dead", f"harper-ls closed its output. stderr: {self._stderr_text() or '(empty)'}")

            # A server->client REQUEST has both an id and a method; a response has an id and
            # a result/error. Answering requests inline is mandatory (see module docstring).
            if "id" in message and "method" in message:
                self._answer_server_request(message)
                continue

            if predicate(message):
                return message

    def _request(self, method: str, params: Optional[Dict[str, Any]], timeout: float = LSP_REQUEST_TIMEOUT) -> Any:
        request_id = self._take_id()
        payload: Dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        self._write(payload)
        message = self._drain(lambda m: m.get("id") == request_id, timeout)
        if message is None:
            raise EngineError("timeout", f"no response to {method}")
        if "error" in message:
            error = message.get("error") or {}
            raise EngineError("lsp-error", f"{method} failed: {error.get('message') or error}")
        return message.get("result")

    # -- checking --

    def _lint_locked(self, text: str, timeout: float = LSP_REQUEST_TIMEOUT) -> List[Dict[str, Any]]:
        """Open ``text`` as a fresh document and return the diagnostics Harper publishes for it.

        The uri is allocated per call and matched in the drain predicate — see
        :data:`DOC_URI_BASE` for why a reused uri silently returns the previous text's
        diagnostics. The previous document is closed afterwards so the server never
        accumulates one open buffer per keystroke.

        ``timeout`` is a parameter because the pre-warm lint is not an ordinary check: it is
        the one that pays the 2-4 s dictionary load, and holding it to the 5 s user-facing
        budget makes it flake under load. A flaked pre-warm is worse than a slow one — the
        cost just moves onto the user's first keystroke instead.
        """
        self._purge_locked()

        previous = self._open_uri
        self._open_uri = None
        self._uri_seq += 1
        uri = f"{DOC_URI_BASE}-{self._uri_seq}.md"

        self._notify(
            "textDocument/didOpen",
            {"textDocument": {"uri": uri, "languageId": DOC_LANGUAGE_ID, "version": 1, "text": text}},
        )

        message = self._drain(
            lambda m: m.get("method") == "textDocument/publishDiagnostics"
            and (m.get("params") or {}).get("uri") == uri,
            timeout,
        )
        params = message.get("params") or {}
        diagnostics = params.get("diagnostics")

        # Only publish the buffer as open once the answer is in hand: a failure above must
        # not leave `_open_uri` pointing at a document we never got a result for.
        self._open_uri = uri
        if previous is not None:
            self._notify("textDocument/didClose", {"textDocument": {"uri": previous}})

        return diagnostics if isinstance(diagnostics, list) else []

    def _code_actions_locked(self, diagnostic: Dict[str, Any]) -> List[Dict[str, Any]]:
        result = self._request(
            "textDocument/codeAction",
            {
                # The document the diagnostics just came from; it is still open for exactly
                # this follow-up round trip.
                "textDocument": {"uri": self._open_uri or f"{DOC_URI_BASE}-0.md"},
                "range": diagnostic.get("range") or {},
                "context": {"diagnostics": [diagnostic]},
            },
        )
        return result if isinstance(result, list) else []

    def _cache_get(self, text: str) -> Optional[Any]:
        for index, (key, value) in enumerate(self._cache):
            if key == text:
                # Mark as most-recently-used.
                del self._cache[index]
                self._cache.appendleft((key, value))
                return value
        return None

    def _cache_put(self, text: str, value: Any) -> None:
        self._cache.appendleft((text, value))

    def check(self, text: str, budget_ms: float = ACTION_BUDGET_MS) -> Dict[str, Any]:
        """Full check: lint + code actions + offset conversion, or a cached answer.

        The cache is keyed on the text alone, not on ``budget_ms``: the only caller that asks
        for a smaller budget is the submit-time auto-fix, and by then the draft is leaving. A
        cached answer from a roomier budget is therefore never worse.
        """
        if not isinstance(text, str):
            raise EngineError("bad-input", "text must be a string")
        if len(text) > MAX_TEXT_CHARS:
            raise EngineError("too-long", f"text is {len(text)} chars (limit {MAX_TEXT_CHARS})")

        cached = self._cache_get(text)
        if cached is not None:
            return dict(cached, cached=True)

        started = time.perf_counter()
        with self._lock:
            self._last_used = time.monotonic()
            if self._proc is None or self._dead:
                self.start_locked()

            diagnostics = self._lint_locked(text)
            suggestions, truncated = self._build_suggestions(
                text, diagnostics[:MAX_DIAGNOSTICS], budget_ms=budget_ms
            )

            elapsed_ms = (time.perf_counter() - started) * 1000.0
            self._checks += 1
            self._last_check_ms = elapsed_ms

        payload = {
            "ok": True,
            "text": text,
            "suggestions": suggestions,
            "diagnosticCount": len(diagnostics),
            "truncated": truncated,
            "engineMs": round(elapsed_ms, 2),
            "cached": False,
        }
        self._cache_put(text, payload)
        return dict(payload)

    def _build_suggestions(
        self, text: str, diagnostics: List[Dict[str, Any]], budget_ms: float = ACTION_BUDGET_MS
    ) -> Tuple[List[Dict[str, Any]], bool]:
        """Merge each diagnostic with its code actions into one renderer-ready suggestion.

        Offsets are converted to UTF-16 HERE, not in the renderer: the plugin splices text
        with ``String.prototype.slice``, so a char/UTF-16 mismatch on an astral character
        would corrupt the draft. See :func:`utf16_map`.

        Returns ``(suggestions, truncated)``. ``truncated`` means the code-action budget ran out
        with diagnostics left over, so the list is partial. It cannot be ranked before paying:
        ``priority`` and ``lint_kind`` only exist inside the codeAction, never on the diagnostic
        (verified on 2.12.0), so the spans are resolved in document order and stopped on time.
        """
        mapping = utf16_map(text)
        line_starts = char_line_starts(text)
        out: List[Dict[str, Any]] = []
        deadline = time.perf_counter() + max(0.0, float(budget_ms)) / 1000.0
        truncated = False

        for diagnostic in diagnostics:
            if not isinstance(diagnostic, dict):
                continue
            if time.perf_counter() >= deadline:
                truncated = True
                break
            try:
                actions = self._code_actions_locked(diagnostic)
            except EngineError as exc:
                # A single unanswerable code action must not lose the whole check.
                log.debug("codeAction failed for %s: %s", diagnostic.get("code"), exc)
                actions = []

            position_range = diagnostic.get("range") or {}
            code = str(diagnostic.get("code") or "")
            priority: Optional[int] = None
            lint_kind: Optional[str] = None
            flat_span: Optional[Dict[str, Any]] = None
            replacements: List[str] = []

            for action in actions:
                if not isinstance(action, dict):
                    continue
                command_name, arguments = _action_command(action)

                if command_name == "HarperIgnoreLint" and isinstance(arguments, list) and len(arguments) >= 2:
                    meta = arguments[1]
                    if isinstance(meta, dict):
                        raw_priority = meta.get("priority")
                        priority = raw_priority if isinstance(raw_priority, int) else None
                        kind = meta.get("lint_kind")
                        lint_kind = kind if isinstance(kind, str) else None
                        span = meta.get("span")
                        flat_span = span if isinstance(span, dict) else None
                    continue

                # A quickfix: its edit is the replacement text. Harper returns several,
                # already ranked best-first, so the first N are the ones worth showing.
                edit = action.get("edit")
                if not isinstance(edit, dict):
                    continue
                changes = edit.get("changes")
                if not isinstance(changes, dict) or not changes:
                    continue
                for edits in changes.values():
                    if not isinstance(edits, list):
                        continue
                    for one in edits:
                        if isinstance(one, dict) and isinstance(one.get("newText"), str):
                            replacements.append(one["newText"])

            # Harper's own flat char span is authoritative (it is the internal Lint.span,
            # unambiguously char-based); the LSP line/character range is the fallback.
            start_char: Optional[int] = None
            end_char: Optional[int] = None
            if isinstance(flat_span, dict):
                raw_start, raw_end = flat_span.get("start"), flat_span.get("end")
                if isinstance(raw_start, int) and isinstance(raw_end, int) and raw_end > raw_start:
                    start_char, end_char = raw_start, raw_end
            if start_char is None:
                start_char = range_to_char_offset(position_range, line_starts, "start")
                end_char = range_to_char_offset(position_range, line_starts, "end")
            if start_char is None or end_char is None or end_char <= start_char:
                continue
            if start_char < 0 or end_char > len(text):
                continue

            matched = text[start_char:end_char]
            if not matched.strip():
                continue

            seen: set = set()
            unique: List[str] = []
            for replacement in replacements:
                # Never offer "replace X with X" — Harper emits those for some rules and a
                # no-op suggestion is a click that does nothing.
                if replacement == matched or replacement in seen:
                    continue
                seen.add(replacement)
                unique.append(replacement)
                if len(unique) >= MAX_SUGGESTIONS_PER_LINT:
                    break

            if not unique:
                continue

            out.append(
                {
                    "start": to_utf16(mapping, start_char),
                    "end": to_utf16(mapping, end_char),
                    "text": matched,
                    "code": code,
                    "message": str(diagnostic.get("message") or ""),
                    "severity": diagnostic.get("severity"),
                    "category": category_of(code, lint_kind),
                    "lintKind": lint_kind or category_of(code, lint_kind),
                    "priority": priority if priority is not None else 0,
                    "suggestions": unique,
                }
            )

        out.sort(key=lambda s: s["start"])
        return out, truncated

    # -- public surface --

    def status(self) -> Dict[str, Any]:
        binary, source = harper_ls.resolve_binary()
        with self._lock:
            running = self._proc is not None and not self._dead and self._proc.poll() is None
            return {
                "ok": True,
                "engine": "harper-ls",
                "version": HARPER_VERSION,
                "state": "running" if running else ("crashed" if self._dead else "idle"),
                "binary": binary,
                "binarySource": source if binary else None,
                "reason": None if binary else source,
                "dialect": self._dialect,
                "checks": self._checks,
                "lastCheckMs": round(self._last_check_ms, 2),
                "warmupMs": round(self._warm_ms, 1),
                "uptimeSeconds": round(time.monotonic() - self._started_at, 1) if self._started_at and running else 0,
                "idleReapSeconds": IDLE_REAP_SECONDS,
                "stderr": self._stderr_text() or None,
            }

    def warm(self) -> Dict[str, Any]:
        """Start the engine if it can start, and report why not if it cannot.

        Called by the renderer on plugin load. Failures are DATA here, not HTTP errors:
        a missing binary is an ordinary state the UI explains, not a 500.
        """
        with self._lock:
            self._last_used = time.monotonic()
            if self._proc is not None and not self._dead:
                return self.status()
            try:
                self.start_locked()
            except EngineError as exc:
                return dict(self.status(), ok=False, state="offline", reason=exc.detail)
            return self.status()

    def set_dialect(self, dialect: str) -> Dict[str, Any]:
        if dialect not in ("American", "British", "Canadian", "Australian"):
            raise EngineError("bad-input", f"unsupported dialect: {dialect}")
        with self._lock:
            if dialect == self._dialect:
                return self.status()
            self._dialect = dialect
            self._cache.clear()
            # Dialect is delivered through the workspace/configuration answer, which the
            # server requests at startup — so changing it means a restart.
            if self._proc is not None:
                self._kill_locked(deliberate=True)
        return self.warm()

    def restart(self) -> Dict[str, Any]:
        with self._lock:
            self._kill_locked(deliberate=True)
            self._restarts.clear()
            self._cache.clear()
        return self.warm()


def _action_command(action: Dict[str, Any]) -> Tuple[Optional[str], Any]:
    """Harper returns two action shapes: a quickfix carrying a NESTED ``command`` object,
    and a bare Command-shaped action (``HarperIgnoreLint``) whose ``command`` IS the string.
    Normalising both here is what keeps the priority/replace extraction honest."""
    command = action.get("command")
    if isinstance(command, dict):
        return command.get("command"), command.get("arguments")
    if isinstance(command, str):
        return command, action.get("arguments")
    return None, None


engine = HarperEngine()
atexit.register(engine.shutdown_at_exit)


#: Reasons that mean "the caller's input was unusable", mapped to 4xx. Everything else is a
#: degraded dependency and maps to 503.
_CLIENT_ERROR_REASONS = {"too-long": 413, "bad-input": 400}


def _http_error(exc: EngineError) -> HTTPException:
    """Map an :class:`EngineError` onto a status code the renderer can act on.

    The split matters: 503 means "Harper is unavailable, offer the settings hint", while 4xx
    means "your input, the engine is fine". Collapsing both into 503 would make a user who
    pasted a very long draft believe the plugin had crashed.

    503 rather than 500 for genuine engine failures, because an offline engine is a degraded
    dependency the UI can explain — and a traceback in the dashboard log for every keystroke
    pause would be pure noise.
    """
    status = _CLIENT_ERROR_REASONS.get(exc.reason, 503)
    return HTTPException(status_code=status, detail={"reason": exc.reason, "message": exc.detail})


# --- request models ----------------------------------------------------------


class CheckRequest(BaseModel):
    # The cap here is a hard DoS bound on the endpoint, deliberately far above MAX_TEXT_CHARS
    # so that the engine stays the single authority on "too long for Harper" and always
    # answers with the same 413 + structured detail. Letting pydantic reject at exactly the
    # engine limit would split one user-visible condition across two response shapes.
    text: str = Field(default="", max_length=200_000)
    # The renderer's own patience for the codeAction phase, in ms. It is a parameter because the
    # two callers have different budgets and both are honest: a live check can wait a second, the
    # send-time auto-fix must not delay the message. Absent means ACTION_BUDGET_MS.
    budget_ms: Optional[int] = Field(default=None, alias="budgetMs", ge=0, le=MAX_ACTION_BUDGET_MS)

    model_config = {"populate_by_name": True}


class ConfigRequest(BaseModel):
    dialect: Optional[str] = None


# --- routes ------------------------------------------------------------------


@router.get("/status")
def get_status() -> Dict[str, Any]:
    """Engine state. Cheap and side-effect free: does NOT start the process."""
    return engine.status()


@router.post("/warm")
def post_warm() -> Dict[str, Any]:
    """Start + pre-warm the engine (dictionary load happens here, ~2 s once)."""
    return engine.warm()


@router.post("/check")
def post_check(body: CheckRequest) -> Dict[str, Any]:
    text = body.text
    if not text.strip():
        return {
            "ok": True,
            "text": text,
            "suggestions": [],
            "diagnosticCount": 0,
            "truncated": False,
            "engineMs": 0.0,
            "cached": False,
        }
    budget = ACTION_BUDGET_MS if body.budget_ms is None else body.budget_ms
    try:
        return engine.check(text, budget_ms=budget)
    except EngineError as exc:
        raise _http_error(exc) from exc


@router.post("/config")
def post_config(body: ConfigRequest) -> Dict[str, Any]:
    if body.dialect is None:
        return engine.status()
    try:
        return engine.set_dialect(body.dialect)
    except EngineError as exc:
        raise _http_error(exc) from exc


@router.post("/restart")
def post_restart() -> Dict[str, Any]:
    try:
        return engine.restart()
    except EngineError as exc:
        raise _http_error(exc) from exc


@router.post("/bootstrap")
def post_bootstrap() -> Dict[str, Any]:
    """Download the pinned harper-ls release into ``vendor/``.

    Explicitly user-triggered only — nothing here runs at import time, because a network
    fetch inside the dashboard's startup path would be both slow and a surprise. The URL and
    the expected byte size come from the fixed per-platform allowlist in ``harper_ls``; this
    route accepts no body, so a caller cannot aim the fetch anywhere or bless a substituted
    archive by asking for exactly the bytes it sent.
    """
    try:
        result = harper_ls.bootstrap()
    except harper_ls.BootstrapError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"reason": exc.reason, "message": exc.message}
        ) from exc

    # The download is what a running engine was waiting for; pick it up now rather than
    # making the user press "check" twice.
    if result.get("installed"):
        engine.restart()
    return result
