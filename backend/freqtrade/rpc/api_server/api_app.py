"""
HTTP surface of the self-hosted app.

Three concerns live here, all of them new relative to upstream freqtrade:

1. **Configuration as a resource** -- read/write the store instead of editing
   ``config.json`` by hand. Writes are applied through freqtrade's own
   ``RELOAD_CONFIG`` cycle; only a short list of keys needs a process restart
   (see ``RESTART_ONLY_PATHS``).
2. **Mode switching** -- ``shell`` (API + UI) <-> ``trade`` (bot). Implemented
   as a persisted flag plus ``os.execv``; see ``freqtrade.app.runtime``.
3. **External signal API** -- a minimal, token-scoped endpoint for machine
   callers. It deliberately does *not* reuse the admin password: a webhook
   integration should never hold admin rights, and rotating the signal token
   must not lock the operator out of the UI.

Ordering matters: ``router_signal`` is registered without the
``http_basic_or_jwt_token`` dependency, everything else with it.
"""

from __future__ import annotations

import logging
import secrets
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, Field

from freqtrade.app.defaults import RESTART_ONLY_PATHS
from freqtrade.app.runtime import (
    current_state_path,
    load_current_state,
    schedule_reexec,
    switch_mode,
)
from freqtrade.app.store import (
    MODE_SHELL,
    MODE_TRADE,
    VALID_MODES,
    get_nested,
    redact_config,
    save_state,
    set_last_error,
    set_password,
    touch,
    unredact_merge,
)
from freqtrade.enums import TRADE_MODES, RunMode
from freqtrade.exceptions import ConfigurationError
from freqtrade.persistence import Trade
from freqtrade.rpc.api_server.deps import get_config, get_rpc_optional
from freqtrade.rpc.rpc import RPC, RPCException


logger = logging.getLogger(__name__)

router_app = APIRouter(tags=["App"])
router_signal = APIRouter(tags=["Signal"])

signal_header = APIKeyHeader(name="X-Signal-Token", auto_error=False)


# --------------------------------------------------------------------- schemas


class AppInfo(BaseModel):
    version: str
    mode: str
    runmode: str
    dry_run: bool
    trading_active: bool
    exchange: str
    strategy: str | None
    state_file: str
    last_error: str | None = None
    ui_ready: bool = False


class AppConfigOut(BaseModel):
    config: dict[str, Any]
    mode: str
    restart_only_paths: list[list[str]]


class AppConfigIn(BaseModel):
    config: dict[str, Any] = Field(
        description="Partial config; deep-merged into the stored config. "
        "Secret fields set to the redaction mask are kept unchanged."
    )
    apply: bool = Field(default=True, description="Trigger a config reload after saving")


class AppConfigSaved(BaseModel):
    saved: bool
    applied: str = Field(description="reloaded | reload_pending | restart_required | shell_mode")
    changed: list[str] = []
    restart_required_for: list[str] = []


class ModeRequest(BaseModel):
    mode: Literal["shell", "trade"]


class ModeAccepted(BaseModel):
    accepted: bool
    mode: str = Field(description="Current app mode: shell | trade. Never an action result.")
    outcome: str | None = Field(
        default=None,
        description=(
            "What the action did: switching | reloaded | reload_pending | reload_failed | "
            "password_updated | restarting. Kept separate from `mode` so clients that read "
            "`mode` never receive a non-mode string."
        ),
    )
    message: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, description="Minimum 8 characters")


class SignalRequest(BaseModel):
    action: Literal["buy", "sell", "close", "close_all"]
    pair: str | None = Field(default=None, description="Required for buy/sell")
    trade_id: int | None = Field(default=None, description="Preferred for close")
    stake_amount: float | str | None = Field(
        default=None, description='Stake for the entry; "unlimited" uses the configured split'
    )
    price: float | None = None
    order_type: Literal["market", "limit"] | None = None
    leverage: float | None = None
    tag: str | None = Field(default=None, description="Enter tag, defaults to external_signal")


