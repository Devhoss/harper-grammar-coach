"""The engine pin: where the binary comes from, and what the download will and will not do.

These are the tests that keep ``harper_ls.py`` honest as the single source of truth. None of
them touch the network; the one test that compares the pin against GitHub's live release
manifest is opt-in (``HARPER_PIN_TEST=1``) so CI stays offline by default.
"""

from __future__ import annotations

import io
import os
import tarfile
import zipfile

import pytest

import harper_ls


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """No ambient HARPER_LS_PATH, and nothing reads the developer's real config.yaml."""
    monkeypatch.delenv("HARPER_LS_PATH", raising=False)
    monkeypatch.setattr(harper_ls, "configured_binary_path", lambda: "")


def fake_path(monkeypatch, tmp_path, *, vendor_binary=None, which=None):
    """Point the resolver at a scratch vendor dir and control PATH."""
    monkeypatch.setattr(harper_ls, "VENDOR_DIR", tmp_path / "vendor")
    if vendor_binary is not None:
        vendor = tmp_path / "vendor"
        vendor.mkdir(parents=True, exist_ok=True)
        (vendor / harper_ls.binary_name()).write_bytes(vendor_binary)
    monkeypatch.setattr(harper_ls.shutil, "which", lambda _name: which)


# --- the pin table -----------------------------------------------------------


def test_pin_declares_every_supported_target_with_a_real_size():
    assert harper_ls.RELEASE_ASSETS, "the allowlist must not be empty"
    for (system, machine), (asset, size) in harper_ls.RELEASE_ASSETS.items():
        assert system in {"Windows", "Darwin", "Linux"}
        assert machine, (system, machine)
        assert asset.startswith("harper-ls-"), asset
        assert asset.endswith((".zip", ".tar.gz")), asset
        assert isinstance(size, int) and size > 1_000_000, (asset, size)


def test_windows_assets_are_zips_and_everything_else_is_tarballs():
    for (system, _machine), (asset, _size) in harper_ls.RELEASE_ASSETS.items():
        if system == "Windows":
            assert asset.endswith(".zip"), asset
        else:
            assert asset.endswith(".tar.gz"), asset


def test_release_url_is_built_from_the_pinned_version_and_contains_no_caller_input():
    assert harper_ls.HARPER_VERSION in harper_ls.RELEASE_URL_BASE
    assert harper_ls.RELEASE_URL_BASE.startswith("https://github.com/Automattic/harper/releases/download/v")
    assert harper_ls.release_url("harper-ls-x86_64-pc-windows-msvc.zip").startswith(harper_ls.RELEASE_URL_BASE)


@pytest.mark.skipif(os.environ.get("HARPER_PIN_TEST") != "1", reason="opt-in network check")
def test_pin_matches_the_live_release_manifest():
    """Re-derive every asset name and size from GitHub. Run when bumping HARPER_VERSION."""
    import json
    import urllib.request

    url = f"https://api.github.com/repos/Automattic/harper/releases/tags/v{harper_ls.HARPER_VERSION}"
    with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310 - fixed https URL
        release = json.load(response)

    live = {asset["name"]: asset["size"] for asset in release["assets"]}
    for _key, (name, size) in harper_ls.RELEASE_ASSETS.items():
        assert name in live, f"{name} is not in the v{harper_ls.HARPER_VERSION} release"
        assert live[name] == size, f"{name}: pinned {size}, release has {live[name]}"


@pytest.mark.parametrize(
    ("system", "machine", "expected"),
    [
        ("Windows", "AMD64", "harper-ls-x86_64-pc-windows-msvc.zip"),
        ("Windows", "x86_64", "harper-ls-x86_64-pc-windows-msvc.zip"),
        ("Darwin", "arm64", "harper-ls-aarch64-apple-darwin.tar.gz"),
        ("Darwin", "x86_64", "harper-ls-x86_64-apple-darwin.tar.gz"),
        ("Linux", "x86_64", "harper-ls-x86_64-unknown-linux-gnu.tar.gz"),
        ("Linux", "aarch64", "harper-ls-aarch64-unknown-linux-gnu.tar.gz"),
    ],
)
def test_platform_asset_resolves_each_target(system, machine, expected):
    asset, size = harper_ls.platform_asset(system, machine)
    assert asset == expected
    assert size == harper_ls.RELEASE_ASSETS[(system, machine)][1]


@pytest.mark.parametrize(
    ("system", "machine"),
    [
        ("Windows", "ARM64"),  # ships no harper-ls asset; must not borrow the x86_64 one
        ("Windows", "i686"),
        ("Linux", "armv7l"),
        ("Darwin", "amd64"),  # not a spelling any of these platforms report
        ("FreeBSD", "amd64"),
    ],
)
def test_platform_asset_refuses_a_target_harper_does_not_ship(system, machine):
    """An alias fallback here would download a binary for the wrong architecture. Refusing is
    the honest answer, and `HARPER_LS_PATH` is the escape hatch the message names."""
    asset, size = harper_ls.platform_asset(system, machine)
    assert asset is None and size is None


