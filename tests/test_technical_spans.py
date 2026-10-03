"""RED: the protected-span detector must classify machine text by CONTEXT, never by a
word list.

Each test names the false positive it exists to prevent, measured against harper-ls
2.12.0: ``E:\\hermes\\profiles\\coder`` yields ``hermes -> heroes`` at priority 127,
and ``config.yaml`` yields both ``config -> configuration`` and ``yaml -> yams``.
"""

from __future__ import annotations

import pytest

from technical_spans import is_protected, protected_spans


def covers(text: str, needle: str, after: int = 0) -> bool:
    """True when a single protected span fully contains this occurrence.

    Containment, not overlap: ``covers(text, "npm")`` must fail if only part of
    the code span is protected, because a half-protected span still yields the
    ``npm -> nom`` suggestion the filter exists to suppress.
    """
    start = text.index(needle, after)
    end = start + len(needle)

    return any(span_start <= start and end <= span_end for span_start, span_end in protected_spans(text))


def protects(text: str, needle: str, after: int = 0) -> bool:
    """True when the occurrence overlaps any protected span — the suppression rule."""
    start = text.index(needle, after)

    return is_protected(protected_spans(text), start, start + len(needle))


# --- the baseline: prose must stay checkable ----------------------------------


def test_plain_prose_is_not_protected():
    text = "I think the backend dont respond and nobody sent the recived file."

    assert protected_spans(text) == []


def test_empty_and_whitespace_only_drafts_have_no_spans():
    assert protected_spans("") == []
    assert protected_spans("\n  \n") == []


# --- fenced code --------------------------------------------------------------


def test_fenced_block_body_is_protected_and_the_prose_around_it_is_not():
    text = "Check it first:\n```bash\ngit status --short\n```\nthen relase the app."

    assert covers(text, "git")
    assert covers(text, "status")
    assert not covers(text, "relase")
    assert not covers(text, "Check")


def test_tilde_fences_are_fences_too():
    text = "~~~python\nharper_lint = tru\n~~~"

    assert covers(text, "harper_lint")


def test_an_unclosed_fence_protects_everything_after_it():
    text = "Here is the snippet:\n```\nsubsitute this line\nand this on too"

    assert covers(text, "subsitute")
    assert covers(text, "on")


def test_the_fence_markers_themselves_are_protected():
    text = "```\nfoo\n```"

    assert is_protected(protected_spans(text), 0, 3)


# --- inline code --------------------------------------------------------------


def test_inline_code_is_protected_while_the_sentence_around_it_is_not():
    text = "I run `npm run dev` but the servise dont start"

    assert covers(text, "npm")
    assert covers(text, "dev")
    assert not covers(text, "servise")
    assert not covers(text, "dont")


def test_double_backtick_spans_survive_a_single_backtick_inside():
    text = "Use ``do_not edit this`` in you config"

    assert covers(text, "edit")


# --- URLs ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/a_path/c?q=1&x=2#frag",
        "http://127.0.0.1:8000/api/plugins",
        "www.exampl.com/docs",
        "mailto:someone@exampl.com",
    ],
)
def test_urls_are_protected_whole(url):
    text = f"See {url} for the detailes"

    assert covers(text, url)
    assert not covers(text, "detailes")


def test_a_domain_inside_prose_still_protects_the_prose_words_around_it():
    text = "The host localhost:63286 an the port 8000 are both teh same"

    assert covers(text, "localhost:63286")
    assert not covers(text, "teh")


# --- paths --------------------------------------------------------------------


def test_windows_path_is_protected_including_every_segment():
    text = r"Edit E:\hermes\profiles\coder\plugins\harper-grammar-coach and tell me"

    assert covers(text, "hermes")
    assert covers(text, "coder")
    assert covers(text, "harper-grammar-coach")
    assert not covers(text, "tell")


def test_a_windows_path_keeps_spaces_only_when_a_later_separator_follows():
    text = r"Launch C:\Program Files\App\thing.exe then write a test for it"

    assert covers(text, r"C:\Program Files\App\thing.exe")
    assert not covers(text, "write")
    assert not covers(text, "test")


def test_a_path_stops_at_the_end_of_the_sentence_not_at_the_full_stop():
    text = r"I run `npm run dev` from E:\hermes\profiles\coder."

    assert covers(text, "E:\\hermes\\profiles\\coder")
    assert not covers(text, "dev` from")
    assert not is_protected(protected_spans(text), len(text) - 1, len(text))


def test_a_forward_slash_windows_path_is_a_path_too():
    text = r"Put it in E:/hermes/profiles/coder plase"

    assert covers(text, "hermes")
    assert not covers(text, "plase")


