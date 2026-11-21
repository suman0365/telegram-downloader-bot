# VERIFICATION.md — Telegram Downloader Bot v1

Date: 2026-11-21 (VM time UTC 14:49, IST 20:19)
Environment: this VM, Node v24.22.1, npm 10.9.4.
Note: Dockerfile targets Node 20 slim (Render). Local tests ran on Node 24
on this VM — same code, no Node-20-only or Node-24-only APIs used
(global `fetch`, `crypto.randomUUID`, `Readable.fromWeb` all exist in Node 20+).

## What was run, exactly

### 1. `node --check src/index.js`
Result: **PASS** — syntax OK, no output, exit 0. File is 400 lines.

### 2. `npm install` (in `~/workspace/telegram-downloader-bot/`)
Result: **PASS** — `added 225 packages in 18s`, exit 0.
Warnings only (deprecated transitive deps from node-telegram-bot-api):
`har-validator`, `uuid@8.3.2` / `uuid@3.4.0`, `request@2.88.2` deprecated.
No errors. `package-lock.json` created.

### 3. Server start with dummy token (no real Telegram)
Command:
```
TELEGRAM_BOT_TOKEN=dummy PORT=10001 timeout 15 node src/index.js
```
Result: **PASS** — server started, did NOT crash, did NOT call Telegram.
Log (exact):
```
2026-11-21T14:49:33.064Z [tg-bot] No real TELEGRAM_BOT_TOKEN set — bot polling disabled, HTTP server still runs (local test mode)
2026-11-21T14:49:33.081Z [tg-bot] HTTP server listening on port 10001
2026-11-21T14:49:33.082Z [tg-bot] BASE_URL=http://localhost:10001
2026-11-21T14:49:33.082Z [tg-bot] LOCAL_BOT_API_URL=(not set — hosted api.telegram.org)
2026-11-21T14:49:33.082Z [tg-bot] Bot: OFF (no token)
```

### 4. `GET /health`
Command: `curl -s -i http://127.0.0.1:10001/health`
Result: **PASS** — `HTTP/1.1 200 OK`, `Content-Type: application/json`,
body exactly: `{"ok":true,"links":0,"uptime":2}`

### 5. `GET /`
Command: `curl -s http://127.0.0.1:10001/`
Result: **PASS** — `200`, HTML status page, title
`Telegram Downloader Bot — running`, dark card, shows active links / mode.

### 6. `GET /dl/invalid-token-123`
Command: `curl -s -i http://127.0.0.1:10001/dl/invalid-token-123`
Result: **PASS** — `HTTP/1.1 404 Not Found`, `Content-Type: text/html`,
body is the friendly expired HTML page (NOT JSON):
title `Download link expired — Telegram Downloader Bot`, heading
`⏰ Download link expired`, Tanglish + English lines
("Indha link 24 hours ku appuram expire aayiduchu. / This link expired
after 24 hours." …). Server log: `Download: expired/missing token invalid-token-123`.

### 7. `sh -n start.sh`
Result: **PASS** — syntax OK.

### 8. Grep checks (code review, not a run)
- Only size cap in code: `MAX_FILE_SIZE = 4294967296` (4 GB). The only
  other "20 MB" / "50 MB" strings are comments and user-facing text
  explaining Telegram's hosted Bot API limit — no cap is enforced below 4 GB.
- No hardcoded token: only `PASTE_YOUR_BOT_TOKEN_HERE` placeholder
  comparisons in `src/index.js` and `.env.example`. No real token, api_id
  or api_hash anywhere in the repo.
- Streaming only: `/dl` uses `fs.createReadStream(..., 1 MB)` in local
  mode and `Readable.fromWeb(upstream.body).pipe(res)` in hosted mode.
  No `readFile`, no whole-file buffer.

## What was NOT verified (do NOT claim it works)

- **Telegram end-to-end: NOT verified.** No real bot token was available,
  so polling, `/start`, sending a file, receiving a link, `getFile`, and
  streaming a real file were never exercised. That needs Suman's BotFather
  token + api_id/api_hash and a real deploy.
- **4 GB download: NOT verified.** No 4 GB file was downloaded or streamed
  here. The code has no cap below 4 GB and streams in 1 MB chunks, but
  speed, Render timeouts and Telegram throttling on a real 4 GB file are
  unproven.
- **Local Bot API server binary: NOT verified live.** The Dockerfile pins
  `telegram-bot-api` release v8.0 from tdlib GitHub releases and the
  download is wrapped so a failed download does NOT fail the Docker build
  (it logs a warning and runs in hosted mode). The binary was not
  downloaded or run on this VM, and the Docker image was not built here.
- **Docker build / Render deploy: NOT done.** `render.yaml` and
  `docker-compose.yml` were written but not executed. Render deploy needs
  Suman's repo + env vars.
- **24-hour expiry timing: NOT waited out.** Expiry logic is
  `expiresAt = now + 24h` + a 10-minute cleanup interval; the expired-page
  path was verified with an invalid token (same code path for expired
  tokens), but no link was left running for 24 hours.
- **One-download mutex: NOT tested with two concurrent downloads.**
  The mutex code is in place (second request gets a 503 "try again" HTML
  page), but only single sequential requests were curled here.
