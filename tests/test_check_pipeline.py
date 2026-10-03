"""RED: the check funnel must drop diagnostics that land inside a protected span.

Two seams are stubbed and nothing else is: ``_lint_locked`` (what harper-ls published) and
``_code_actions_locked`` (the expensive round trip per diagnostic). Everything between them —
span resolution, offset conversion, dedup, and the filter under test — is the production code
path, so these tests also pin the ORDER: the filter must run before the codeAction for the
drafts where that is provably safe, and always after the span is resolved.

Action shapes are the ones measured on harper-ls 2.12.0: a quickfix whose edit carries
``newText``, and a bare ``HarperIgnoreLint`` command whose second argument carries
``priority``, ``lint_kind`` and the authoritative flat CHAR span.
"""

from __future__ import annotations

import pytest

DOC_URI = "file:///hermes-composer-1.md"

MIXED = "I think the backend dont respond when I run `npm run dev` from E:\\hermes\\profiles\\coder."


def utf16_range(text: str, start: int, end: int) -> dict:
    """An LSP range in UTF-16 code units, the way the protocol actually counts."""
    def units(index: int) -> tuple:
        before = text[:index]
        line = before.count("\n")
        column = before[before.rfind("\n") + 1 :]
        return line, len(column.encode("utf-16-le")) // 2

    line, character = units(start)
    end_line, end_character = units(end)
    return {
        "start": {"line": line, "character": character},
        "end": {"line": end_line, "character": end_character},
    }


def quickfix(new_text: str, range_: dict) -> dict:
    return {
        "title": f"Replace with '{new_text}'",
        "kind": "quickfix",
        "edit": {"changes": {DOC_URI: [{"range": range_, "newText": new_text}]}},
    }


def ignore_lint(start: int, end: int, *, priority: int = 10, kind: str = "Spell") -> dict:
    return {
        "title": "Ignore this lint",
        "command": "HarperIgnoreLint",
        "arguments": [None, {"priority": priority, "lint_kind": kind, "span": {"start": start, "end": end}}],
    }


def lint(text: str, needle: str, after: int = 0, *, replacements=("fixed",), kind: str = "Spell") -> dict:
    """One diagnostic for ``needle``, with the actions harper-ls would attach to it."""
    start = text.index(needle, after)
    end = start + len(needle)
    range_ = utf16_range(text, start, end)
    actions = [quickfix(word, range_) for word in replacements]
    actions.append(ignore_lint(start, end, kind=kind))
    return {"code": "spell", "message": f"'{needle}' is misspelled", "severity": 3, "range": range_,
            "_actions": actions}


@pytest.fixture
def engine(api, monkeypatch):
    """A real HarperEngine whose two LSP seams are canned, plus the call log."""
    instance = api.HarperEngine()
    record: dict = {"actions_for": [], "lint": []}

    monkeypatch.setattr(instance, "start_locked", lambda: None)

    def fake_lint(text, timeout=None):
        record["lint"].append(text)
        return list(record["pending"])

    def fake_actions(diagnostic):
        record["actions_for"].append(diagnostic["message"])
        return diagnostic["_actions"]

    record["pending"] = []
    monkeypatch.setattr(instance, "_lint_locked", fake_lint)
    monkeypatch.setattr(instance, "_code_actions_locked", fake_actions)
    instance.record = record  # type: ignore[attr-defined]
    instance.api = api  # type: ignore[attr-defined]
    return instance


def build(engine, text, diagnostics, **kwargs):
    """Call the real unbound method against the stubbed engine."""
    return engine.api.HarperEngine._build_suggestions(engine, text, diagnostics, **kwargs)


# --- the required mixed draft --------------------------------------------------


def test_only_the_prose_diagnostic_survives_the_mixed_draft(engine):
    text = MIXED
    diagnostics = [
        lint(text, "dont"),
        lint(text, "npm"),
        lint(text, "hermes"),
        lint(text, "coder"),
    ]

    suggestions, truncated, suppressed = build(engine, text, diagnostics)

    assert truncated is False
    assert [s["text"] for s in suggestions] == ["dont"]
    assert suppressed == 3


def test_the_prose_suggestion_keeps_its_exact_offset(engine):
    text = MIXED
    suggestions, _truncated, _suppressed = build(engine, text, [lint(text, "dont")])

    assert suggestions[0]["start"] == text.index("dont")
    assert suggestions[0]["end"] == text.index("dont") + 4
    assert suggestions[0]["text"] == "dont"


def test_a_survivor_never_extends_into_technical_text(engine):
    """Applying it must modify prose only, so the span must not cross a protected edge."""
    text = MIXED
    suggestions, _truncated, _suppressed = build(engine, text, [lint(text, "dont")])

    assert text[suggestions[0]["start"] : suggestions[0]["end"]] == "dont"


def test_the_code_action_is_never_paid_for_a_protected_diagnostic(engine):
    """The pre-filter is the point: each codeAction re-parses the whole draft.

    On a draft of paths and identifiers, paying for every one of them burns the
    budget and then reports ``truncated`` on the prose that the user asked about.
    """
    text = "Read config.yaml from E:\\hermes\\profiles\\coder and fix teh typo"
    diagnostics = [lint(text, "config"), lint(text, "hermes"), lint(text, "teh")]

    build(engine, text, diagnostics)

    assert engine.record["actions_for"] == ["'teh' is misspelled"]


