# LocaLingo Learn server

Syncs your vocabulary book, saved sentences and review history between the Chrome
extension and a hosted learning web app, and serves the offline dictionary package.
It is a small FastAPI + SQLite service meant for one person or a few accounts on your
own VPS.

What it stores: the records you save (words/phrases with the sense you chose, the
sentence you saw them in and its source link, notes, tags, review events). It never
receives whole pages, browsing history or the local translation token. The
translation model keeps running on your Mac (the `web-translator` server); this
server does not translate.

## Deploy with Docker

From the repository root:

```bash
LOCALINGO_ADMIN_USER=yourname LOCALINGO_ADMIN_PASSWORD='a long password' \
  docker compose -f server/compose.yaml up -d --build
```

The first start creates that account (remove the two variables afterwards). The image
build downloads ECDICT at a pinned commit, verifies its SHA-256 and builds the `base`
(≈8 MB) and `full` (≈25 MB) dictionary packages.

The container listens on `127.0.0.1:8080`. Put HTTPS in front of it — the extension
only syncs over `https://` (except `localhost`). With Caddy:

```
learn.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then open `https://learn.example.com`. The root is a project-introduction landing
page — click 「进入我的个人空间」 to reach the learning center. You can use it
directly in **local mode** (data saved in the browser, dictionary lookups work)
without signing in. To sync across devices, create an account and sign in; then
in the extension's learning center (设置 → 同步) enter the same address and
account.

### Accounts

```bash
docker compose -f server/compose.yaml exec localingo localingo-server create-user alice
docker compose -f server/compose.yaml exec localingo localingo-server set-password alice
```

Self-service sign-up is off; set `LOCALINGO_ALLOW_SIGNUP=true` to allow it.

### Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCALINGO_DATA` | `/data` | SQLite databases (accounts + records, dictionary index) |
| `LOCALINGO_BIND` | `127.0.0.1` | Host address the container port is published on (`0.0.0.0` to expose directly) |
| `LOCALINGO_PORT` | `8080` | Host port the web app is published on |
| `LOCALINGO_DICT_VARIANT` | `base` | Dictionary package used by the web app's lookups (`base` or `full`) |
| `LOCALINGO_ALLOW_SIGNUP` | `false` | Allow `/api/auth/signup` |
| `LOCALINGO_ADMIN_USER` / `_PASSWORD` | — | Create this account on start if missing |
| `LOCALINGO_TOKEN_DAYS` | `180` | Sign-in lifetime per device |
| `LOCALINGO_CORS_ORIGINS` | — | Extra allowed origins (Chrome extensions are always allowed) |

Back up the `localingo-data` volume (or use 设置 → 数据 → 导出备份 in the app).

## Run without Docker (development)

```bash
cd server
uv sync
LOCALINGO_ADMIN_USER=dev LOCALINGO_ADMIN_PASSWORD='dev-password-123' uv run localingo-server serve --port 8080
uv run pytest
```

It serves the web app straight from `../extension` and dictionary packages from
`../data/dist` (build them with `scripts/build_dict.py`, see `docs/DICTIONARY.md`).

## API

All endpoints except `/api/health`, `/api/auth/login`, `/api/auth/signup` and the
`/api/dict/*` endpoints need `Authorization: Bearer <token>`. Dictionary lookups
are public so the learning center works in local mode without signing in.

| Method | Path | |
| --- | --- | --- |
| GET | `/api/health` | Version, whether a dictionary is loaded, whether sign-up is open |
| POST | `/api/auth/login` | `{username, password, device_label}` → `{token, user}`; 8 failures / 15 min → 429 |
| POST | `/api/auth/signup` | Only with `LOCALINGO_ALLOW_SIGNUP=true` |
| POST | `/api/auth/logout` | Revokes this device's token |
| GET | `/api/me` | Username and record counts |
| POST | `/api/sync/push` | `{device_id, changes: {items|encounters|cards|events|sentences: [record]}}`, ≤1000 records, ≤64 KB each |
| GET | `/api/sync/pull?since=&limit=` | `{changes, cursor, more}`; `reset: true` means start again from 0 |
| DELETE | `/api/sync/data?confirm=<username>` | Delete all your synced records |
| GET | `/api/dict/info` | Active package manifest and downloadable packages |
| GET | `/api/dict/entries?k=…` | Raw entries/forms for up to 20 keys (the lookup logic is the shared JS module) |
| GET | `/api/dict/packages/<file>` | Download a package for the extension's offline import |

Sync is last-writer-wins on each record's `updated_at` (ties broken by device id).
Review events are append-only and card schedules are recomputed from them on each
device, so reviewing on two devices never conflicts.
