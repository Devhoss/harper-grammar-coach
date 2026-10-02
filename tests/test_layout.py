"""Packaging invariants: the things that make this directory installable as a Hermes plugin.

These are assertions about the repository, not about behavior, and each one exists because the
Hermes installer/loader/scanner has a rule that a plain unit test would never catch. They are
deliberately written against the tree rather than against a fixture copy, so a stray file
anywhere in the package fails CI.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

# Directories that are not part of the published package.
IGNORED_DIRS = {".git", ".venv", "venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", "vendor", "node_modules", "dist", "build"}

# What Hermes' plugin scanner refuses to see bundled in a plugin tree
# (tools/plugin_guard.py, SUSPICIOUS_BINARY_EXTENSIONS plus the obvious ones).
BINARY_SUFFIXES = {
    ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".lib", ".pyd",
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
    ".wasm", ".class", ".jar", ".msi", ".dmg", ".apk", ".deb", ".rpm",
}

# Mirrors _KNOWN_MANIFEST_FIELDS in hermes_cli/plugins_manifest.py. A key outside this set
# makes the installer log "unknown manifest field", which is how a typo'd knob ships dead.
KNOWN_MANIFEST_FIELDS = {
    "name", "version", "description", "author", "requires_env", "provides_tools",
    "provides_hooks", "kind", "hooks", "label", "optional_env", "platforms",
    "external_dependencies", "pip_dependencies", "provides_browser_providers",
    "provides_web_providers", "manifest_version", "api_version", "requires_plugins",
    "python_dependencies", "config_schema", "license", "homepage", "tags",
    "capabilities", "emits", "listens", "hermes", "depends", "requires_hermes",
    "python_runtime", "provides_locales",
}

# Scanner limits (tools/plugin_guard.py). Staying inside them keeps a `safe` verdict possible.
MAX_FILES = 400
MAX_TOTAL_BYTES = 10 * 1024 * 1024
MAX_SINGLE_FILE_BYTES = 1024 * 1024

WORKING_NOTES = {"PLAN.md", "REPORT.md", "TODO.md", "NOTES.md", "SCRATCH.md"}


def package_files(root: Path) -> list[Path]:
    out = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in IGNORED_DIRS for part in path.relative_to(root).parts):
            continue
        out.append(path)
    return sorted(out)


@pytest.fixture(scope="module")
def files(repo_root):
    return package_files(repo_root)


@pytest.fixture(scope="module")
def manifest(repo_root):
    yaml = pytest.importorskip("yaml")
    return yaml.safe_load((repo_root / "plugin.yaml").read_text(encoding="utf-8"))


# --- the rule that matters most: no binary in the package --------------------


def test_no_binaries_or_archives_anywhere_in_the_tree(files):
    offenders = [p.name for p in files if p.suffix.lower() in BINARY_SUFFIXES]
    assert not offenders, (
        f"{offenders} would make Hermes' security scanner return a `caution` verdict, which "
        "blocks the install outside an interactive terminal. The engine is fetched by "
        "POST /bootstrap; keep it out of the repository."
    )


def test_no_file_is_large_enough_to_look_like_a_bundled_engine(files):
    offenders = [(p.name, p.stat().st_size) for p in files if p.stat().st_size > MAX_SINGLE_FILE_BYTES]
    assert not offenders


def test_the_package_stays_inside_the_scanner_s_budget(files):
    assert len(files) <= MAX_FILES, f"{len(files)} files"
    total = sum(p.stat().st_size for p in files)
    assert total <= MAX_TOTAL_BYTES, f"{total} bytes"


def test_vendor_is_ignored_by_git(repo_root):
    gitignore = (repo_root / ".gitignore").read_text(encoding="utf-8")
    assert re.search(r"^/?vendor/?$", gitignore, re.MULTILINE), "vendor/ must be gitignored"


def test_no_working_notes_ship_in_the_package(repo_root, files):
    root_names = {p.name for p in files if p.parent == repo_root}
    assert not (root_names & WORKING_NOTES), (
        "design notes and status reports belong in a PR description or docs/, not at the "
        "plugin root, where `hermes plugins update` treats them as revision-owned content"
    )


# --- manifest ----------------------------------------------------------------


def test_manifest_uses_only_keys_the_loader_knows(manifest):
    unknown = set(manifest) - KNOWN_MANIFEST_FIELDS
    assert not unknown, f"unknown manifest field(s): {sorted(unknown)}"


@pytest.mark.parametrize("field", ["name", "version", "description"])
def test_required_manifest_fields_are_present_and_non_empty(manifest, field):
    value = manifest.get(field)
    assert isinstance(value, str) and value.strip(), f"{field} is required and non-empty"


def test_manifest_name_is_the_directory_the_plugin_installs_into(manifest, repo_root):
    """The installer derives the target directory from `name`, and both enable stores key off
    it — so the repo, the install path and the settings token have to agree."""
    assert manifest["name"] == repo_root.name


def test_kind_is_a_value_the_loader_accepts(manifest):
    assert manifest["kind"] in {"standalone", "backend", "exclusive", "platform", "model-provider"}


def test_declared_capabilities_match_what_register_does(manifest, repo_root):
    """`provides_tools`/`provides_hooks` are compared against what register() actually calls.
    This plugin registers nothing, so both must be empty — a non-empty list here without a
    matching call fails `hermes plugins validate`."""
    assert manifest["provides_tools"] == []
    assert manifest["provides_hooks"] == []


def test_python_runtime_is_declared_external(manifest):
    """Without this, the contributor pyproject.toml makes the package a member of Hermes'
    shared uv environment, and install-time consent offers to prepare an environment this
    plugin contributes nothing to."""
    assert manifest["python_runtime"] == "external"


def test_requires_hermes_is_a_floor_the_loader_can_parse(manifest):
    assert re.fullmatch(r">=\s*[0-9]+(\.[0-9]+)*", str(manifest["requires_hermes"]).strip())


def test_config_schema_types_are_types_the_loader_accepts(manifest):
    accepted = {
        "str", "string", "int", "integer", "float", "number",
        "bool", "boolean", "list", "array", "dict", "object", "secret",
    }
    schema = manifest["config_schema"]
    assert isinstance(schema, dict) and schema
    for key, spec in schema.items():
        assert re.fullmatch(r"[a-z][a-z0-9_]*", key), key
        assert spec["type"] in accepted, (key, spec["type"])
        assert "description" in spec and "default" in spec


def test_the_harper_ls_path_setting_matches_the_code(manifest, repo_root):
    """A declared setting nothing reads is a knob that does not turn."""
    assert "harper_ls_path" in manifest["config_schema"]
    source = (repo_root / "harper_ls.py").read_text(encoding="utf-8")
    assert "harper_ls_path" in source


# --- the two halves ----------------------------------------------------------


def test_agent_half_exists_and_defines_register(repo_root):
    """A discovered plugin.yaml with no register() is recorded as a failed plugin, and
    `detectPluginComponents` only reports `agent: true` for the yaml + __init__.py pair — which
    is what makes a git install stamp the desktop half with its package marker."""
    source = (repo_root / "__init__.py").read_text(encoding="utf-8")
    assert re.search(r"^def register\(", source, re.MULTILINE)


def test_dashboard_manifest_points_at_an_api_that_exists(repo_root, manifest):
    raw = (repo_root / "dashboard" / "manifest.json").read_text(encoding="utf-8")
    payload = json.loads(raw)
    assert payload["name"] == manifest["name"]
    assert payload["label"]
    assert payload["description"]
    assert payload["api"] == "plugin_api.py"
    assert (repo_root / "dashboard" / payload["api"]).is_file()
    # One version across both halves, or the Plugins page and the settings row disagree.
    assert payload["version"] == manifest["version"]


def test_desktop_half_is_at_the_depth_hermes_materializes(repo_root):
    """`reconcileUnifiedDesktopHalves` copies exactly `<package>/desktop/`, and the desktop
    surface lint only treats a path as a desktop surface when its first part is `desktop`."""
    assert (repo_root / "desktop" / "plugin.js").is_file()


def test_dashboard_and_desktop_directories_are_not_revision_owned(repo_root):
    """Hermes excludes these from revision ownership on update, so a user's local edit there
    survives `hermes plugins update`. Anything else at the root does not — which is why working
    notes at the root are a bad idea (see test_no_working_notes_ship_in_the_package)."""
    assert (repo_root / "dashboard").is_dir() and (repo_root / "desktop").is_dir()


def test_desktop_half_imports_only_what_the_renderer_will_resolve(repo_root):
    """The renderer's import map holds @hermes/plugin-sdk and react only. Anything else is a
    runtime import failure that looks like a dead plugin."""
    source = (repo_root / "desktop" / "plugin.js").read_text(encoding="utf-8")
    specifiers = re.findall(r"""from\s+['"]([^'"]+)['"]""", source)
    allowed = {"@hermes/plugin-sdk", "react", "react/jsx-runtime", "react/jsx-dev-runtime"}
    assert specifiers, "the desktop half should import the SDK"
    assert set(specifiers) <= allowed, set(specifiers) - allowed


# --- release metadata --------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    ["README.md", "LICENSE", "NOTICE", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", ".gitignore", "pyproject.toml"],
)
def test_distribution_documentation_is_present_and_substantive(repo_root, name):
    path = repo_root / name
    assert path.is_file(), f"{name} is missing"
    assert len(path.read_text(encoding="utf-8").strip()) > 200, f"{name} looks like a stub"


def test_upstream_license_text_is_shipped_for_the_engine_it_runs(repo_root):
    text = (repo_root / "licenses" / "APACHE-2.0-harper-ls.txt").read_text(encoding="utf-8")
    assert "Apache License" in text and "Version 2.0" in text


def test_notice_names_the_engine_and_its_owner(repo_root):
    notice = (repo_root / "NOTICE").read_text(encoding="utf-8")
    assert "harper-ls" in notice and "Automattic" in notice and "Apache" in notice


def test_pyproject_declares_no_runtime_dependencies(repo_root):
    """FastAPI is the host's. Declaring it here would make the installer offer to build an
    environment for a plugin that runs inside one it already has."""
    toml_text = (repo_root / "pyproject.toml").read_text(encoding="utf-8")
    project = re.search(r"(?ms)^\[project\](.*?)(?=^\[|\Z)", toml_text)
    assert project
    dependencies = re.search(r"(?ms)^dependencies\s*=\s*\[(.*?)\]", project.group(1))
    assert dependencies and not dependencies.group(1).strip(), "runtime dependencies must stay empty"


def test_no_absolute_paths_from_a_developers_machine_in_the_package(files):
    pattern = re.compile(r"[A-Z]:\\\\Users\\\\|/home/[a-z0-9_-]+/|/Users/[a-z0-9_-]+/")
    hits = []
    for path in files:
        if path.suffix not in {".py", ".js", ".json", ".yaml", ".yml", ".md", ".toml"}:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if pattern.search(text):
            hits.append(str(path))
    assert not hits, hits


def test_the_package_can_be_imported_without_a_hermes_checkout(repo_root):
    """`harper_ls` is loadable standalone: tests, scripts and CI import it with no Hermes on
    sys.path, and its config lookup is expected to degrade to "" rather than raise."""
    sys.path.insert(0, str(repo_root))
    try:
        import harper_ls

        assert harper_ls.configured_binary_path() == ""
        assert harper_ls.binary_name() in {"harper-ls", "harper-ls.exe"}
    finally:
        sys.path.remove(str(repo_root))
