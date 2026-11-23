from pathlib import Path

from fastapi import APIRouter
from fastapi.exceptions import HTTPException
from starlette.responses import FileResponse


router_ui = APIRouter(include_in_schema=False, tags=["Web UI"])


def bundled_ui_dir() -> Path:
    return Path(__file__).parent / "ui" / "installed"


def ui_base() -> Path:
    """
    Resolve the SPA root.

    ``app.ui_path`` in the config store wins, so a custom frontend can be served
    straight from its build directory (or any release snapshot) without copying
    files into the freqtrade package -- which would pollute the git worktree and
    get wiped by ``pip install -e`` housekeeping.
    """
    try:
        from freqtrade.rpc.api_server.webserver import ApiServer

        config = ApiServer._config or {}
    except Exception:  # pragma: no cover - import cycle safety
        config = {}
    custom = str(((config.get("app") or {}).get("ui_path")) or "").strip()
    if custom:
        candidate = Path(custom).expanduser()
        if candidate.is_dir():
            return candidate.resolve()
    return bundled_ui_dir().resolve()


@router_ui.get("/favicon.ico")
async def favicon():
    base = ui_base()
    for candidate in (base / "favicon.ico", Path(__file__).parent / "ui/favicon.ico"):
        if candidate.is_file():
            return FileResponse(str(candidate))
    return FileResponse(str(Path(__file__).parent / "ui/favicon.ico"))


@router_ui.get("/fallback_file.html")
async def fallback():
    return FileResponse(str(Path(__file__).parent / "ui/fallback_file.html"))


@router_ui.get("/ui_version")
async def ui_version():
    from freqtrade.commands.deploy_ui import read_ui_version

    version = read_ui_version(ui_base())

    return {
        "version": version if version else "custom_or_not_installed",
    }


@router_ui.get("/{rest_of_path:path}")
async def index_html(rest_of_path: str):
    """
    Emulate path fallback to index.html.
    """
    if rest_of_path.startswith(("api", ".")):
        raise HTTPException(status_code=404, detail="Not Found")
    uibase = ui_base()
    filename = (uibase / rest_of_path).resolve()
    # It's security relevant to check "relative_to".
    # Without this, Directory-traversal is possible.
    media_type: str | None = None
    if filename.suffix == ".js":
        # Force text/javascript for .js files - Circumvent faulty system configuration
        media_type = "application/javascript"
    if filename.is_file() and filename.is_relative_to(uibase):
        return FileResponse(str(filename), media_type=media_type)

    index_file = uibase / "index.html"
    if not index_file.is_file():
        return FileResponse(str(Path(__file__).parent / "ui/fallback_file.html"))
    # Fall back to index.html, as indicated by vue router docs
    return FileResponse(str(index_file))
