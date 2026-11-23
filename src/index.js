'use strict';
/**
 * Telegram Downloader Bot v1 — 0 cost, 4GB limit, 24h-expiry links.
 *
 * Flow:
 *  1. User sends any file to the bot on Telegram.
 *  2. Bot stores only the file_id (+ name/size/mime) in memory — NO file
 *     is downloaded or stored on the server at receive time.
 *  3. Bot replies with a browser link: ${BASE_URL}/dl/<token>
 *  4. Browser opens the link -> server calls Telegram getFile, then
 *     STREAMS the file to the browser (1 MB chunks, never whole file
 *     in RAM). Link expires 24 hours after creation.
 *
 * Size rule: NO artificial cap in code. Only Telegram's own max applies:
 *  free 2 GB per file, Premium 4 GB per file. Anyone can download a 4 GB
 *  file uploaded by a Premium user. Normal Bot API can only download
 *  20 MB / upload 50 MB, so for big files this server uses the Local
 *  Bot API server (download unlimited) when LOCAL_BOT_API_URL is set.
 *  Without it, hosted api.telegram.org is used and big files will fail
 *  at Telegram's 20 MB getFile limit — that is a Telegram limit, not ours.
 *
 * Hosting: Render free (512 MB RAM). Up to 3 downloads stream at once
 * (1 MB chunks, low memory each); extra requests wait on an auto-
 * refreshing queue page. No disk storage of files. Stalled slots are
 * force-released by a watchdog. Keep-alive ping (every 5 min) keeps
 * the free service awake, same as FlowFetch.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const express = require('express');

const PORT = parseInt(process.env.PORT, 10) || 10000;
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').trim();
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const LOCAL_BOT_API_URL = (process.env.LOCAL_BOT_API_URL || '').trim().replace(/\/+$/, '');

// Telegram's own max: Premium 4 GB per file. No cap below this anywhere.
const MAX_FILE_SIZE = 4294967296; // 4 * 1024 * 1024 * 1024
const LINK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_MS = 10 * 60 * 1000; // every 10 minutes
const CHUNK_SIZE = 1024 * 1024; // 1 MB stream chunks

// Concurrency: up to 3 downloads stream at once. Streaming is 1 MB
// chunks, so memory per download stays low — 3 concurrent streams are
// safe on Render free (512 MB). A 4th request waits in the queue page.
const MAX_CONCURRENT_DOWNLOADS = 3;
const STALL_MS = 10 * 60 * 1000; // force-release a slot with no bytes for 10 min
const MAX_DOWNLOAD_MS = 90 * 60 * 1000; // force-release a slot after 90 min total
const WATCHDOG_MS = 60 * 1000; // check for stalled slots every minute

function log(...args) {
  console.log(new Date().toISOString(), '[tg-bot]', ...args);
}

function formatSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return 'unknown size';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- links store
// In-memory only. Render free restarts wipe it — that is fine, the user
// just sends the file to the bot again for a fresh link.
const links = new Map(); // token -> { fileId, fileName, fileSize, mime, createdAt, expiresAt }

function createLink(file) {
  const token = crypto.randomUUID();
  const now = Date.now();
  links.set(token, {
    fileId: file.file_id,
    fileName: file.file_name,
    fileSize: file.file_size,
    mime: file.mime_type || 'application/octet-stream',
    createdAt: now,
    expiresAt: now + LINK_TTL_MS,
  });
  return token;
}

setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [token, link] of links) {
    if (link.expiresAt <= now) {
      links.delete(token);
      removed += 1;
    }
  }
  if (removed) log(`Cleanup: removed ${removed} expired link(s), ${links.size} active`);
}, CLEANUP_MS).unref();

// -------------------------------------------------------- download slots
// Render free = 512 MB RAM. Up to MAX_CONCURRENT_DOWNLOADS downloads
// stream at once; a request beyond that waits on the queue page and
// starts automatically when a slot frees up. Every slot is tracked, so
// a stalled or abandoned download can never hold a slot forever.
const activeDownloads = new Map(); // id -> { id, fileName, fileSize, startedAt, lastBytesAt, bytesSent, res, stream }
let downloadSeq = 0;

// Force-release slots that stopped moving (client gone, upstream stalled)
// or ran far too long. Destroys the stream/response so the slot really frees.
function pruneStaleDownloads() {
  const now = Date.now();
  for (const [id, slot] of activeDownloads) {
    const idleMs = now - slot.lastBytesAt;
    const totalMs = now - slot.startedAt;
    if (idleMs > STALL_MS || totalMs > MAX_DOWNLOAD_MS) {
      log(`Download: slot ${id} force-released (idle ${Math.round(idleMs / 1000)}s, total ${Math.round(totalMs / 1000)}s) ${slot.fileName}`);
      activeDownloads.delete(id);
      try { if (slot.stream) slot.stream.destroy(); } catch (_) { /* already gone */ }
      try { if (slot.res) slot.res.destroy(); } catch (_) { /* already gone */ }
    }
  }
}

