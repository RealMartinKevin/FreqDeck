"""
Runtime dispatch for the self-hosted application.

Two modes, one entry point:

``shell``
    API server + Web UI only. No exchange connection, no strategy resolution,
    no network. This is what makes the start truly unconditional: it works with
    zero configuration, zero credentials and zero connectivity.

``trade``
    The normal freqtrade worker (exchange + strategy + trading loop). The API
    server is started by the bot itself (non-standalone), exactly as upstream.

Mode is persisted in the state file, so a plain ``os.execv`` re-enters this
function and picks the new mode up -- no systemd, no supervisor, no second
process to keep in sync.

Failure policy: if ``trade`` cannot boot (exchange unreachable, bad strategy,
missing keys), the error is recorded and the process falls back to ``shell``
instead of exiting. A bot that dies on a network hiccup must not take its own
control panel down with it.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

from freqtrade.app.store import (
    MODE_SHELL,
    MODE_TRADE,
    ensure_state,
    save_state,
    set_last_error,
    set_mode,
    state_path,
)
from freqtrade.enums import RunMode


logger = logging.getLogger(__name__)

USER_DATA_DIR_ARG = "user_data_dir"
BANNER_WIDTH = 62

# The API server runs inside the same process but its handlers never see the
# CLI ``args`` dict. This module-level handle is how they reach the store.
_current_state_path: Path | None = None

# Raw CLI argv, so a re-exec reproduces the *same* invocation (notably
# ``--user-data-dir``; dropping it silently points the new process at a
# different state file, i.e. different credentials and a different mode).
_invocation_argv: list[str] = []


def capture_invocation_argv(argv: list[str] | None = None) -> None:
    global _invocation_argv
    _invocation_argv = list(sys.argv[1:] if argv is None else argv)


def invocation_argv() -> list[str]:
    return list(_invocation_argv) or ["app"]


def set_current_state_path(path: Path | str | None) -> None:
    global _current_state_path
    _current_state_path = Path(path).resolve() if path else None


def current_state_path() -> Path:
    if _current_state_path is None:
        raise RuntimeError("app state path is not initialised (not running in app mode)")
    return _current_state_path


def resolve_user_data_dir(args: dict[str, Any]) -> Path:
    raw = args.get(USER_DATA_DIR_ARG) or "user_data"
    return Path(raw).expanduser().resolve()


def load_app_state(args: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """
    Load (or create) the state and wire it into ``args`` for ``Configuration``.

    ``args["config"]`` is cleared on purpose: in app mode the store is the only
    configuration source. Passing ``-c`` on the command line therefore cannot
    silently reintroduce a second source of truth.
    """
    user_data_dir = resolve_user_data_dir(args)
    state, created = ensure_state(user_data_dir)
    path = state_path(user_data_dir)
    args[USER_DATA_DIR_ARG] = str(user_data_dir)
    args["config"] = []
    # Inject the *path*, not the dict. freqtrade re-runs Configuration on every
    # RELOAD_CONFIG cycle; a snapshot in args would silently reload the config
    # the process started with instead of the one the user just saved.
    args["app_state_path"] = str(path)
    set_current_state_path(path)
    return state, created


def print_banner(state: dict[str, Any], path: Path) -> None:
    """Print generated credentials exactly once -- on first initialisation."""
    api = state["config"]["api_server"]
    app_cfg = state["config"].get("app", {})
    host = api.get("listen_ip_address", "127.0.0.1")
    port = api.get("listen_port", 8080)
    if host in ("0.0.0.0", "::"):  # noqa: S104 - only used to print a usable URL
        host = "127.0.0.1"
    lines = [
        "",
        "=" * BANNER_WIDTH,
        " freqtrade app initialised. Credentials were generated (shown once):",
        f"   state file : {path}  (mode 0600)",
        f"   username   : {api['username']}",
        f"   password   : {api['password']}",
        f"   jwt secret : {api['jwt_secret_key']}",
        f"   signal tok : {app_cfg.get('signal_token', '')}",
        f"   web ui     : http://{host}:{port}/",
        "=" * BANNER_WIDTH,
        "",
    ]
    print("\n".join(lines), flush=True)


def _run_shell(args: dict[str, Any]) -> int:
    from freqtrade.configuration import setup_utils_configuration
    from freqtrade.rpc.api_server import ApiServer

    config = setup_utils_configuration(args, RunMode.WEBSERVER, set_dry=False)
    api = config.setdefault("api_server", {})
    if not api.get("enabled"):
        logger.warning(
            "api_server.enabled is False in the stored config; "
            "forcing it on so the UI stays reachable"
        )
        api["enabled"] = True
    ApiServer(config, standalone=True)
    return 0


def _run_trade(args: dict[str, Any]) -> int:
    from freqtrade.commands.trade_commands import start_trading

    return start_trading(args)


def load_current_state() -> dict[str, Any]:
    """Read the store from disk. Cheap (a few KB) and always consistent with writes."""
    from freqtrade.app.store import load_state

    return load_state(current_state_path())


def _persist_mode(mode: str, error: str | None = None) -> None:
    state = load_current_state()
    set_mode(state, mode)
    set_last_error(state, error)
    save_state(current_state_path(), state)


def run(args: dict[str, Any]) -> int:
    capture_invocation_argv()
    state, created = load_app_state(args)
    path = Path(args["app_state_path"])
    if created:
        print_banner(state, path)

    if state["mode"] == MODE_TRADE:
        logger.info("App mode: trade (state=%s)", path)
        try:
            return _run_trade(args)
        except Exception as exc:
            logger.exception("Trade mode failed to start; falling back to shell mode")
            _persist_mode(MODE_SHELL, f"{type(exc).__name__}: {exc}")
            state["mode"] = MODE_SHELL
    else:
        logger.info("App mode: shell (state=%s)", path)

    return _run_shell(args)


# ---------------------------------------------------------------- process cycle


def schedule_reexec(delay: float = 0.5, argv: list[str] | None = None) -> None:
    """
    Replace the current process image with a fresh app process after ``delay``.

    ``execv`` keeps the PID and inherits the environment, so systemd units with
    ``Restart=always`` and plain foreground runs behave identically. Sockets are
    opened with ``O_CLOEXEC`` by CPython (PEP 446), so the listening port is
    released by the exec -- otherwise every mode switch would hit "address in use".
    """
    target = [sys.executable, "-m", "freqtrade", *(argv or invocation_argv())]

    def _worker() -> None:
        time.sleep(delay)
        logger.warning("Re-executing: %s", " ".join(target))
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:  # pragma: no cover - flush must never block the exec
            logger.debug("Flushing streams before exec failed", exc_info=True)
        # Intentional: replace this process image with the same invocation.
        os.execv(sys.executable, target)  # noqa: S606

    threading.Thread(target=_worker, daemon=True, name="app-reexec").start()


def switch_mode(mode: str) -> None:
    """Persist the requested mode and re-exec into it."""
    _persist_mode(mode)
    schedule_reexec()
