"""Context-based protection for technical (machine-oriented) spans in a draft.

Harper parses the composer draft as prose and lints every word it is not told to
skip. In an AI-agent composer most of the tokens are machine text — paths, inline
code, identifiers, config keys — and Harper reports them as spelling errors
(measured on 2.12.0: ``E:\\hermes\\profiles\\coder`` yields ``hermes -> heroes`` at
priority 127, and ``config.yaml`` yields both ``config -> configuration`` and
``yaml -> yams``). Suppressing those is the difference between a coach and noise.

The rule is CONTEXT, never a word list: a token is protected because of the shape
of the text around it, so ``dont`` inside a path is not protected any more than
``dont`` in prose is, and no project name is special-cased anywhere in here.

Indices are Python ``str`` indices — Unicode code points, which is exactly the
space Harper's own char spans use, so the caller can compare them directly.
"""

from __future__ import annotations

import re
from typing import List, Tuple

Span = Tuple[int, int]

__all__ = ["protected_spans", "is_protected"]

# A fenced block opens at a line's left margin (CommonMark allows three spaces) and
# runs to a matching closer, or to the end of the draft when the closer is missing.
# Matched anchored at each line start, so no caret here — one would only fire on
# position 0 of the whole draft.
_FENCE = re.compile(r" {0,3}(`{3,}|~{3,})")
# One backtick run, no newline inside, matched by a run of the SAME length — so a
# double-quoted span survives a single backtick in its body.
_INLINE_CODE = re.compile(r"(?<!`)(`{1,3})(?!`)([^`\n]+?)\1(?!`)")
_URL = re.compile(
    r"(?:\b(?:https?|ftp)://|\b(?:mailto|tel):|\bwww\.)[^\s<>\[\]{}|\"']+",
    re.IGNORECASE,
)
# A "$ command" prompt line is machine text from the prompt to the end of the line.
_PROMPT_LINE = re.compile(r"^ {0,3}(?:\$|PS>) [^\n]*", re.MULTILINE | re.IGNORECASE)

_DRIVE = re.compile(r"[A-Za-z]:[\\/]")
_RELATIVE = re.compile(r"(?:\.{1,2}|~)[\\/]")

# Trailing punctuation is not part of a token's shape; a run's leading punctuation
# usually IS (-v, @alice, &&), so leading characters are kept for classification.
_TRIM_END = " \t\r\n.,;:!?)]}\"'`"

_SEGMENT_END = ".,;:!?)\"'` \t\r\n"

_CAMEL = re.compile(r"[a-z0-9][A-Z]")
_UPPER_RUN = re.compile(r"[A-Z]{2,}")
_EXTENSION = re.compile(r"\.[A-Za-z][A-Za-z0-9]{0,9}")
_VERSION = re.compile(r"\bv?\d+(?:\.\d+)+")
_COLON_PORT = re.compile(r"[A-Za-z.]:\d")


def _is_segment_char(ch: str) -> bool:
    return ch.isalnum() or ch in "._-+@%~"


def _merge(spans: List[Span]) -> List[Span]:
    """Sorted, non-overlapping, touching spans folded together."""
    ordered = sorted(span for span in spans if span[1] > span[0])
    out: List[Span] = []
    for start, end in ordered:
        if out and start <= out[-1][1]:
            if end > out[-1][1]:
                out[-1] = (out[-1][0], end)
            continue
        out.append((start, end))
    return out


def _fences(text: str) -> List[Span]:
    out: List[Span] = []
    lines = _line_starts(text)
    i = 0
    while i < len(lines):
        start = lines[i]
        match = _FENCE.match(text, start)
        if not match:
            i += 1
            continue
        marker = match.group(1)
        end = len(text)
        closing = _find_line(lines, text, i + 1, marker)
        if closing is not None:
            end = closing[1]
        out.append((start, end))
        i = (closing[0] + 1) if closing is not None else len(lines)
    return out


def _line_starts(text: str) -> List[int]:
    starts = [0]
    for index, ch in enumerate(text):
        if ch == "\n":
            starts.append(index + 1)
    return starts


