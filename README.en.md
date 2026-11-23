# FreqDeck

[简体中文](README.md) | **English**

**Powered by [Freqtrade](https://github.com/freqtrade/freqtrade).**

A self-contained, single-instance trading console: one process, one bot, one web
UI. No `config.json`, no `freqtrade new-config` — it starts and runs as-is. The
admin credentials are generated once on first launch; everything else is
configured in the browser.

> FreqDeck is a self-hosted trading console built on top of freqtrade. It is a
> derivative work and is distributed under **GPL-3.0**. See [NOTICE](NOTICE) and
> [ATTRIBUTION.md](ATTRIBUTION.md).

---

## What it changes

Upstream freqtrade expects you to prepare a `config.json` first, then pick a
subcommand to launch; the WebUI is an optional add-on. FreqDeck inverts that:

- **Bare start runs immediately**: `freqtrade` with no arguments enters app mode,
  reading configuration from a local state file.
- **Configuration lives in the WebUI**: exchange, API keys, stake, strategy, ROI,
  stoploss, listen address, admin password and signal token are all edited on the
  `/config` page and hot-reloaded.
- **Two modes**: `shell` runs only the API + UI (for troubleshooting); `trade`
  runs the real bot. If the bot fails to start, it falls back to `shell`
  automatically and surfaces the original error.
- **External signal channel**: `POST /api/v1/signal` uses a separate
  `X-Signal-Token`, so machine callers never hold the admin password.

The UI has six pages — Dashboard, Positions, Candle Chart, Analytics, Config and
Ops — single-instance, with no multi-tenant concepts.

---

## Repository layout

```
FreqDeck/
├── LICENSE            # GPL-3.0 (kept from the repository's initial commit)
├── NOTICE             # Copyright and derivative-work notice
├── ATTRIBUTION.md     # Upstream baseline + itemized change list
├── backend/           # freqtrade derivative (source snapshot, no upstream history)
└── frontend/          # Vue 3 + Vite console
```

**About `backend/` history**: this is a working-tree snapshot of a fork based on
`stable` (tag `2026.10`, upstream commit `4cf0351e0`), **squashed into a single
commit**. It does not carry the upstream's ~20,000 commits and ~850MB object
database. The upstream `origin` is still kept in the WSL clone on the development
machine, so `git fetch` / `git merge` remain available for syncing. For the full
upstream history, see [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade).

---

## Quick start

Environment: Linux / WSL2, Python ≥ 3.12 (3.14 on the dev machine), Node ≥ 20.

### 1. Backend

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[develop,plot]"      # TA-Lib ships manylinux wheels; no sudo needed

# First launch prints, once: admin + random password + JWT secret + signal token
.venv/bin/python -m freqtrade app --user-data-dir /path/to/user_data
```

The state file is `user_data/app/state.json` (mode `0600`) and is the single
source of truth for configuration. Open `http://127.0.0.1:8080/` and log in with
the password printed on first launch.

### 2. Frontend

```bash
cd frontend
npm install
npm run build            # output in frontend/dist/
npm run typecheck        # optional, vue-tsc --noEmit
```

Then point `app.ui_path` at the absolute path of the build output (visible under
"Advanced" on the `/config` page, or edit the state file and restart):

```json
{
  "config": {
    "app": { "ui_path": "/abs/path/to/FreqDeck/frontend/dist" }
  }
}
```

Or via the API:

```bash
curl -u admin:<password> -X POST http://127.0.0.1:8080/api/v1/token/login
curl -H "Authorization: Bearer <access_token>" -X PUT \
     -H 'Content-Type: application/json' \
     -d '{"config":{"app":{"ui_path":"/abs/path/to/FreqDeck/frontend/dist"}}}' \
     http://127.0.0.1:8080/api/v1/app/config
```

In dev mode `npm run dev` proxies `/api` to the backend. If the backend listens
on a different port, set `VITE_API_TARGET` (see `frontend/.env.example`) rather
than editing `vite.config.ts`.

### 3. External signals

```bash
curl -H 'X-Signal-Token: <signal token>' -H 'Content-Type: application/json' \
     -d '{"action":"buy","pair":"BTC/USDT"}' \
     http://127.0.0.1:8080/api/v1/signal
```

`GET /api/v1/signal/health` is a side-effect-free auth probe. Supported actions
are `buy` / `sell` / `close` / `close_all` — effectively an immediate channel to
`forceenter` / `forceexit`.

---

## API reference

| Endpoint | Description |
| --- | --- |
| `POST /api/v1/token/login` | HTTP Basic → JWT |
| `GET /api/v1/app/info` | version / mode / runmode / trading active / `last_error` |
| `GET\|PUT /api/v1/app/config` | read (redacted) / partial deep-merge write + hot reload |
| `POST /api/v1/app/mode` | `{"mode":"shell"\|"trade"}`, persisted then re-exec via `execv` |
| `POST /api/v1/app/reload` / `restart` / `password` | manual hot reload / restart / rotate password |
| `POST /api/v1/signal` / `GET /api/v1/signal/health` | external signals |

Action endpoints return `ModeAccepted`: `mode` is always the real runtime mode,
while the action result goes into `outcome` (`switching` / `reloaded` /
`password_updated` / `restarting`, …). The full contract is in
`backend/docs/app-mode.md`.

---

## Status & verification

The six-page frontend and the backend app mode were verified end-to-end against
a **real browser and a live backend** (OKX dry-run, 1 open position + 2 closed
trades): all six pages, SPA deep links, observation-mode empty states, config
save + hot reload, both directions of mode switching, password change, token
rotation and immediate restart were exercised. The backend API contract is in
`backend/docs/app-mode.md`.

Notes:

- `dry_run: true` by default. Going live requires explicitly disabling it in the
  config page and typing `LIVE` in the mode-switch dialog.
- Changes to `api_server.listen_ip_address` / `listen_port` take effect only
  after a restart, and you must use the new address afterwards.
- Secret fields show only "configured" in the UI; masked values are never written
  back, so a real password cannot be overwritten with the literal `***redacted***`.

---

## License

**GPL-3.0**. FreqDeck is a derivative work of freqtrade; upstream copyright
belongs to the freqtrade contributors. See [NOTICE](NOTICE) and
[ATTRIBUTION.md](ATTRIBUTION.md).

**Powered by Freqtrade** — <https://github.com/freqtrade/freqtrade>