class SignalResult(BaseModel):
    ok: bool
    action: str
    results: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []


# ------------------------------------------------------------------ dependencies


async def require_signal_token(
    token: Annotated[str | None, Depends(signal_header)],
    config: dict[str, Any] = Depends(get_config),
) -> None:
    expected = (config.get("app") or {}).get("signal_token")
    if not expected:
        raise HTTPException(status_code=503, detail="signal_token is not configured")
    if not token or not secrets.compare_digest(str(token), str(expected)):
        raise HTTPException(status_code=401, detail="invalid signal token")


def _require_app_mode() -> dict[str, Any]:
    try:
        return load_current_state()
    except (RuntimeError, FileNotFoundError) as exc:
        raise HTTPException(status_code=503, detail=f"app state unavailable: {exc}") from exc


def _restart_only_changed(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    changed = []
    for path in RESTART_ONLY_PATHS:
        if get_nested(old, path) != get_nested(new, path):
            changed.append(".".join(path))
    return changed


def _probe_runmode(state: dict[str, Any]) -> RunMode:
    if state.get("mode") == MODE_TRADE:
        return RunMode.DRY_RUN if state["config"].get("dry_run", True) else RunMode.LIVE
    return RunMode.WEBSERVER


# ---------------------------------------------------------------- app endpoints


@router_app.get("/app/info", response_model=AppInfo, summary="App runtime information")
def app_info(config: dict[str, Any] = Depends(get_config)):
    from freqtrade import __version__
    from freqtrade.rpc.api_server.webserver import ApiServer

    state = _require_app_mode()
    ui_path = (config.get("app") or {}).get("ui_path")
    if ui_path:
        ui_ready = (Path(ui_path) / "index.html").is_file()
    else:
        ui_ready = (Path(__file__).parent / "ui" / "installed" / "index.html").is_file()
    return AppInfo(
        version=__version__,
        mode=state.get("mode", MODE_SHELL),
        runmode=str(config.get("runmode", RunMode.OTHER)),
        dry_run=bool(config.get("dry_run", True)),
        trading_active=ApiServer._has_rpc,
        exchange=(config.get("exchange") or {}).get("name", ""),
        strategy=config.get("strategy"),
        state_file=str(current_state_path()),
        last_error=state.get("last_error"),
        ui_ready=ui_ready,
    )


@router_app.get(
    "/app/config", response_model=AppConfigOut, summary="Read configuration (secrets masked)"
)
def app_get_config(config: dict[str, Any] = Depends(get_config)):
    state = _require_app_mode()
    return AppConfigOut(
        config=redact_config(state["config"]),
        mode=state.get("mode", MODE_SHELL),
        restart_only_paths=[list(p) for p in RESTART_ONLY_PATHS],
    )


def _sync_live_config(new_config: dict[str, Any]) -> None:
    """
    Push saved values into the *live* config object without replacing it.

    Replacing ``ApiServer._config`` wholesale is wrong: the live dict also holds
    keys that ``Configuration`` derived at load time (``runmode``,
    ``user_data_dir``, ``datadir``, ...) which never appear in the store. Dropping
    them silently breaks every consumer of ``config["runmode"]`` -- starting with
    ``is_webserver_mode`` / ``is_trading_mode``.
    """
    from copy import deepcopy

    from freqtrade.rpc.api_server.webserver import ApiServer

    live = ApiServer._config
    if not live:
        return
    for key, value in new_config.items():
        live[key] = deepcopy(value)


def _validate_ui_path(new_config: dict[str, Any]) -> None:
    """
    Refuse UI roots that would turn the static-file handler into a file browser.

    The SPA handler serves anything under ``app.ui_path``. Pointing it at the
    user-data directory -- or at ``/`` -- would expose ``app/state.json``, which
    holds the plaintext admin password and exchange keys. Admin auth already
    grants config access, but it must not grant arbitrary filesystem reads.
    """
    raw = ((new_config.get("app") or {}).get("ui_path")) or ""
    raw = str(raw).strip()
    if not raw:
        return
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="app.ui_path must be an absolute path")
    resolved = candidate.resolve()
    if resolved == Path(resolved.anchor):
        raise HTTPException(status_code=400, detail="app.ui_path must not be a filesystem root")
    try:
        state = current_state_path().resolve()
    except RuntimeError:  # pragma: no cover - state not initialised
        return
    if state == resolved or state.is_relative_to(resolved):
        raise HTTPException(
            status_code=400,
            detail="app.ui_path must not contain the app state file (credential leak)",
        )


