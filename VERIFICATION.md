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

---

# VERIFICATION.md — v1.1 (concurrency fix + English-only UI redesign)

Date: 2026-11-21 (VM time UTC 16:36, IST 22:06)
Environment: this VM, Node v24.22.1. Dummy token only, no real Telegram.
Files changed: `src/index.js` only (Dockerfile, render.yaml, start.sh
untouched). 4GB cap (`MAX_FILE_SIZE = 4294967296`) and 24h expiry
(`LINK_TTL_MS`) unchanged; env var names unchanged; bot Telegram
messages unchanged (still Tanglish + English).

## What changed in code

1. **Mutex → 3 slots:** single boolean `downloadInProgress` replaced by
   `activeDownloads` Map + `MAX_CONCURRENT_DOWNLOADS = 3`. A 4th request
   gets the queue page instead of being blocked for a whole GB download.
2. **Bulletproof release:** slot release is idempotent and fires on
   `res` finish AND close, local stream error, upstream stream error,
   and the catch block. Every acquire/release is logged with file name.
3. **Watchdog:** `pruneStaleDownloads()` runs every 60s; a slot with no
   bytes for 10 min (`STALL_MS`) or a total run over 90 min
   (`MAX_DOWNLOAD_MS`) is force-released and its stream/response are
   destroyed. Byte flow is tracked via `data` listeners on both the
   local `fs` stream and the hosted upstream stream.
4. **Queue page (was: dead-end busy page):** shows file name + size,
   "You are in line — your download will start automatically", a
   `<meta http-equiv="refresh" content="15">` auto-refresh to the same
   `/dl/<token>` link, a live 15-second countdown, and a "Try now"
   button. Link stays in the store after a queue reject.
5. **Health/status:** `GET /health` now returns an `activeDownloads`
   array (`fileName`, `fileSize`, `startedAt`, `bytesSent`). The `/`
   status page shows "Downloads in progress: N of 3 slots" and lists
   files currently downloading.
6. **UI redesign, ENGLISH ONLY:** all four web pages (status, expired,
   queue, failed) rebuilt on one shared design — dark gradient
   background, glassmorphism card (blur + translucent + border),
   system font stack only (no external fonts/CDNs), eyebrow label,
   clear heading hierarchy, file chip (name + size), gradient primary
   button + ghost secondary button, animated hourglass (queue) and
   animated progress bar, mobile-first spacing. No Tanglish text
   remains on any web page; bot Telegram messages are untouched.

## What was run, exactly

### 1. `node --check src/index.js`
Result: **PASS** — syntax OK, exit 0.

### 2. Grep for Tanglish in web UI
Command: `grep -n -i -E "nadandhutu|Indha link|Konjam|Periya|File ah bot|Telegram la irundhu|Oru download|irukku|aagudhu|mudiyala|thirumba" src/index.js`
Result: **PASS** — only 2 hits, both inside bot Telegram messages
(`HELP_TEXT` and a bot error reply), which are intentionally unchanged.
Zero Tanglish on any web page.

### 3. Full local test script `/tmp/tg-v11-test.js` (22 checks)
Command: `TELEGRAM_BOT_TOKEN=dummy` (set in-script), port 10003,
`node /tmp/tg-v11-test.js` — imports the app, drives it over HTTP.
Result: **22 passed, 0 failed.** Exact checks:
- `/health` 200, body `{"ok":true,"links":0,"uptime":0,"activeDownloads":[]}`
  — `activeDownloads` field present and an empty array.
- `MAX_CONCURRENT_DOWNLOADS === 3`.
- `/` 200 HTML, shows "Downloads in progress: 0 of 3 slots", no
  Tanglish, glass-card CSS present (`backdrop-filter`, gradients).
- `/dl/invalid-token-123` 404, expired page reads "This download link
  has expired", no Tanglish.
