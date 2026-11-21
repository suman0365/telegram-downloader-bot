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
 * Hosting: Render free (512 MB RAM). One download at a time, streaming
 * only, no disk storage of files. Keep-alive ping (every 5 min) keeps
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

// ------------------------------------------------------------- download mutex
// Render free = 512 MB RAM. Only ONE download streams at a time, so a
// second browser request gets a friendly "try again" page instead of OOM.
let downloadInProgress = false;

function pageHtml({ title, heading, lines, buttonText, buttonHref }) {
  const body = (lines || []).map((l) => `<p>${l}</p>`).join('\n');
  const button = buttonHref
    ? `<a class="btn" href="${escapeHtml(buttonHref)}">${escapeHtml(buttonText || 'Open')}</a>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{background:#0f1115;color:#e8eaf0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.card{background:#1a1d27;border:1px solid #2a2f3f;border-radius:16px;max-width:520px;width:100%;padding:28px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{font-size:22px;margin:0 0 12px}.muted{color:#9aa3b2;font-size:14px;line-height:1.6}
.btn{display:inline-block;margin-top:18px;background:#2ea6ff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600}
</style></head><body><div class="card"><h1>${escapeHtml(heading)}</h1><div class="muted">${body}</div>${button}</div></body></html>`;
}

function expiredPage() {
  const botHref = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : 'https://t.me/';
  return pageHtml({
    title: 'Download link expired — Telegram Downloader Bot',
    heading: '⏰ Download link expired',
    lines: [
      'Indha link 24 hours ku appuram expire aayiduchu. / This link expired after 24 hours.',
      'File ah bot ku Telegram la thirumba anuppu, pudhu link kedaikkum. / Send the file to the bot again on Telegram for a fresh link.',
      'File server la save pannala, adhanala old link ah restore panna mudiyadhu. / The file was never stored on the server, so the old link cannot be restored.',
    ],
    buttonText: 'Open Telegram Bot →',
    buttonHref: botHref,
  });
}

function busyPage() {
  const botHref = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : 'https://t.me/';
  return pageHtml({
    title: 'One download in progress — Telegram Downloader Bot',
    heading: '⏳ Oru download nadandhutu irukku',
    lines: [
      'Free server la oru time la oru download dhaan. / Only one download at a time on the free server.',
      'Konjam neram kazhichu thirumba try pannunga. Link 24 hours varaikum valid. / Please try again in a little while. Your link stays valid for 24 hours.',
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
  res.send(pageHtml({
    title: 'Telegram Downloader Bot — running',
    heading: '📥 Telegram Downloader Bot',
    lines: [
      'Bot running. / Bot run aagudhu.',
      'Telegram la file ah bot ku anuppu — browser download link kedaikkum, 24 hours ku valid. / Send a file to the bot on Telegram — you get a browser download link, valid for 24 hours.',
      `Active links: ${links.size} &nbsp;•&nbsp; Max: Telegram max (free 2GB / Premium 4GB) &nbsp;•&nbsp; Uptime: ${Math.floor(process.uptime())}s`,
      `Bot: ${BOT_USERNAME ? '@' + BOT_USERNAME : 'not set (TELEGRAM_BOT_USERNAME)'} &nbsp;•&nbsp; Local Bot API: ${LOCAL_BOT_API_URL || 'not set (hosted api.telegram.org, 20 MB getFile limit)'}`,
    ],
    buttonText: 'Health check: /health',
    buttonHref: '/health',
  }));
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, links: links.size, uptime: Math.floor(process.uptime()) });
});

app.get('/dl/:token', async (req, res) => {
  const link = links.get(req.params.token);
  if (!link || link.expiresAt <= Date.now()) {
    if (link) links.delete(req.params.token);
    log(`Download: expired/missing token ${req.params.token}`);
    return res.status(404).send(expiredPage());
  }

  if (downloadInProgress) {
    log(`Download: busy, rejected ${link.fileName}`);
    return res.status(503).send(busyPage());
  }
  downloadInProgress = true;
  const release = () => { downloadInProgress = false; };
  res.on('finish', release);
  res.on('close', release);

  log(`Download: start ${link.fileName} (${formatSize(link.fileSize)}) token=${req.params.token}`);

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
      stream.on('error', (err) => {
        log(`Download: local stream error ${err.message}`);
        if (!res.headersSent) res.status(502).send(expiredPage());
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
    nodeStream.on('error', (err) => {
      log(`Download: upstream stream error ${err.message}`);
      res.destroy(err);
    });
    nodeStream.pipe(res);
  } catch (err) {
    log(`Download: FAILED ${link.fileName}: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).send(pageHtml({
        title: 'Download failed — Telegram Downloader Bot',
        heading: '❌ Download failed',
        lines: [
          'Telegram la irundhu file ah edukka mudiyala. / Could not fetch the file from Telegram.',
          `Reason: ${escapeHtml(err.message)}`,
          'Periya file na (20 MB ku mela) Local Bot API server on la irukkanum. README paaru. / For big files (over 20 MB) the Local Bot API server must be on. See the README.',
          'File ah bot ku thirumba anuppu, pudhu link try pannu. / Send the file to the bot again for a fresh link.',
        ],
        buttonText: 'Open Telegram Bot →',
        buttonHref: BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : 'https://t.me/',
      }));
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
  '• 0 cost, slow ah irundhalum paravala, oru time la oru download.',
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
  '• Free, slow is fine, one download at a time.',
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

module.exports = { app, createLink, links };
