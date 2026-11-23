"""
Tests for the self-hosted config store.

These cover the properties that actually bite in production:

* credentials are generated once and then stable across restarts
* the state file is not world-readable
* a browser that echoes back the redaction mask cannot wipe real secrets
* a partially written/older state is repaired instead of crashing the boot
"""

from __future__ import annotations

import json
import stat
from copy import deepcopy

import pytest

from freqtrade.app.defaults import MASK, base_config
from freqtrade.app.store import (
    DEFAULT_STATE_SCHEMA,
    MODE_SHELL,
    MODE_TRADE,
    app_dir,
    ensure_state,
    generate_password,
    generate_token,
    load_state,
    redact_config,
    save_state,
    set_mode,
    state_path,
    unredact_merge,
)


@pytest.fixture
def userdir(tmp_path):
    return tmp_path / "user_data"


def test_ensure_state_creates_credentials(userdir):
    state, created = ensure_state(userdir)

    assert created is True
    assert state["schema"] == DEFAULT_STATE_SCHEMA
    assert state["mode"] == MODE_SHELL
    api = state["config"]["api_server"]
    assert api["username"] == "admin"
    assert len(api["password"]) >= 16
    assert len(api["jwt_secret_key"]) == 64
    assert len(state["config"]["app"]["signal_token"]) == 64
    assert api["password"] != state["config"]["app"]["signal_token"]


def test_state_file_is_private(userdir):
    ensure_state(userdir)
    mode = stat.S_IMODE(state_path(userdir).stat().st_mode)
    assert mode == 0o600, f"state file must not be group/world accessible, got {oct(mode)}"


def test_second_start_keeps_credentials(userdir):
    first, created_first = ensure_state(userdir)
    second, created_second = ensure_state(userdir)

    assert created_first is True
    assert created_second is False
    assert first["config"]["api_server"]["password"] == second["config"]["api_server"]["password"]
    assert first["config"]["app"]["signal_token"] == second["config"]["app"]["signal_token"], (
        "regenerating the token would silently break every external integration"
    )


def test_user_data_scaffolding_created(userdir):
    ensure_state(userdir)
    for name in ("strategies", "data", "logs", "notebooks"):
        assert (userdir / name).is_dir()
    # A resolvable default strategy is required or trade mode dies on boot.
    assert list((userdir / "strategies").glob("*.py"))


def test_redact_masks_secrets_only():
    cfg = base_config(username="admin", password="secret-pw", jwt_secret_key="k" * 64)
    cfg["exchange"]["key"] = "real-key"
    cfg["exchange"]["secret"] = "real-secret"
    cfg["app"] = {"signal_token": "tok", "ui_path": "/srv/ftui"}

    red = redact_config(cfg)

    assert red["api_server"]["password"] == MASK
    assert red["api_server"]["jwt_secret_key"] == MASK
    assert red["exchange"]["key"] == MASK
    assert red["exchange"]["secret"] == MASK
    assert red["app"]["signal_token"] == MASK
    # Non-secret values must survive, otherwise the UI cannot show them.
    assert red["api_server"]["username"] == "admin"
    assert red["app"]["ui_path"] == "/srv/ftui"
    assert red["exchange"]["name"] == "okx"


def test_empty_secret_is_not_masked():
    """An unset key must stay empty so the UI can show 'not configured'."""
    cfg = base_config(username="admin", password="pw", jwt_secret_key="k" * 64)
    assert redact_config(cfg)["exchange"]["secret"] == ""


def test_unredact_merge_keeps_real_secret():
    cfg = base_config(username="admin", password="pw", jwt_secret_key="k" * 64)
    cfg["exchange"]["secret"] = "real-secret"

    merged = unredact_merge(cfg, {"exchange": {"secret": MASK, "name": "bybit"}})

    assert merged["exchange"]["secret"] == "real-secret"
    assert merged["exchange"]["name"] == "bybit"
    # Original must not be mutated in place.
    assert cfg["exchange"]["name"] == "okx"


def test_unredact_merge_allows_real_new_secret():
    cfg = base_config(username="admin", password="pw", jwt_secret_key="k" * 64)
    merged = unredact_merge(cfg, {"exchange": {"secret": "brand-new"}})
    assert merged["exchange"]["secret"] == "brand-new"


def test_save_state_is_atomic_and_reloadable(userdir):
    state, _ = ensure_state(userdir)
    state["config"]["timeframe"] = "1h"
    save_state(state_path(userdir), state)

    again = load_state(state_path(userdir))
    assert again["config"]["timeframe"] == "1h"
    # No temp files left behind.
    leftovers = [p.name for p in app_dir(userdir).iterdir() if p.name.startswith(".state-")]
    assert leftovers == []


def test_migration_fills_missing_secrets(userdir):
    state, _ = ensure_state(userdir)
    broken = deepcopy(state)
    broken["schema"] = 0
    broken["config"]["app"] = {}
    del broken["config"]["api_server"]["jwt_secret_key"]
    state_path(userdir).write_text(json.dumps(broken), encoding="utf-8")

    repaired, created = ensure_state(userdir)

    assert created is False
    assert repaired["schema"] == DEFAULT_STATE_SCHEMA
    assert repaired["config"]["app"]["signal_token"]
    assert len(repaired["config"]["api_server"]["jwt_secret_key"]) == 64
    # Existing password must survive the repair.
    assert repaired["config"]["api_server"]["password"] == state["config"]["api_server"]["password"]


def test_set_mode_validates(userdir):
    state, _ = ensure_state(userdir)
    set_mode(state, MODE_TRADE)
    assert state["mode"] == MODE_TRADE
    with pytest.raises(ValueError):
        set_mode(state, "bogus")


def test_generators_are_unique():
    assert generate_password() != generate_password()
    assert generate_token() != generate_token()
    assert len(generate_token()) == 64