- Queue: with 3 fake slots filled, a 4th request for a real link
  (`big-movie.mp4`, 1.40 GB) got **503**, page "You are in line",
  file name + size shown, `<meta http-equiv="refresh" content="15;">`
  present, "Try now" button linking to the same `/dl/<token>`, no
  Tanglish, and the link was still in the store afterwards.
- Failed download: with slots clear, the same link got **502**
  (dummy token, `getFile` throws), failed page English only
  ("We could not fetch the file from Telegram."), and `/health`
  afterwards showed `activeDownloads: []` — the slot was released.
- Watchdog: a fake slot idle 11 min / total 95 min was
  force-released by a direct `pruneStaleDownloads()` call, and its
  stream + response `destroy()` were both called. A fresh slot was
  kept. Server log lines confirm acquire/release/force-release with
  file names, e.g. `slot 1 acquired (1/3) big-movie.mp4 (1.40 GB)`,
  `slot 1 released (failed: ...) big-movie.mp4 — 0/3 in use`,
  `slot 999 force-released (idle 660s, total 5700s) stuck.mp4`.

## What was NOT verified (do NOT claim it works)

- **Real >20MB download: NOT verified.** No real file was streamed
  here (dummy token makes `getFile` fail before streaming). The 1 MB
  chunk streaming path is unchanged from v1, but a real large-file
  download through the new slot code is unproven.
- **3 real concurrent downloads live: NOT verified.** Queue behaviour
  was proven with injected fake slots, not with 3 real streams on
  Render free (512 MB). Memory under 3 concurrent GB streams is
  unproven.
- **Render deploy: NOT done.** This task changed code only. The parent
  deploys via browser task; the live service still runs the previous
  build until then.
- **24-hour expiry timing: NOT waited out.** Same as v1; the
  expired-page path was verified with an invalid token only.
- **Watchdog live timing: NOT waited out.** The 10-min stall and
  90-min total thresholds were proven by calling
  `pruneStaleDownloads()` directly on an artificially aged slot, not
  by letting a real download stall for 10 minutes.
- **One-download mutex: SUPERSEDED by v1.1 (see below).** The single
  boolean mutex is gone, replaced by 3 concurrent slots + a queue page
  with a stale-slot watchdog. Queue behaviour was verified locally in
  v1.1, but 3 real concurrent downloads on live Render were NOT tested.
- **Local Bot API server binary: fixed in deploy, NOT verified here.**
  The Dockerfile originally pinned `telegram-bot-api` v8.0 from tdlib
  GitHub releases (dead 404). During the Render deploy it was fixed to
  a multi-stage build copying the binary from the aiogram/
  telegram-bot-api image (commit 42a1f6b, Live 21:51 IST) and the live
  status page shows Local Bot API on. The Docker image was NOT built
  on this VM in this task.

## v1.1 re-verification (2026-11-22 ~07:24 IST, this VM)

- Fixed the help text: "one download at a time" → "up to 3 downloads at a time" (Tanglish + English lines), matching MAX_CONCURRENT_DOWNLOADS = 3. Web pages were already English-only; Telegram chat messages stay Tanglish + English per Suman's rule.
- `node --check src/index.js` — PASS.
- Local server with dummy token: `GET /health` → 200 `{"ok":true,"links":0,"uptime":3,"activeDownloads":[]}`; `GET /` shows "Downloads in progress: 0 of 3 slots"; `GET /dl/invalid-test-123` → English-only expired page, 0 Tanglish matches.
- Live site check (2026-11-22 07:21 IST): https://telegram-downloader-bot-ur9i.onrender.com still serves v1.0 — expired page still has Tanglish "Indha link", GitHub remote HEAD is still 42a1f6b (400 lines, one-download mutex). v1.1 (543 lines) is NOT live yet.
- Blocker: GitHub push. `gh` is not logged in on this VM and the saved GitHub password was rejected ("Incorrect username or password") in the browser deploy. An upload-ready zip of v1.1 (no node_modules) is at ~/workspace/your_files/telegram-downloader-bot-v1.1.zip (49K) for GitHub web upload, which triggers the Render redeploy.
