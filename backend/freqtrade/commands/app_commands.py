import logging
from typing import Any


logger = logging.getLogger(__name__)


def start_app(args: dict[str, Any]) -> int:
    """
    Entry point for the self-hosted application.

    Deliberately thin: the mode decision, config injection and failure handling
    all live in ``freqtrade.app.runtime`` so this stays a one-liner in the
    command table (same shape as every other ``start_*`` command).
    """
    from freqtrade.app.runtime import run

    return run(args)