# --- when the cheap pre-filter is not sound ------------------------------------


def test_the_authoritative_filter_still_runs_when_the_range_is_char_based_not_utf16(engine):
    """With an astral character in the draft, LSP units and chars diverge.

    The pre-filter must then be skipped (it cannot trust the range), which is why
    the check after span resolution stays. This diagnostic's range is deliberately
    the char-based one, so a filter that only trusted the range would KEEP it.
    """
    text = "Ship 🎉 the release and read config.yaml to see teh version"
    start = text.index("config")
    end = start + len("config.yaml")
    bad_range = {
        "start": {"line": 0, "character": start},
        "end": {"line": 0, "character": end},
    }
    diagnostic = {
        "code": "spell",
        "message": "'config' is misspelled",
        "severity": 3,
        "range": bad_range,
        "_actions": [quickfix("configuration", bad_range), ignore_lint(start, end)],
    }

    suggestions, _truncated, suppressed = build(engine, text, [diagnostic])

    assert suggestions == []
    assert suppressed == 1


def test_a_straddling_span_is_suppressed_too(engine):
    """Harper sometimes spans a word plus its punctuation into the protected run."""
    text = "Run `npm run dev` and ship the draf version"
    start = text.index("dev")
    end = text.index("dev") + len("dev`") + 1  # through the closing backtick and the space
    range_ = utf16_range(text, start, end)
    diagnostic = {
        "code": "spell",
        "message": "'dev' is misspelled",
        "severity": 3,
        "range": range_,
        "_actions": [quickfix("deaf", range_), ignore_lint(start, end)],
    }

    suggestions, _truncated, suppressed = build(engine, text, [diagnostic])

    assert suggestions == []
    assert suppressed == 1


# --- through the real public entry point ---------------------------------------


def test_check_reports_how_much_technical_text_it_suppressed(engine):
    text = MIXED
    engine.record["pending"] = [lint(text, "dont"), lint(text, "npm"), lint(text, "hermes")]

    payload = engine.check(text)

    assert [s["text"] for s in payload["suggestions"]] == ["dont"]
    assert payload["diagnosticCount"] == 3
    assert payload["technicalSuppressed"] == 2


def test_the_cached_answer_keeps_the_same_suppression(engine):
    text = MIXED
    engine.record["pending"] = [lint(text, "dont"), lint(text, "npm")]

    first = engine.check(text)
    engine.record["pending"] = []
    second = engine.check(text)

    assert first["cached"] is False and second["cached"] is True
    assert second["technicalSuppressed"] == first["technicalSuppressed"] == 1


def test_the_autofix_budget_path_uses_the_same_filter(engine):
    """Submit-time auto-fix is the same funnel: a protected span must never be rewritten."""
    text = MIXED
    engine.record["pending"] = [lint(text, "npm"), lint(text, "hermes"), lint(text, "dont")]

    payload = engine.check(text, budget_ms=5)

    assert [s["text"] for s in payload["suggestions"]] == ["dont"]
    assert payload["technicalSuppressed"] == 2


def test_pure_prose_is_untouched_by_the_filter(engine):
    text = "I think the backend dont respond and nobody sent the recived file."
    diagnostics = [lint(text, "dont"), lint(text, "recived")]

    suggestions, truncated, suppressed = build(engine, text, diagnostics)

    assert suppressed == 0
    assert truncated is False
    assert [s["text"] for s in suggestions] == ["dont", "recived"]


# --- a lint Harper detects but cannot fix (measured verbatim on 2.12.0) ---------


AGREEMENT_ONLY_DIAGNOSTIC = {
    "code": "PronounVerbAgreement",
    "message": "The form of the verb must agree in grammatical number with the pronoun.",
    "severity": 4,
    "range": {
        "start": {"line": 0, "character": 2},
        "end": {"line": 0, "character": 4},
    },
    "_actions": [
        {
            "title": "Ignore Harper error.",
            "command": "HarperIgnoreLint",
            "arguments": [
                DOC_URI,
                {
                    "lint_kind": "Agreement",
                    "message": "The form of the verb must agree in grammatical number with the pronoun.",
                    "priority": 127,
                    "span": {"start": 2, "end": 4},
                    "suggestions": [],
                },
            ],
        }
    ],
}


def test_a_lint_with_no_replacement_offered_produces_no_row(engine):
    """``I is ready.`` is flagged by harper-ls 2.12.0 with an EMPTY suggestion list.

    A row with nothing to apply is a click that does nothing, so it must not reach the
    renderer — and it must not be booked as a technical suppression either, because
    ``diagnosticCount - len(suggestions) - technicalSuppressed`` is how the desktop half
    tells "Harper found it but has no fix" apart from "Harper never saw it".
    """
    text = "I is ready."

    suggestions, truncated, suppressed = build(engine, text, [dict(AGREEMENT_ONLY_DIAGNOSTIC)])

    assert suggestions == []
    assert suppressed == 0
    assert truncated is False


def test_check_still_counts_a_fix_less_lint_as_a_diagnostic(engine):
    text = "I is ready."
    engine.record["pending"] = [dict(AGREEMENT_ONLY_DIAGNOSTIC)]

    payload = engine.check(text)

    assert payload["suggestions"] == []
    assert payload["diagnosticCount"] == 1
    assert payload["technicalSuppressed"] == 0