setInterval(pruneStaleDownloads, WATCHDOG_MS).unref();

// All web pages are ENGLISH ONLY (bot Telegram messages stay
// Tanglish + English). One shared design: dark gradient, glass card,
// system fonts only — no external fonts or CDNs, works offline.
function pageHtml({ title, eyebrow, icon, heading, lines, fileName, fileSize, buttonText, buttonHref, secondaryText, secondaryHref, extraHead, extraBody }) {
  const body = (lines || []).map((l) => `<p>${l}</p>`).join('\n');
  const fileChip = fileName
    ? `<div class="file-chip"><span class="file-icon">📄</span><span class="file-meta"><span class="file-name">${escapeHtml(fileName)}</span><span class="file-size">${escapeHtml(formatSize(fileSize))}</span></span></div>`
    : '';
  const button = buttonHref
    ? `<a class="btn" href="${escapeHtml(buttonHref)}">${escapeHtml(buttonText || 'Open')}</a>`
    : '';
  const secondary = secondaryHref
    ? `<a class="btn btn-ghost" href="${escapeHtml(secondaryHref)}">${escapeHtml(secondaryText || 'Open')}</a>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${extraHead || ''}
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px 16px;color:#e8eaf0;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  background:radial-gradient(900px 480px at 15% -10%,rgba(56,130,246,.28),transparent 60%),
    radial-gradient(800px 480px at 95% 110%,rgba(168,85,247,.20),transparent 60%),
    linear-gradient(180deg,#0b0e14,#0f1115)}
.card{width:100%;max-width:560px;text-align:center;padding:36px 30px 28px;border-radius:22px;
  background:rgba(26,29,39,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border:1px solid rgba(255,255,255,.09);box-shadow:0 20px 60px rgba(0,0,0,.5)}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#7dd3fc;margin:0 0 14px}
.icon{font-size:44px;line-height:1;margin:0 0 14px}
.icon-float{display:inline-block;animation:bob 2.4s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
h1{font-size:24px;line-height:1.3;font-weight:700;margin:0 0 12px;letter-spacing:-.01em}
.muted{color:#aab2c0;font-size:15px;line-height:1.7}
.muted p{margin:0 0 10px}
.file-chip{display:flex;align-items:center;gap:12px;text-align:left;margin:18px 0 4px;padding:13px 15px;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);border-radius:14px}
.file-icon{font-size:22px;flex:none}
.file-meta{display:flex;flex-direction:column;min-width:0}
.file-name{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file-size{font-size:12px;color:#8b93a5;margin-top:2px}
.btn{display:inline-block;margin-top:20px;padding:13px 26px;border-radius:12px;font-weight:700;font-size:15px;
  text-decoration:none;color:#fff;background:linear-gradient(135deg,#38bdf8,#2563eb);
  box-shadow:0 8px 24px rgba(37,99,235,.35)}
.btn-ghost{background:transparent;border:1px solid rgba(255,255,255,.22);box-shadow:none;color:#dbe2ee;margin-left:8px}
.btn-row{margin-top:4px}
.progress{height:6px;border-radius:99px;overflow:hidden;background:rgba(255,255,255,.09);margin:20px 0 0}
.progress>div{height:100%;width:40%;border-radius:99px;
  background:linear-gradient(90deg,#38bdf8,#a78bfa,#38bdf8);background-size:200% 100%;
  animation:slide 1.6s linear infinite}
@keyframes slide{0%{background-position:0 0}100%{background-position:200% 0}}
.countdown{font-weight:700;color:#7dd3fc}
.footer{margin-top:24px;font-size:12px;color:#6b7280}
@media (max-width:480px){.card{padding:28px 20px 22px}h1{font-size:21px}.icon{font-size:38px}.btn-ghost{margin-left:0;margin-top:10px}}
</style></head><body><main class="card">
${eyebrow ? `<p class="eyebrow">${escapeHtml(eyebrow)}</p>` : ''}
${icon ? `<div class="icon"><span class="icon-float">${icon}</span></div>` : ''}
<h1>${escapeHtml(heading)}</h1>
<div class="muted">${body}</div>
${fileChip}
<div class="btn-row">${button}${secondary}</div>
<p class="footer">Telegram Downloader Bot &middot; Free &middot; Links expire after 24 hours</p>
</main>${extraBody || ''}</body></html>`;
}

