# Telegram Downloader Bot v1

**Tanglish:** Telegram la file ah bot ku anuppu — bot oru browser download link kudukum. Link ah browser la open panna file download aagum. Link 24 hours ku appuram expire aayidum.

**English:** Send any file to the bot on Telegram — the bot replies with a browser download link. Open the link in a browser to download the file. The link expires after 24 hours.

- **Cost: $0** — Render free + Telegram free. No paid service.
- **Size: NO limit in code** — only Telegram's own max: free **2 GB** per file, Premium **4 GB** per file. Anyone can download a 4 GB file uploaded by a Premium user.
- **Slow is fine, one download at a time** — Render free is 512 MB RAM, so files are streamed in 1 MB chunks, never loaded whole into memory, never stored on disk as a download.

## Epdi work aagum / How it works

1. File ah bot ku Telegram la anuppu (photo, video, document, audio, voice, sticker — edhuvum).
2. Bot file ah download panna maattengudhu — `file_id`, name, size mattum memory la save pannum.
3. Bot reply pannum: `https://<your-render-url>/dl/<random-token>` + file name, size, expiry time (IST).
4. Browser la link open panna, server Telegram kitta `getFile` kekkum, aprom file ah browser ku **stream** pannum.
5. 24 hours ku appuram link expire — open panna friendly "Download link expired" page varum (JSON illa).

## Yen Local Bot API server venum / Why the Local Bot API server is needed

Normal Bot API (`api.telegram.org`) la:

- Bot download panna mudiyum: **20 MB** dhaan (`getFile` limit)
- Bot upload panna mudiyum: **50 MB** dhaan

Adhanala 20 MB ku mela file ku **Local Bot API server** venum — adhu download la limit eh illa, upload 2000 MB varaikum.

**Two modes — edhu eppo:**

| Mode | Epdi | Limit |
|---|---|---|
| **Hosted** (default, no setup) | `LOCAL_BOT_API_URL` empty | getFile 20 MB — chinna files mattum |
| **Local** (recommended, 4 GB ku) | `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` set, local server on | Download unlimited, up to Telegram max 4 GB |

Local mode la `getFile` absolute file path ah return pannum (`/var/lib/telegram-bot-api/...`) — server adha disk la irundhu stream pannum. Hosted mode la Telegram file URL la irundhu stream pannum.

## Setup — Step 1: Bot create pannu (BotFather)

1. Telegram la `@BotFather` open pannu.
2. `/newbot` anuppu → bot name kuddu (example: `AI Thambi Downloader`) → username kuddu (example: `aithambi_downloader_bot`, `_bot` la mudiyanum).
3. BotFather kudutha **token** ah copy pannu — yaarukkum chat la anuppaadha, Render dashboard la mattum paste pannu.

## Setup — Step 2: api_id / api_hash edukku (free, Local mode ku)

1. https://my.telegram.org/apps open pannu, un Telegram number la login pannu.
2. App title + short name kuduthu **Create application**.
3. `api_id` (number) + `api_hash` (string) ah copy pannu — idhu secret, chat la anuppaadha.
4. Idhu illana bot hosted mode la mattum run aagum (20 MB limit).

## Setup — Step 3: Render la deploy pannu ($0)

1. Indha folder ah GitHub repo la push pannu.
2. Render dashboard → New → Web Service → repo select pannu → **Docker** (Dockerfile irukku).
3. Plan: **Free**. Region: Oregon (FlowFetch mariye).
4. Environment tab la indha vars set pannu:
   - `TELEGRAM_BOT_TOKEN` = BotFather token
   - `TELEGRAM_BOT_USERNAME` = bot username (`@` illaama)
   - `TELEGRAM_API_ID` = my.telegram.org api_id
   - `TELEGRAM_API_HASH` = my.telegram.org api_hash
   - `BASE_URL` = first deploy ku appuram kedaikkura Render URL, example `https://telegram-downloader-bot.onrender.com` (set pannitu redeploy pannu — link la idhu dhaan varum)
   - `PORT` = `10000`
5. Deploy aana aprom, `https://<your-url>/health` open panna `{"ok":true}` varanum.
6. **Keep-alive:** Render free 15 min use pannama irundha thoongidum. FlowFetch mariye 5 min ku oru thadava `https://<your-url>/health` ah ping pannu (UptimeRobot free / Muse cron). Oru service mattum awake ah vechukko — 750 free hours/month quota ku mela poga kudadhu.

## Local la run panna / Run locally

```bash
cp .env.example .env
# .env la real token / api_id / api_hash fill pannu
npm install
npm start
# http://localhost:10000/health -> {"ok":true}
```

Local la periya file test panna docker-compose use pannu (Local Bot API server separate container la run aagum):

```bash
docker compose up --build
# bot: http://localhost:10000 , local API: http://localhost:8081
```

Token illaama test panna: `TELEGRAM_BOT_TOKEN=dummy npm start` — HTTP server run aagum, bot polling OFF aagum, `/health` 200 varum, `/dl/invalid` expired HTML page varum. Real Telegram test ku real token venum.

## Endpoints

| Route | Enna |
|---|---|
| `GET /` | Status page (active links, uptime, mode) |
| `GET /health` | `200 {"ok":true, "links": N, "uptime": S}` |
| `GET /dl/:token` | Valid na file stream (attachment download). Expired/missing na 404 HTML page. Oru download nadandhutu irundha 503 "try again" HTML page. |

## Limits — honest ah

- **Telegram max dhaan real limit:** 4 GB ku mela file Telegram la ye anuppa mudiyadhu.
- **Render free 512 MB:** oru time la oru download dhaan. 4 GB file slow ah download aagum (speed Telegram + Render ah poruthu). Connection cut aana thirumba link ah click panna — link 24h valid, file Telegram la ye irukku.
- **Links in-memory dhaan:** Render restart aana old links pogum — file ah bot ku thirumba anuppu, pudhu link edukku.
- **Bot polling:** long polling use pannrom (webhook illa), Render free sleep ku keep-alive venum.
- **Telegram end-to-end NOT verified here** — real token illaama test panna mudiyadhu. `VERIFICATION.md` la enna test pannom, enna pass/fail nu exact ah irukku.

## Files

- `src/index.js` — bot + Express server, ella logic um inga dhaan
- `Dockerfile` — Node 20 slim + telegram-bot-api binary try pannum (download fail aana build fail aagadhu, hosted mode la run aagum)
- `start.sh` — local Bot API server (if configured) + Node app ah start pannum
- `docker-compose.yml` — local dev ku bot + telegram-bot-api (aiogram image)
- `render.yaml` — Render free Docker deploy
- `.env.example` — env vars sample (secrets illa)
- `VERIFICATION.md` — local test results
