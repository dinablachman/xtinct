# AGENTS.md

## Cursor Cloud specific instructions

### What this is
xTinct (`wayback-twitter-app`): a React (Vite) frontend + Express backend that fetches archived tweets from the Internet Archive Wayback Machine. No database, no auth, no persistence. The only external dependency is outbound HTTPS to `web.archive.org` (network egress is required for the app to return any data).

Note: the repo root **is** the app. `README.md` references a `wayback-twitter-app/` subdirectory and a `scrapeUsernames.js` script — neither exists; ignore those stale instructions.

### Services
| Service | Dir | Port | Run |
|---|---|---|---|
| Frontend (Vite/React) | `client/` | 5173 | `npm run client` (or via root `npm run dev`) |
| Backend (Express) | `server/` | 5174 | `npm run server` (nodemon) |

Run both together from repo root: `npm run dev` (uses `concurrently`). The Vite dev server proxies `/api` → `http://localhost:5174`, so run both.

### Lint / test / build
- Lint (client only): `npm run lint --prefix client`. Note: this currently reports 2 pre-existing `no-unused-vars` errors in `client/src/App.jsx` (`axios`, `err`) — these exist in the committed code and are not environment problems.
- Build (client): `npm run build --prefix client`.
- Tests: none. `server`'s `npm test` is a placeholder that echoes and exits 1. There is no real test suite.

### Non-obvious runtime caveats
- Backend calls can be **slow** (tens of seconds to ~2 min). For popular usernames the first CDX query is unbounded and often times out (15s) before falling back to `limit=1000/500` variants. Be patient; the UI shows a progress bar via a Server-Sent Events stream (`GET /api/tweets/stream/:username`).
- Extraction quality depends entirely on the archived snapshots. The backend takes only the **100 most-recent** `/status/*` captures. For some accounts these recent captures are junk (e.g. `@jack` yields malformed `/status/undefined?...` URLs → 0 tweets). `@realdonaldtrump` is a reliable demo account that returns real tweet text.
- Extracted tweets often show duplicate text and "No date found" — this is expected app behavior (it reads `og:description` and can't always parse a timestamp), not a setup issue.
- To smoke-test the backend directly: `curl "https://web.archive.org/cdx/search/cdx?url=twitter.com/jack/status/*&output=json&limit=5"` confirms egress; the app's own `GET /api/tweets/:username` (non-streaming) can exceed 60s, so prefer the streaming endpoint or the UI.