# --- resolution order --------------------------------------------------------


def test_env_override_wins_and_is_reported_as_env(monkeypatch, tmp_path):
    binary = tmp_path / "custom.exe" if os.name == "nt" else tmp_path / "custom"
    binary.write_bytes(b"custom")
    fake_path(monkeypatch, tmp_path, vendor_binary=b"vendored", which="/usr/bin/harper-ls")
    monkeypatch.setenv("HARPER_LS_PATH", str(binary))
    assert harper_ls.resolve_binary() == (str(binary), "env")


def test_configured_setting_beats_vendor_and_path(monkeypatch, tmp_path):
    binary = tmp_path / "from-config"
    binary.write_bytes(b"config")
    fake_path(monkeypatch, tmp_path, vendor_binary=b"vendored", which="/usr/bin/harper-ls")
    monkeypatch.setattr(harper_ls, "configured_binary_path", lambda: str(binary))
    assert harper_ls.resolve_binary() == (str(binary), "config")


def test_a_configured_path_that_does_not_exist_fails_loudly(monkeypatch, tmp_path):
    """No silent downgrade: a typo must not quietly start a different binary.

    This is the whole reason the resolver returns a reason string instead of falling through,
    so the settings screen can tell the user their own path is broken.
    """
    fake_path(monkeypatch, tmp_path, vendor_binary=b"vendored", which="/usr/bin/harper-ls")
    monkeypatch.setattr(harper_ls, "configured_binary_path", lambda: str(tmp_path / "nope"))
    path, reason = harper_ls.resolve_binary()
    assert path is None
    assert "harper_ls_path points at a missing file" in reason


def test_missing_env_override_fails_loudly_too(monkeypatch, tmp_path):
    fake_path(monkeypatch, tmp_path, vendor_binary=b"vendored")
    monkeypatch.setenv("HARPER_LS_PATH", str(tmp_path / "nope"))
    path, reason = harper_ls.resolve_binary()
    assert path is None
    assert "HARPER_LS_PATH points at a missing file" in reason


def test_vendor_copy_is_used_before_path(monkeypatch, tmp_path):
    fake_path(monkeypatch, tmp_path, vendor_binary=b"vendored", which="/usr/bin/harper-ls")
    path, source = harper_ls.resolve_binary()
    assert source == "vendor"
    assert (tmp_path / "vendor" / harper_ls.binary_name()).read_bytes() == b"vendored"
    assert path.endswith(harper_ls.binary_name())


def test_path_is_the_last_filesystem_fallback(monkeypatch, tmp_path):
    fake_path(monkeypatch, tmp_path, which="/usr/local/bin/harper-ls")
    assert harper_ls.resolve_binary() == ("/usr/local/bin/harper-ls", "path")


def test_nothing_found_names_every_place_it_looked_and_points_at_bootstrap(monkeypatch, tmp_path):
    fake_path(monkeypatch, tmp_path)
    path, reason = harper_ls.resolve_binary()
    assert path is None
    assert "HARPER_LS_PATH" in reason and "harper_ls_path" in reason
    assert "bootstrap" in reason


# --- extraction --------------------------------------------------------------