def _validate(new_config: dict[str, Any], state: dict[str, Any]) -> None:
    from copy import deepcopy

    from freqtrade.configuration.config_validation import validate_config_schema

    # Validate a copy: freqtrade's validator injects schema defaults, and letting
    # it mutate the real dict would silently expand the stored config and make the
    # "changed" diff report keys the user never touched.
    probe = deepcopy(new_config)
    probe["runmode"] = _probe_runmode(state)
    try:
        validate_config_schema(probe, preliminary=True)
    except ConfigurationError as exc:
        raise HTTPException(status_code=400, detail=f"invalid configuration: {exc}") from exc


@router_app.put("/app/config", response_model=AppConfigSaved, summary="Update configuration")
def app_put_config(payload: AppConfigIn, config: dict[str, Any] = Depends(get_config)):
    state = _require_app_mode()
    old_config = state["config"]
    merged = unredact_merge(old_config, payload.config)
    _validate(merged, state)
    _validate_ui_path(merged)

    changed = sorted(
        key for key in set(old_config) | set(merged) if old_config.get(key) != merged.get(key)
    )
    restart_for = _restart_only_changed(old_config, merged)

    state["config"] = merged
    touch(state)
    save_state(current_state_path(), state)

    # Keep the in-process view consistent so an immediate GET reflects the write,
    # even before the reload cycle completes.
    _sync_live_config(merged)

    if not payload.apply:
        return AppConfigSaved(saved=True, applied="reload_pending", changed=changed)

    if state.get("mode") != MODE_TRADE:
        return AppConfigSaved(
            saved=True,
            applied="shell_mode",
            changed=changed,
            restart_required_for=restart_for,
        )

    if restart_for:
        # Still reload what can be reloaded; the listed keys only take effect on restart.
        _trigger_reload()
        return AppConfigSaved(
            saved=True,
            applied="reload_pending",
            changed=changed,
            restart_required_for=restart_for,
        )

    applied = _trigger_reload()
    return AppConfigSaved(saved=True, applied=applied, changed=changed)


def _trigger_reload() -> str:
    from freqtrade.rpc.api_server.webserver import ApiServer

    if not ApiServer._has_rpc:
        return "shell_mode"
    try:
        ApiServer._rpc._rpc_reload_config()
        return "reloaded"
    except Exception as exc:
        logger.exception("Config reload failed")
        return f"reload_failed: {exc}"


@router_app.post(
    "/app/mode", response_model=ModeAccepted, summary="Switch between shell and trade mode"
)
def app_set_mode(payload: ModeRequest):
    """
    Persist the mode and re-exec the process into it.

    The response is sent before the exec happens (500ms delay in the scheduler),
    so the client always gets a clean 202 instead of a dropped connection.
    """
    if payload.mode not in VALID_MODES:
        raise HTTPException(status_code=400, detail=f"invalid mode {payload.mode!r}")

    state = _require_app_mode()
    if payload.mode == MODE_TRADE:
        cfg = state["config"]
        if not cfg.get("api_server", {}).get("enabled"):
            raise HTTPException(
                status_code=400,
                detail="api_server.enabled must be true to run in trade mode",
            )
        _validate(cfg, {**state, "mode": MODE_TRADE})

    # Clear a previous boot failure so the UI does not show a stale error.
    set_last_error(state, None)
    save_state(current_state_path(), state)
    switch_mode(payload.mode)
    return ModeAccepted(
        accepted=True,
        mode=payload.mode,
        outcome="switching",
        message=(
            "switching to trade mode; the process is restarting"
            if payload.mode == MODE_TRADE
            else "switching to shell mode; the process is restarting"
        ),
    )


