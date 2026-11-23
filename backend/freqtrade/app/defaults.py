"""
Default configuration for the self-hosted application mode.

Every key here exists for a reason; the list mirrors
``SCHEMA_TRADE_REQUIRED`` + ``SCHEMA_MINIMAL_WEBSERVER`` in
``freqtrade/config_schema/config_schema.py`` so that the *same* store is valid
for both modes (shell / trade) without rewriting the file when the user
switches mode.

Values are deliberately conservative:

* ``dry_run: true``           -- a fresh install never touches real money
* ``exchange.name: "okx"``    -- changeable from the UI; only used in trade mode
* ``stake_amount: "unlimited"``-- freqtrade divides the wallet by max_open_trades
* ``api_server`` bound to loopback with generated credentials
"""

from __future__ import annotations

from typing import Any


# Seconds between bot iterations. 5s keeps the UI responsive without busy-looping.
DEFAULT_PROCESS_THROTTLE_SECS = 5

DEFAULT_API_PORT = 8080
DEFAULT_API_HOST = "127.0.0.1"


def base_config(*, username: str, password: str, jwt_secret_key: str) -> dict[str, Any]:
    """Return a config dict that satisfies both the webserver and the trade schema."""
    return {
        "bot_name": "freqtrade-app",
        "max_open_trades": 3,
        "stake_currency": "USDT",
        "stake_amount": "unlimited",
        "tradable_balance_ratio": 0.99,
        "last_stake_amount_min_ratio": 0.5,
        "fiat_display_currency": "USD",
        "dry_run": True,
        "dry_run_wallet": 1000,
        "cancel_open_orders_on_exit": False,
        "trading_mode": "spot",
        "margin_mode": "",
        "timeframe": "5m",
        "strategy": "SampleStrategy",
        "initial_state": "running",
        # Required for the external signal API and /forceenter. Upstream defaults
        # to False; here the whole point is machine-driven entry, and both the
        # signal token and admin auth gate every call. Flip it off in the UI if
        # this bot must never be entered manually.
        "force_entry_enable": True,
        "stoploss": -0.10,
        "minimal_roi": {"0": 0.10},
        "order_types": {
            "entry": "limit",
            "exit": "limit",
            "emergency_exit": "market",
            "force_exit": "market",
            "force_entry": "market",
            "stoploss": "market",
            "stoploss_on_exchange": False,
        },
        "entry_pricing": {
            "price_side": "same",
            "use_order_book": True,
            "order_book_top": 1,
            "price_last_balance": 0.0,
            "check_depth_of_market": {"enabled": False, "bids_to_ask_delta": 1},
        },
        "exit_pricing": {
            "price_side": "same",
            "use_order_book": True,
            "order_book_top": 1,
        },
        "exchange": {
            "name": "okx",
            "key": "",
            "secret": "",
            "password": "",
            "ccxt_config": {},
            "ccxt_async_config": {},
            "pair_whitelist": ["BTC/USDT", "ETH/USDT"],
            "pair_blacklist": [],
        },
        "pairlists": [{"method": "StaticPairList"}],
        "internals": {
            "process_throttle_secs": DEFAULT_PROCESS_THROTTLE_SECS,
            # sd_notify only makes sense under systemd; harmless otherwise.
            "heartbeat_interval": 60,
        },
        "dataformat_ohlcv": "feather",
        "dataformat_trades": "feather",
        "telegram": {"enabled": False, "token": "", "chat_id": ""},
        "api_server": {
            "enabled": True,
            "listen_ip_address": DEFAULT_API_HOST,
            "listen_port": DEFAULT_API_PORT,
            "verbosity": "error",
            "enable_openapi": False,
            "CORS_origins": [],
            "username": username,
            "password": password,
            "jwt_secret_key": jwt_secret_key,
            "ws_token": "",
        },
    }


# Config keys that can only take effect after the process is restarted.
# Everything else is applied through freqtrade's own RELOAD_CONFIG cycle.
RESTART_ONLY_PATHS: tuple[tuple[str, ...], ...] = (
    ("api_server", "listen_ip_address"),
    ("api_server", "listen_port"),
    ("api_server", "enabled"),
    ("db_url",),
)

# Values that must never leave the process through the HTTP API.
SECRET_KEY_NAMES = frozenset(
    {
        "key",
        "secret",
        "api_key",
        "apikey",
        "password",
        "jwt_secret_key",
        "ws_token",
        "signal_token",
        "token",
        "chat_id",
        "webhook_url",
        "discord_webhook_url",
        "api_secret",
    }
)
MASK = "***redacted***"