def _line_bounds(text: str, start: int) -> Tuple[int, int]:
    end = text.find("\n", start)
    return (start, len(text) if end == -1 else end)


def _find_line(lines: List[int], text: str, from_line: int, marker: str) -> Tuple[int, int] | None:
    """The first line at or after ``from_line`` that closes ``marker``."""
    for number in range(from_line, len(lines)):
        start = lines[number]
        match = _FENCE.match(text, start)
        if match and match.group(1)[0] == marker[0] and len(match.group(1)) >= len(marker):
            return (number, _line_bounds(text, start)[1])
    return None


def _path_end(text: str, start: int) -> int | None:
    """Index just past a path beginning at ``start``, or None when it is not a path.

    A space belongs to the path only while the next token is itself followed by a
    separator, which is what keeps ``C:\\Program Files\\App\\x.exe then write`` a
    single span and ``E:\\hermes and then`` a short one.
    """
    total = len(text)
    match = _DRIVE.match(text, start)
    if match:
        pos = match.end()
    else:
        match = _RELATIVE.match(text, start)
        if match:
            pos = match.end()
        elif text.startswith("\\\\", start):  # UNC share
            pos = start + 2
        elif text[start] in "\\/" and start + 1 < total and _is_segment_char(text[start + 1]):
            pos = start + 1
        else:
            return None

    end = None
    while pos < total:
        segment = pos
        while pos < total and _is_segment_char(text[pos]):
            pos += 1
        if pos == segment:
            break
        end = pos
        if pos < total and text[pos] in "\\/":
            pos += 1
            continue
        if pos < total and text[pos] in " \t":
            probe = pos
            while probe < total and text[probe] in " \t":
                probe += 1
            walk = probe
            while walk < total and _is_segment_char(text[walk]):
                walk += 1
            if walk > probe and walk < total and text[walk] in "\\/":
                pos = probe
                continue
        break

    if end is None:
        return None
    while end > start and text[end - 1] in _SEGMENT_END:
        end -= 1
    return end if end > start else None


def _is_machine(core: str) -> bool:
    """True for a token whose SHAPE is machine text, never for a known word."""
    if not core:
        return False
    if "_" in core:
        return True
    if _CAMEL.search(core):
        return True
    if _UPPER_RUN.search(core):
        return True
    if "=" in core:
        return True
    if _EXTENSION.search(core):
        return True
    if core[0] in "@#$*<>":
        return True
    if core[0] == "-" and core.lstrip("-")[:1].isalnum():
        return True
    if _COLON_PORT.search(core):
        return True
    if any(ch in core for ch in "&|<>"):
        return True
    return bool(_VERSION.search(core))


def protected_spans(text: str) -> List[Span]:
    """Every protected span in ``text``, sorted and merged, non-overlapping."""
    if not text:
        return []

    spans: List[Span] = []
    fences = _fences(text)
    spans.extend(fences)

    for match in _INLINE_CODE.finditer(text):
        start, end = match.span()
        if any(start < f_end and f_start < end for f_start, f_end in fences):
            continue  # Already inside a block; a stray backtick is not code here.
        spans.append((start, end))

    for match in _URL.finditer(text):
        spans.append(match.span())

    for match in _PROMPT_LINE.finditer(text):
        spans.append(match.span())

    index = 0
    total = len(text)
    while index < total:
        end = _path_end(text, index)
        if end is None:
            index += 1
            continue
        spans.append((index, end))
        index = end

    # Machine-shaped whitespace runs: identifiers, flags, versions, keys, ports.
    pos = 0
    while pos < total:
        if text[pos] in " \t\r\n":
            pos += 1
            continue
        start = pos
        while pos < total and text[pos] not in " \t\r\n":
            pos += 1
        core = text[start:pos].rstrip(_TRIM_END)
        if _is_machine(core):
            spans.append((start, pos))

    return _merge(spans)


def is_protected(spans: List[Span], start: int, end: int) -> bool:
    """True when ``[start, end)`` overlaps a protected span."""
    return any(span_start < end and start < span_end for span_start, span_end in spans)