def _zip_with(name: str, payload: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(f"some/dir/{name}", payload)
    return buffer.getvalue()


def _tar_with(name: str, payload: bytes, directory: str = "harper-ls-build") -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        info = tarfile.TarInfo(f"{directory}/{name}")
        info.size = len(payload)
        info.type = tarfile.REGTYPE
        archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def test_extract_finds_the_binary_in_a_zip_regardless_of_directory():
    payload = _zip_with(harper_ls.binary_name(), b"MZ-fake-binary")
    assert harper_ls.extract_binary(payload, "harper-ls-x86_64-pc-windows-msvc.zip") == b"MZ-fake-binary"


def test_extract_finds_the_binary_in_a_tarball():
    payload = _tar_with(harper_ls.binary_name(), b"\x7fELF-fake-binary")
    assert harper_ls.extract_binary(payload, "harper-ls-x86_64-apple-darwin.tar.gz") == b"\x7fELF-fake-binary"


def test_extract_refuses_an_archive_without_the_expected_member():
    payload = _zip_with("README.txt", b"not a binary")
    with pytest.raises(ValueError, match="not found in"):
        harper_ls.extract_binary(payload, "harper-ls-x86_64-pc-windows-msvc.zip")


# --- the download gate ------------------------------------------------------


class FakeResponse:
    def __init__(self, blob: bytes):
        self._blob = blob

    def read(self) -> bytes:
        return self._blob

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def pin(monkeypatch, archive: bytes, name: str = "harper-ls-fake.zip"):
    """Stand in for the real release: a synthetic archive plus its exact length.

    The size gate compares the ARCHIVE length, so the fake pin has to be the archive's own
    byte count — pinning the payload size instead fails the gate for a reason that has
    nothing to do with the code under test.
    """
    monkeypatch.setattr(harper_ls, "platform_asset", lambda **kw: (name, len(archive)))


def install_urlopen(monkeypatch, blob: bytes, capture: dict):
    def fake_urlopen(request, timeout=None):  # noqa: ARG001 - signature parity
        capture["url"] = request.full_url
        return FakeResponse(blob)

    monkeypatch.setattr(harper_ls.urllib.request, "urlopen", fake_urlopen)


def test_bootstrap_downloads_the_allowlisted_asset_for_this_platform(monkeypatch, tmp_path):
    fake_path(monkeypatch, tmp_path)
    archive = _zip_with(harper_ls.binary_name(), b"012345678")
    pin(monkeypatch, archive)
    capture: dict = {}
    install_urlopen(monkeypatch, archive, capture)

    result = harper_ls.bootstrap(vendor_dir=tmp_path / "vendor")

    assert result["installed"] is True
    assert capture["url"].startswith(harper_ls.RELEASE_URL_BASE)
    assert capture["url"].endswith("/harper-ls-fake.zip")
    assert (tmp_path / "vendor" / harper_ls.binary_name()).read_bytes() == b"012345678"
    assert result["version"] == harper_ls.HARPER_VERSION


def test_a_size_mismatch_is_rejected_before_anything_is_written(monkeypatch, tmp_path):
    """The pinned byte size is the only authority.

    An earlier version let the request body override it, which would have let a caller bless a
    truncated or substituted archive by asking for exactly the bytes it sent.
    """
    fake_path(monkeypatch, tmp_path)
    monkeypatch.setattr(harper_ls, "platform_asset", lambda **kw: ("harper-ls-fake.zip", 999))
    install_urlopen(monkeypatch, b"short", {})

    with pytest.raises(harper_ls.BootstrapError) as excinfo:
        harper_ls.bootstrap(vendor_dir=tmp_path / "vendor")

    assert excinfo.value.reason == "size-mismatch"
    assert not (tmp_path / "vendor" / harper_ls.binary_name()).exists()


def test_an_unsupported_platform_is_a_400_not_a_guess(monkeypatch, tmp_path):
    fake_path(monkeypatch, tmp_path)
    monkeypatch.setattr(harper_ls, "platform_asset", lambda **kw: (None, None))

    with pytest.raises(harper_ls.BootstrapError) as excinfo:
        harper_ls.bootstrap(vendor_dir=tmp_path / "vendor")

    assert excinfo.value.reason == "unsupported-platform"
    assert excinfo.value.status_code == 400


def test_a_network_failure_is_reported_and_nothing_is_installed(monkeypatch, tmp_path):
    fake_path(monkeypatch, tmp_path)
    pin(monkeypatch, b"anything")

    def boom(_request, timeout=None):  # noqa: ARG001
        raise OSError("connection reset")

    monkeypatch.setattr(harper_ls.urllib.request, "urlopen", boom)

    with pytest.raises(harper_ls.BootstrapError) as excinfo:
        harper_ls.bootstrap(vendor_dir=tmp_path / "vendor")

    assert excinfo.value.reason == "download-failed"


def test_bootstrap_is_idempotent_when_an_engine_already_resolves(monkeypatch, tmp_path):
    fake_path(monkeypatch, tmp_path, vendor_binary=b"already")
    called: dict = {}
    install_urlopen(monkeypatch, b"should not be fetched", called)

    result = harper_ls.bootstrap(vendor_dir=tmp_path / "vendor")

    assert result["installed"] is False
    assert result["source"] == "vendor"
    assert "url" not in called, "an existing binary must not trigger a download"


def test_force_skips_the_shortcut(monkeypatch, tmp_path):
    fake_path(monkeypatch, tmp_path, vendor_binary=b"already")
    archive = _zip_with(harper_ls.binary_name(), b"new!")
    pin(monkeypatch, archive)
    install_urlopen(monkeypatch, archive, {})

    result = harper_ls.bootstrap(vendor_dir=tmp_path / "vendor", force=True)

    assert result["installed"] is True
    assert (tmp_path / "vendor" / harper_ls.binary_name()).read_bytes() == b"new!"


def test_the_binary_lands_by_rename_so_no_partial_write_is_ever_spawnable(monkeypatch, tmp_path):
    fake_path(monkeypatch, tmp_path)
    archive = _zip_with(harper_ls.binary_name(), b"012345678")
    pin(monkeypatch, archive)
    install_urlopen(monkeypatch, archive, {})

    harper_ls.bootstrap(vendor_dir=tmp_path / "vendor")

    leftovers = [p.name for p in (tmp_path / "vendor").iterdir()]
    assert leftovers == [harper_ls.binary_name()], leftovers