function expiredPage() {
  const botHref = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : 'https://t.me/';
  return pageHtml({
    title: 'Download link expired — Telegram Downloader Bot',
    eyebrow: 'Link expired',
    icon: '⏰',
    heading: 'This download link has expired',
    lines: [
      'This link expired 24 hours after it was created.',
      'Send the file to the bot again on Telegram and you will get a fresh link.',
      'Files are never stored on this server, so an expired link cannot be restored.',
    ],
    buttonText: 'Open Telegram Bot →',
    buttonHref: botHref,
  });
}

// Queue page, not a dead end: the page refreshes itself every 15 seconds
// and starts the download as soon as a slot frees up.
function queuePage(link, token) {
  const botHref = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : 'https://t.me/';
  const selfHref = `/dl/${encodeURIComponent(token)}`;
  return pageHtml({
    title: 'You are in line — Telegram Downloader Bot',
    eyebrow: 'In queue',
    icon: '⏳',
    heading: 'You are in line',
    lines: [
      `All ${MAX_CONCURRENT_DOWNLOADS} download slots are busy right now. Your download will start automatically as soon as a slot frees up — no need to tap anything.`,
      'Checking again in <span class="countdown" id="countdown">15</span> seconds. Your link stays valid for 24 hours.',
    ],
    fileName: link.fileName,
    fileSize: link.fileSize,
    buttonText: 'Try now',
    buttonHref: selfHref,
    secondaryText: 'Open Telegram Bot →',
    secondaryHref: botHref,
    extraHead: `<meta http-equiv="refresh" content="15; url=${escapeHtml(selfHref)}">`,
    extraBody: `<script>let s=15;const el=document.getElementById('countdown');setInterval(()=>{s--;if(s<=0)s=15;if(el)el.textContent=s;},1000);</script>`,
  });
}

function failedPage(err) {
  const botHref = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : 'https://t.me/';
  return pageHtml({
    title: 'Download failed — Telegram Downloader Bot',
    eyebrow: 'Download failed',
    icon: '❌',
    heading: 'Download failed',
    lines: [
      'We could not fetch the file from Telegram.',
      `Reason: ${escapeHtml(err && err.message ? err.message : 'unknown error')}`,
      'For files over 20 MB, the Local Bot API server must be running. See the README.',
      'Send the file to the bot again for a fresh link.',
    ],
    buttonText: 'Open Telegram Bot →',
    buttonHref: botHref,
  });
}