@router_app.post(
    "/app/reload", response_model=ModeAccepted, summary="Reload configuration in place"
)
def app_reload():
    applied = _trigger_reload()
    state = _require_app_mode()
    return ModeAccepted(
        accepted=applied == "reloaded",
        mode=state.get("mode", MODE_SHELL),
        outcome=applied,
        message=applied,
    )


@router_app.post("/app/password", response_model=ModeAccepted, summary="Rotate the admin password")
def app_change_password(payload: PasswordChange, config: dict[str, Any] = Depends(get_config)):
    api = config.get("api_server", {})
    if not secrets.compare_digest(str(payload.current_password), str(api.get("password", ""))):
        raise HTTPException(status_code=403, detail="current password is incorrect")

    state = _require_app_mode()
    set_password(state, payload.new_password)
    save_state(current_state_path(), state)
    _sync_live_config(state["config"])
    return ModeAccepted(
        accepted=True,
        mode=state.get("mode", MODE_SHELL),
        outcome="password_updated",
        message="password updated; existing JWTs stay valid until they expire",
    )


@router_app.post("/app/restart", response_model=ModeAccepted, summary="Restart the process")
def app_restart():
    """
    Restart by re-exec. Needed only for the keys listed in ``restart_only_paths``
    (listen address/port, db_url); everything else is hot-reloadable.
    """
    state = _require_app_mode()
    schedule_reexec()
    return ModeAccepted(
        accepted=True,
        mode=state.get("mode", MODE_SHELL),
        outcome="restarting",
        message="process is restarting",
    )


# ------------------------------------------------------------------ signal API


def _open_trades_for_pair(pair: str) -> list[Trade]:
    return [trade for trade in Trade.get_open_trades() if trade.pair == pair]


