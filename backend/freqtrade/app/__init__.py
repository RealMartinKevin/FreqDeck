"""
Self-hosted application layer.

This package turns freqtrade from a "config-file driven CLI" into a
"single self-contained application":

* configuration lives in a local store (``user_data/app/state.json``),
  not in a hand-written ``config.json``
* credentials are generated on first start, never asked for interactively
* the process starts unconditionally: no config file, no subcommand required
* everything is edited through the Web UI / HTTP API

Design constraints that shaped this package (verified against the code, not assumed):

1. ``Configuration.load_config()`` is the single funnel where the config dict
   is produced. Injecting there keeps every existing user (Worker, backtesting,
   webserver) working unchanged.
2. freqtrade cannot trade without reachable exchange markets. A boot that dies
   because the exchange is unreachable is not "unconditional", therefore the
   default mode is ``shell`` (API + UI only, no exchange connection) and the
   user switches to ``trade`` from the UI once the exchange is reachable.
3. Config changes are applied by freqtrade's own ``RELOAD_CONFIG`` state
   (``Worker._reconfigure`` rebuilds the bot from a re-read config), so most
   settings apply without restarting the process.
"""

from freqtrade.app.store import (  # noqa: F401
    DEFAULT_STATE_SCHEMA,
    app_dir,
    ensure_state,
    load_state,
    redact_config,
    state_path,
)
