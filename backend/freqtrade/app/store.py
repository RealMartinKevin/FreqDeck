"""
Persistent application state: configuration store + generated credentials.

Why a JSON file instead of SQLite:

* the store is read by ``Configuration.load_config()`` on *every* config build
  (including ``RELOAD_CONFIG`` cycles) -- a 0600 JSON file is atomic to replace
  and trivially inspectable when something goes wrong
* there is exactly one writer (the bot process), so no concurrent-write story
  is needed
* freqtrade itself already keeps its real state (trades, orders) in SQLite; the
  config store must not become a second source of truth for trading data

Security posture: credentials are stored in plaintext inside a ``0600`` file,
which is the same posture as upstream freqtrade's ``config.json``. Obfuscating
them (hash) would break HTTP Basic auth and JWT signing without adding real
protection, because the process must be able to read the secret anyway.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import tempfile
from contextlib import suppress
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from freqtrade.app.defaults import (
    MASK,
    SECRET_KEY_NAMES,
    base_config,
)


logger = logging.getLogger(__name__)

DEFAULT_STATE_SCHEMA = 1
APP_DIRNAME = "app"
STATE_FILENAME = "state.json"

STATE_FILE_MODE = 0o600
APP_DIR_MODE = 0o700

MODE_SHELL = "shell"
MODE_TRADE = "trade"
VALID_MODES = (MODE_SHELL, MODE_TRADE)


# --------------------------------------------------------------------------- paths


def app_dir(user_data_dir: str | Path) -> Path:
    return Path(user_data_dir).expanduser().resolve() / APP_DIRNAME


def state_path(user_data_dir: str | Path) -> Path:
    return app_dir(user_data_dir) / STATE_FILENAME


# ----------------------------------------------------------------------- creds


def generate_password(nbytes: int = 15) -> str:
    """URL-safe password, no shell metacharacters."""
    return secrets.token_urlsafe(nbytes)


def generate_token(nbytes: int = 32) -> str:
    """Token for machine-to-machine callers (signal API)."""
    return secrets.token_hex(nbytes)


# ------------------------------------------------------------------ persistence


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def save_state(path: Path, state: dict[str, Any]) -> None:
    """
    Atomic write with restrictive permissions.

    ``os.replace`` on the same filesystem is atomic, so a crash mid-write can
    never leave a truncated state file behind -- which would look like "user
    deleted the config" on the next start.
    """
    path.parent.mkdir(parents=True, exist_ok=True, mode=APP_DIR_MODE)
    payload = json.dumps(state, indent=2, ensure_ascii=False, sort_keys=False)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".state-", suffix=".tmp")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        tmp_path.chmod(STATE_FILE_MODE)
        tmp_path.replace(path)
    except Exception:
        with suppress(OSError):
            tmp_path.unlink()
        raise
    # mkstemp creates 0600 already, but be explicit for pre-existing targets.
    with suppress(OSError):
        path.chmod(STATE_FILE_MODE)


def load_state(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        state = json.load(handle)
    if not isinstance(state, dict):
        raise ValueError(f"state file {path} is not a JSON object")
    return state


# ------------------------------------------------------------------- bootstrap


def _ensure_user_data(user_data_dir: Path) -> None:
    """Create the directories freqtrade expects, without touching existing ones."""
    (user_data_dir / "strategies").mkdir(parents=True, exist_ok=True)
    (user_data_dir / "data").mkdir(parents=True, exist_ok=True)
    (user_data_dir / "logs").mkdir(parents=True, exist_ok=True)
    (user_data_dir / "notebooks").mkdir(parents=True, exist_ok=True)

    # A fresh install has no strategy, and a strategy name that cannot be
    # resolved makes trade mode die at startup. Ship the upstream sample so the
    # very first "start trading" is not a crash.
    strategies = user_data_dir / "strategies"
    if not any(strategies.glob("*.py")):
        template = Path(__file__).resolve().parent.parent / "templates" / "sample_strategy.py"
        if template.is_file():
            shutil.copyfile(template, strategies / "sample_strategy.py")
            logger.info("Copied sample strategy to %s", strategies / "sample_strategy.py")


def _new_state(user_data_dir: Path) -> dict[str, Any]:
    username = "admin"
    password = generate_password()
    jwt_secret_key = secrets.token_hex(32)
    config = base_config(username=username, password=password, jwt_secret_key=jwt_secret_key)
    config["app"] = {
        # Machine-to-machine credential for the external signal API. Kept apart
        # from the admin password so a webhook integration never holds admin rights.
        "signal_token": generate_token(),
        # None -> fall back to freqtrade's bundled UI directory.
        "ui_path": None,
    }
    return {
        "schema": DEFAULT_STATE_SCHEMA,
        "created_at": _now(),
        "updated_at": _now(),
        "mode": MODE_SHELL,
        "config": config,
        "last_error": None,
    }


def _migrate(state: dict[str, Any], user_data_dir: Path) -> tuple[dict[str, Any], bool]:
    """
    Fill in anything a previous version (or a manual edit) left out.
    Returns (state, changed).
    """
    changed = False
    if state.get("schema") != DEFAULT_STATE_SCHEMA:
        state["schema"] = DEFAULT_STATE_SCHEMA
        changed = True
    if state.get("mode") not in VALID_MODES:
        state["mode"] = MODE_SHELL
        changed = True
    if "config" not in state or not isinstance(state["config"], dict):
        state["config"] = base_config(
            username="admin",
            password=generate_password(),
            jwt_secret_key=secrets.token_hex(32),
        )
        changed = True

    cfg = state["config"]
    api = cfg.setdefault("api_server", {})
    for key, generator in (
        ("username", lambda: "admin"),
        ("password", generate_password),
        ("jwt_secret_key", lambda: secrets.token_hex(32)),
    ):
        if not api.get(key):
            api[key] = generator()
            changed = True

    app_cfg = cfg.setdefault("app", {})
    if not app_cfg.get("signal_token"):
        app_cfg["signal_token"] = generate_token()
        changed = True
    if "last_error" not in state:
        state["last_error"] = None
        changed = True
    return state, changed


def ensure_state(user_data_dir: str | Path) -> tuple[dict[str, Any], bool]:
    """
    Load the state, creating it (with freshly generated credentials) if missing.

    :return: (state, was_created)
    """
    user_data_dir = Path(user_data_dir).expanduser().resolve()
    _ensure_user_data(user_data_dir)
    path = state_path(user_data_dir)
    if path.is_file():
        state, changed = _migrate(load_state(path), user_data_dir)
        if changed:
            state["updated_at"] = _now()
            save_state(path, state)
            logger.warning("State file migrated in place: %s", path)
        return state, False

    state = _new_state(user_data_dir)
    save_state(path, state)
    logger.warning("Created new application state with generated credentials: %s", path)
    return state, True


# ------------------------------------------------------------------ mutations


def touch(state: dict[str, Any]) -> None:
    state["updated_at"] = _now()


def set_mode(state: dict[str, Any], mode: str) -> None:
    if mode not in VALID_MODES:
        raise ValueError(f"invalid mode {mode!r}, expected one of {VALID_MODES}")
    state["mode"] = mode
    touch(state)


def set_last_error(state: dict[str, Any], message: str | None) -> None:
    state["last_error"] = message
    touch(state)


def set_password(state: dict[str, Any], new_password: str) -> None:
    state["config"]["api_server"]["password"] = new_password
    touch(state)


# ------------------------------------------------------------------ redaction


def redact_value(key: str, value: Any) -> Any:
    if isinstance(value, dict):
        return redact_config(value)
    if isinstance(value, (list, tuple)):
        return [redact_value(key, item) for item in value]
    if key.lower() in SECRET_KEY_NAMES and value not in (None, "", [], {}):
        return MASK
    return value


def redact_config(config: dict[str, Any]) -> dict[str, Any]:
    """Deep copy with secrets masked; safe to return over HTTP."""
    result: dict[str, Any] = {}
    for key, value in deepcopy(config).items():
        result[key] = redact_value(key, value)
    return result


def unredact_merge(current: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """
    Merge a client-supplied config into the stored one, keeping stored secrets
    when the client echoes back the mask.

    Without this, a browser that loads the redacted config and saves it back
    would overwrite the real exchange keys with the literal mask string --
    a silent, very annoying way to lose credentials.
    """
    merged = deepcopy(current)
    for key, value in incoming.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = unredact_merge(merged[key], value)
            continue
        if value == MASK:
            # Client did not change this secret -> keep what we already have.
            continue
        merged[key] = value
    return merged


def get_nested(config: dict[str, Any], path: tuple[str, ...]) -> Any:
    node: Any = config
    for part in path:
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node