@router_signal.post(
    "/signal",
    response_model=SignalResult,
    dependencies=[Depends(require_signal_token)],
    summary="External trading signal (force entry/exit)",
)
def post_signal(  # noqa: C901 - one dispatcher over four actions, splitting hurts readability
    payload: SignalRequest,
    rpc: RPC | None = Depends(get_rpc_optional),
    config: dict[str, Any] = Depends(get_config),
) -> SignalResult:
    """
    Immediate force entry / exit, driven by an external system.

    This is intentionally *not* a strategy hook: it executes now, bypassing
    entry signals, and only respects the guards freqtrade itself applies inside
    ``_rpc_force_entry`` / ``_rpc_force_exit`` (pair whitelist, max_open_trades,
    stake limits, protection locks). Anything that should go through normal
    strategy logic does not belong here.
    """
    if config.get("runmode") not in TRADE_MODES or rpc is None:
        raise HTTPException(
            status_code=503,
            detail=f"bot is not trading (runmode={config.get('runmode')})",
        )

    results: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    def _record_error(exc: Exception, **context: Any) -> None:
        detail = exc.message if isinstance(exc, RPCException) else str(exc)
        errors.append({**context, "error": type(exc).__name__, "detail": detail})

    def _enter(side: str) -> None:
        if not payload.pair:
            raise HTTPException(status_code=400, detail="pair is required for buy/sell")
        if not config.get("force_entry_enable", False):
            # Upstream gate. Report it as a precondition failure (409) instead of
            # letting the RPCException bubble up as an opaque 500.
            raise HTTPException(
                status_code=409,
                detail=(
                    "force_entry_enable is false in the stored config; "
                    "signal-driven entry is disabled"
                ),
            )
        if side == "short" and config.get("trading_mode", "spot") == "spot":
            raise HTTPException(
                status_code=400,
                detail="short entries require futures trading_mode; current mode is spot",
            )
        try:
            trade = rpc._rpc_force_entry(
                payload.pair,
                payload.price,
                order_side=side,
                order_type=payload.order_type,
                stake_amount=payload.stake_amount,
                enter_tag=payload.tag or "external_signal",
                leverage=payload.leverage,
            )
        except (RPCException, HTTPException):
            raise
        except Exception as exc:
            _record_error(exc, pair=payload.pair, side=side)
            return

        if not trade:
            errors.append(
                {
                    "pair": payload.pair,
                    "side": side,
                    "error": "not_entered",
                    "detail": "force_entry returned no trade",
                }
            )
            return
        results.append(
            {
                "trade_id": trade.id,
                "pair": trade.pair,
                "side": trade.trade_direction,
                "status": "entered",
            }
        )

    def _exit_trade(trade: Trade) -> None:
        try:
            rpc._rpc_force_exit(str(trade.id), payload.order_type, amount=None, price=payload.price)
            results.append(
                {
                    "trade_id": trade.id,
                    "pair": trade.pair,
                    "side": trade.trade_direction,
                    "status": "exited",
                }
            )
        except Exception as exc:
            _record_error(exc, trade_id=trade.id, pair=trade.pair)

    try:
        if payload.action == "buy":
            _enter("long")
        elif payload.action == "sell":
            _enter("short")
        elif payload.action == "close":
            if payload.trade_id is not None:
                _exit_trade_for_id(payload.trade_id, rpc, payload, results, errors)
            elif payload.pair:
                targets = _open_trades_for_pair(payload.pair)
                if not targets:
                    errors.append(
                        {
                            "pair": payload.pair,
                            "error": "no_open_trade",
                            "detail": "no open trade for pair",
                        }
                    )
                for trade in targets:
                    _exit_trade(trade)
            else:
                raise HTTPException(
                    status_code=400, detail="trade_id or pair is required for close"
                )
        elif payload.action == "close_all":
            for trade in Trade.get_open_trades():
                _exit_trade(trade)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"signal failed: {exc}") from exc

    return SignalResult(
        ok=not errors,
        action=payload.action,
        results=results,
        errors=errors,
    )


def _exit_trade_for_id(
    trade_id: int,
    rpc: RPC,
    payload: SignalRequest,
    results: list[dict[str, Any]],
    errors: list[dict[str, Any]],
) -> None:
    """
    Exit by id.

    ``Trade.get_trades_proxy`` is avoided on purpose: it opens a DB session that
    would outlive the request. ``_rpc_force_exit`` already validates existence and
    reports a missing trade as ``RPCException``.
    """
    try:
        rpc._rpc_force_exit(str(trade_id), payload.order_type, amount=None, price=payload.price)
        results.append({"trade_id": trade_id, "pair": None, "side": None, "status": "exited"})
    except Exception as exc:
        detail = exc.message if isinstance(exc, RPCException) else str(exc)
        errors.append(
            {
                "trade_id": trade_id,
                "error": type(exc).__name__,
                "detail": detail,
            }
        )


@router_signal.get(
    "/signal/health",
    dependencies=[Depends(require_signal_token)],
    summary="Signal channel health",
)
def signal_health(config: dict[str, Any] = Depends(get_config)) -> dict[str, Any]:
    return {
        "ok": config.get("runmode") in TRADE_MODES,
        "runmode": str(config.get("runmode")),
        "dry_run": bool(config.get("dry_run", True)),
        "actions": ["buy", "sell", "close", "close_all"],
        "open_trades": len(Trade.get_open_trades()) if config.get("runmode") in TRADE_MODES else 0,
    }