def test_a_rooted_path_is_protected():
    text = r"Copy \sharedocs\team\file.txt to the desktp"

    assert covers(text, "sharedocs")
    assert not covers(text, "desktp")


def test_unc_paths_are_protected():
    text = r"Copy \\fileserver\share\file.txt to the desktp"

    assert covers(text, "fileserver")
    assert covers(text, "share")
    assert not covers(text, "desktp")


@pytest.mark.parametrize("path", ["/usr/local/bin/python3", "~/notes/todo.md", "./src/index.ts", "../pkg/mod.rs"])
def test_unix_paths_are_protected(path):
    text = f"Open {path} and fix the mistke"

    assert covers(text, path)
    assert not covers(text, "mistke")


def test_a_slash_command_does_not_swallow_the_prose_after_it():
    text = "/help me fix teh grammar"

    assert not covers(text, "teh")
    assert not covers(text, "fix")


# --- file names, identifiers, keys --------------------------------------------


@pytest.mark.parametrize("name", ["config.yaml", "plugin_api.py", "harper-ls.exe", "manifest.json"])
def test_file_names_are_protected_including_the_extension(name):
    text = f"Read {name} it is the src of the mistke"

    assert covers(text, name)
    assert covers(text, name.rsplit(".", 1)[1])
    assert not covers(text, "mistke")


@pytest.mark.parametrize("ident", ["fooBar", "maxRetries", "snake_case", "HARPER_LS_PATH", "HTTPStatus"])
def test_identifiers_are_protected(ident):
    text = f"The {ident} value is wrng here"

    assert covers(text, ident)
    assert not covers(text, "wrng")


def test_dotted_config_keys_are_protected():
    text = "Set plugins.enabled and python_runtime to turn it on"

    assert covers(text, "plugins.enabled")
    assert covers(text, "python_runtime")


def test_key_equals_value_is_protected():
    text = "Pass dialect=American to the engin"

    assert covers(text, "dialect=American")
    assert not covers(text, "engin")


# --- mentions and references ---------------------------------------------------


def test_mentions_and_issue_refs_are_protected():
    text = "Ping @alice about HER-1234 and #4321 it is stil open"

    assert covers(text, "@alice")
    assert covers(text, "HER-1234")
    assert covers(text, "#4321")
    assert not covers(text, "stil")


# --- machine tokens ------------------------------------------------------------


@pytest.mark.parametrize("token", ["--save-dev", "-v", "&&", "2>&1", "$HOME", "${PATH}", "v1.2.3", "1.2.3"])
def test_command_shaped_tokens_are_protected(token):
    text = f"run it with {token} then chec again"

    assert covers(text, token)
    assert not covers(text, "chec")


def test_a_prompted_shell_line_is_protected_wholesale():
    text = "Try this:\n$ git brnach -m teh-new-name"

    assert covers(text, "brnach")
    assert covers(text, "teh-new-name")


# --- the required mixed cases --------------------------------------------------


def test_the_mixed_draft_protects_only_the_technical_half():
    text = "I think the backend dont respond when I run `npm run dev` from E:\\hermes\\profiles\\coder."

    assert not covers(text, "dont")
    assert covers(text, "npm")
    assert covers(text, "dev")
    assert covers(text, "hermes")
    assert covers(text, "coder")


def test_the_same_word_is_protected_inside_a_technical_span_and_not_outside_it():
    text = "The word config is a config key, but `config` is code and config.yaml is a file."
    spans = protected_spans(text)

    # @9 and @21 are prose; @38 is inline code; @58 is the stem of config.yaml.
    assert not is_protected(spans, text.index("config"), text.index("config") + 6)
    assert not is_protected(spans, 21, 27)
    assert is_protected(spans, 38, 44)
    assert is_protected(spans, 58, 64)
    assert is_protected(spans, text.index("yaml"), text.index("yaml") + 4)


# --- span hygiene --------------------------------------------------------------


def test_spans_are_sorted_merged_and_non_overlapping():
    text = "See `a` then https://x.dev/y and E:\\p\\q for the plaing"
    spans = protected_spans(text)

    assert spans == sorted(spans)
    assert all(end > start for start, end in spans)
    assert all(spans[i][1] <= spans[i + 1][0] for i in range(len(spans) - 1))


def test_touching_a_protected_span_counts_as_protected():
    spans = [(10, 20)]

    assert is_protected(spans, 15, 25)
    assert is_protected(spans, 5, 11)
    assert is_protected(spans, 12, 14)
    assert not is_protected(spans, 20, 25)


def test_code_point_indices_are_used_not_utf16_units():
    text = "I love 🎉 the tool /usr/locla/bin and it works"
    path_start = text.index("/usr")
    spans = protected_spans(text)

    assert (path_start, path_start + len("/usr/locla/bin")) in spans