// ------------------------------------------------------------- Telegram API
async function getTelegramFile(fileId) {
  if (!BOT_TOKEN || BOT_TOKEN === 'dummy') {
    throw new Error('TELEGRAM_BOT_TOKEN is not set (dummy token in local test)');
  }
  const base = LOCAL_BOT_API_URL || 'https://api.telegram.org';
  const url = `${base}/bot${BOT_TOKEN}/getFile`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`getFile failed (${res.status}): ${data.description || 'unknown error'}`);
  }
  // Local mode: file_path is an ABSOLUTE path on this server's disk.
  // Hosted mode: file_path is relative, e.g. "documents/file_1.mp4".
  return data.result; // { file_id, file_unique_id, file_size, file_path }
}

// ------------------------------------------------------------- file picking
function extFromMime(mime) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'video/mp4': '.mp4', 'video/x-matroska': '.mkv',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a',
    'application/pdf': '.pdf', 'application/zip': '.zip',
    'text/plain': '.txt', 'application/octet-stream': '.bin',
  };
  return map[mime] || '';
}

function pickFile(msg) {
  if (msg.document) return msg.document;
  if (msg.video) return msg.video;
  if (msg.audio) return msg.audio;
  if (msg.animation) return msg.animation;
  if (msg.voice) return { ...msg.voice, file_name: `voice_${msg.voice.file_id.slice(0, 8)}.ogg` };
  if (msg.video_note) return { ...msg.video_note, file_name: `video_note_${msg.video_note.file_id.slice(0, 8)}.mp4` };
  if (msg.sticker) return { ...msg.sticker, file_name: `sticker_${msg.sticker.file_id.slice(0, 8)}.webp`, mime_type: 'image/webp' };
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1]; // Telegram sends photos smallest -> largest
    return { ...largest, file_name: `photo_${largest.file_id.slice(0, 8)}.jpg`, mime_type: 'image/jpeg' };
  }
  return null;
}

function normaliseFile(raw) {
  const mime = raw.mime_type || 'application/octet-stream';
  let fileName = raw.file_name;
  if (!fileName) {
    fileName = `${raw.file_id.slice(0, 12)}${extFromMime(mime) || '.bin'}`;
  }
  return {
    file_id: raw.file_id,
    file_name: fileName,
    file_size: raw.file_size,
    mime_type: mime,
  };
}

// ------------------------------------------------------------------- express
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  const downloading = [...activeDownloads.values()]
    .map((s) => `${escapeHtml(s.fileName)} (${formatSize(s.fileSize)})`)
    .join('<br>');
  res.send(pageHtml({
    title: 'Telegram Downloader Bot — running',
    eyebrow: 'Bot is running',
    icon: '📥',
    heading: 'Telegram Downloader Bot',
    lines: [
      'Send any file to the bot on Telegram and you will get a browser download link, valid for 24 hours.',
      `Active links: ${links.size} &nbsp;•&nbsp; Downloads in progress: ${activeDownloads.size} of ${MAX_CONCURRENT_DOWNLOADS} slots &nbsp;•&nbsp; Max: Telegram max (free 2GB / Premium 4GB) &nbsp;•&nbsp; Uptime: ${Math.floor(process.uptime())}s`,
      `Bot: ${BOT_USERNAME ? '@' + BOT_USERNAME : 'not set (TELEGRAM_BOT_USERNAME)'} &nbsp;•&nbsp; Local Bot API: ${LOCAL_BOT_API_URL || 'not set (hosted api.telegram.org, 20 MB getFile limit)'}`,
      downloading ? `Now downloading:<br>${downloading}` : '',
    ].filter(Boolean),
    buttonText: 'Health check: /health',
    buttonHref: '/health',
  }));
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    links: links.size,
    uptime: Math.floor(process.uptime()),
    activeDownloads: [...activeDownloads.values()].map((s) => ({
      fileName: s.fileName,
      fileSize: s.fileSize,
      startedAt: new Date(s.startedAt).toISOString(),
      bytesSent: s.bytesSent,
    })),
  });
});

