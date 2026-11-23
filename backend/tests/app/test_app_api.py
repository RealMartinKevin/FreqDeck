"""Tests for app-mode API helpers that are cheap to test without a live server."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from freqtrade.enums import RunMode
from freqtrade.rpc.api_server.api_app import (
    _probe_runmode,
    _restart_only_changed,
    require_signal_token,
)


def test_restart_only_changed_detects_listen_port():
    old = {"api_server": {"listen_port": 8080, "username": "admin"}, "timeframe": "5m"}
    new = {"api_server": {"listen_port": 9090, "username": "admin"}, "timeframe": "15m"}

    assert _restart_only_changed(old, new) == ["api_server.listen_port"]


def test_restart_only_changed_ignores_hot_reloadable():
    old = {"api_server": {"listen_port": 8080}, "timeframe": "5m", "strategy": "A"}
    new = {"api_server": {"listen_port": 8080}, "timeframe": "15m", "strategy": "B"}
    assert _restart_only_changed(old, new) == []


def test_restart_only_changed_db_url():
    assert _restart_only_changed({"db_url": "sqlite:///a"}, {"db_url": "sqlite:///b"}) == ["db_url"]


def test_probe_runmode_reflects_mode_and_dry_run():
    assert _probe_runmode({"mode": "shell", "config": {"dry_run": True}}) == RunMode.WEBSERVER
    assert _probe_runmode({"mode": "trade", "config": {"dry_run": True}}) == RunMode.DRY_RUN
    assert _probe_runmode({"mode": "trade", "config": {"dry_run": False}}) == RunMode.LIVE


@pytest.mark.asyncio
async def test_signal_token_rejects_missing_and_wrong():
    config = {"app": {"signal_token": "right-token"}}

    with pytest.raises(HTTPException) as missing:
        await require_signal_token(None, config)
    assert missing.value.status_code == 401

    with pytest.raises(HTTPException) as wrong:
        await require_signal_token("wrong-token", config)
    assert wrong.value.status_code == 401

    # Correct token passes silently.
    assert await require_signal_token("right-token", config) is None


@pytest.mark.asyncio
async def test_signal_token_unconfigured_is_503():
    with pytest.raises(HTTPException) as exc:
        await require_signal_token("anything", {"app": {}})
    assert exc.value.status_code == 503