app.get('/dl/:token', async (req, res) => {
  const link = links.get(req.params.token);
  if (!link || link.expiresAt <= Date.now()) {
    if (link) links.delete(req.params.token);
    log(`Download: expired/missing token ${req.params.token}`);
    return res.status(404).send(expiredPage());
  }

  if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
    log(`Download: queue, ${link.fileName} — ${activeDownloads.size}/${MAX_CONCURRENT_DOWNLOADS} slots busy`);
    return res.status(503).send(queuePage(link, req.params.token));
  }

  // Acquire a slot. Release is idempotent and fires on EVERY exit path:
  // response finish, response close (client disconnect), stream error,
  // upstream error, and the catch block below — plus the watchdog.
  const slotId = ++downloadSeq;
  const slot = {
    id: slotId,
    fileName: link.fileName,
    fileSize: link.fileSize,
    startedAt: Date.now(),
    lastBytesAt: Date.now(),
    bytesSent: 0,
    res,
    stream: null,
  };
  activeDownloads.set(slotId, slot);
  log(`Download: slot ${slotId} acquired (${activeDownloads.size}/${MAX_CONCURRENT_DOWNLOADS}) ${link.fileName} (${formatSize(link.fileSize)}) token=${req.params.token}`);
  let released = false;
  const release = (reason) => {
    if (released) return;
    released = true;
    activeDownloads.delete(slotId);
    log(`Download: slot ${slotId} released (${reason}) ${link.fileName} — ${activeDownloads.size}/${MAX_CONCURRENT_DOWNLOADS} in use`);
  };
  const noteBytes = (n) => { slot.bytesSent += n; slot.lastBytesAt = Date.now(); };
  res.on('finish', () => release('finished'));
  res.on('close', () => release('client closed'));

  try {
    const tgFile = await getTelegramFile(link.fileId);
    const filePath = tgFile.file_path;
    const safeName = link.fileName.replace(/["\r\n]/g, '_');
    const encodedName = encodeURIComponent(link.fileName).replace(/'/g, '%27');

    res.setHeader('Content-Type', link.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`);
    const knownSize = tgFile.file_size || link.fileSize;
    if (knownSize) res.setHeader('Content-Length', String(knownSize));

    if (filePath && path.isAbsolute(filePath)) {
      // Local Bot API mode: file is already on this server's disk.
      // Stream it — never read it whole into memory.
      if (!fs.existsSync(filePath)) throw new Error(`Local file not found: ${filePath}`);
      const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
      slot.stream = stream;
      stream.on('data', (chunk) => noteBytes(chunk.length));
      stream.on('error', (err) => {
        log(`Download: local stream error ${err.message}`);
        release('local stream error');
        if (!res.headersSent) res.status(502).send(failedPage(err));
        else res.destroy(err);
      });
      stream.pipe(res);
      return;
    }

    // Hosted mode: stream from Telegram's file server, pipe straight through.
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const upstream = await fetch(fileUrl);
    if (!upstream.ok || !upstream.body) {
      throw new Error(`Telegram file download failed (${upstream.status})`);
    }
    if (!res.getHeader('Content-Length') && upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length'));
    }
    const nodeStream = Readable.fromWeb(upstream.body);
    slot.stream = nodeStream;
    nodeStream.on('data', (chunk) => noteBytes(chunk.length));
    nodeStream.on('error', (err) => {
      log(`Download: upstream stream error ${err.message}`);
      release('upstream stream error');
      res.destroy(err);
    });
    nodeStream.pipe(res);
  } catch (err) {
    log(`Download: FAILED ${link.fileName}: ${err.message}`);
    release(`failed: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).send(failedPage(err));
    } else {
      res.destroy(err);
    }
  }
});

// --------------------------------------------------------------------- bot
const HELP_TEXT = [
  '👋 Vanakkam! Naan Telegram Downloader Bot.',
  '',
  'Epdi use panna:',
  '1. Edhaavathu file ah enakku anuppu (photo, video, document, audio — edhuvum).',
  '2. Naan oru browser download link kuduppen.',
  '3. Andha link ah browser la open panna file download aagum.',
  '',
  'Rules:',
  '• Link 24 hours ku appuram expire aayidum.',
  '• Size limit illa — Telegram max varaikum: free 2GB, Premium 4GB.',
  '• 0 cost, slow ah irundhalum paravala, oru time la 3 downloads varaikum.',
  '',
  '👋 Hello! I am the Telegram Downloader Bot.',
  '',
  'How to use:',
  '1. Send me any file (photo, video, document, audio — anything).',
  '2. I reply with a browser download link.',
  '3. Open the link in a browser to download the file.',
  '',
  'Rules:',
  '• The link expires after 24 hours.',
  '• No size limit — up to Telegram\'s max: free 2GB, Premium 4GB.',
  '• Free, slow is fine, up to 3 downloads at a time.',
].join('\n');

let bot = null;
if (BOT_TOKEN && BOT_TOKEN !== 'dummy' && BOT_TOKEN !== 'PASTE_YOUR_BOT_TOKEN_HERE') {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    bot.on('polling_error', (err) => log(`Bot polling error: ${err.message}`));
    bot.on('error', (err) => log(`Bot error: ${err.message}`));

    bot.onText(/^\/start/, async (msg) => {
      try { await bot.sendMessage(msg.chat.id, HELP_TEXT); }
      catch (err) { log(`Bot /start reply failed: ${err.message}`); }
    });

    bot.on('message', async (msg) => {
      try {
        if (!msg || msg.text) return; // /start handled above; plain text gets no link
        const raw = pickFile(msg);
        if (!raw) {
          await bot.sendMessage(msg.chat.id, 'File anuppu da — photo, video, document, audio edhuvum. Text ku link kedaikkadhu. / Send a file — photo, video, document or audio. Text has no download link.');
          return;
        }
        const file = normaliseFile(raw);
        if (file.file_size && file.file_size > MAX_FILE_SIZE) {
          await bot.sendMessage(msg.chat.id, `❌ Telegram max 4GB dhaan. Indha file ${formatSize(file.file_size)} — 4GB ku mela anuppa mudiyadhu. / Telegram max is 4GB. This file is ${formatSize(file.file_size)} — files over 4GB cannot be sent on Telegram.`);
          return;
        }
        const token = createLink(file);
        const link = `${BASE_URL}/dl/${token}`;
        const expiry = new Date(Date.now() + LINK_TTL_MS).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        log(`Link created: ${file.file_name} (${formatSize(file.fileSize)}) token=${token} chat=${msg.chat.id}`);
        await bot.sendMessage(msg.chat.id, [
          '✅ Link ready!',
          '',
          `📄 ${file.file_name}`,
          `📦 Size: ${formatSize(file.fileSize)}`,
          `⏰ Expires: ${expiry} IST (24 hours)`,
          '',
          `🔗 ${link}`,
          '',
          'Browser la open panna download aagum. / Open it in a browser to download.',
        ].join('\n'));
      } catch (err) {
        log(`Bot message handler failed: ${err.message}`);
        try { await bot.sendMessage(msg.chat.id, '❌ Sorry, link create panna mudiyala. Thirumba try pannu. / Sorry, could not create the link. Please try again.'); } catch (_) {}
      }
    });
    log('Bot polling started');
  } catch (err) {
    log(`Bot failed to start (HTTP server still runs): ${err.message}`);
    bot = null;
  }
} else {
  log('No real TELEGRAM_BOT_TOKEN set — bot polling disabled, HTTP server still runs (local test mode)');
}

app.listen(PORT, () => {
  log(`HTTP server listening on port ${PORT}`);
  log(`BASE_URL=${BASE_URL}`);
  log(`LOCAL_BOT_API_URL=${LOCAL_BOT_API_URL || '(not set — hosted api.telegram.org)'}`);
  log(`Bot: ${bot ? 'polling ON' : 'OFF (no token)'}`);
});

module.exports = { app, createLink, links, activeDownloads, MAX_CONCURRENT_DOWNLOADS, pruneStaleDownloads };
