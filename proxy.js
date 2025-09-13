// proxy.js
// Usage (macOS / Linux):
//   export HELIUS_API_KEY="YOUR_HELIUS_KEY"
//   export TELEGRAM_BOT_TOKEN="123456:ABC..."
//   export TELEGRAM_CHAT_ID="123456789"
//   # optional alternative RPC:
//   export SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
//   # optional port override (default 5050):
//   export PORT=5050
//   node proxy.js

const http = require('http');
const express = require('express');

const fetch =
  global.fetch ||
  ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const app = express();
app.use(express.json());

// ----- CORS (open to your origin) -----
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-chain');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ----- Config -----
const PORT = Number(process.env.PORT || 5050);
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// ----- Helpers -----
function logErr(ctx, err, extra) {
  const x = extra ? ` | ${extra}` : '';
  console.error(`[${new Date().toISOString()}] ${ctx} ERROR:`, err, x);
}
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}
async function tryJson(url, opts) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}
function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

// In-memory per-wallet cache + cooldown for RPC 429
const cacheFast = new Map(); // wallet -> { ts: number, data: any[] }
const cooldown = new Map();  // wallet -> number (epoch ms)
const FAST_TTL_MS = 15_000;  // serve cached data for 15s
const COOLDOWN_MS = 45_000;  // on 429, avoid RPC for 45s

// ----- Health -----
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    hasHeliusKey: Boolean(HELIUS_API_KEY),
    hasTelegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    rpc: SOLANA_RPC_URL,
  });
});

/* ----------------------------------------------------------------------------
   1) FAST freshest transactions for a wallet
      A) RPC getSignaturesForAddress (fast, cheap)
      B) Helius parse batch by signatures (rich, typed)
---------------------------------------------------------------------------- */
app.get('/api/helius-fast', async (req, res) => {
  const ctx = '/api/helius-fast';
  try {
    const { wallet, limit } = req.query;
    const lim = Math.min(Number(limit) || 40, 100);
    if (!wallet || !HELIUS_API_KEY) {
      return res.status(400).json({ error: 'Missing wallet or API key' });
    }

    // Serve cache if fresh to reduce RPC calls
    const now = Date.now();
    const cached = cacheFast.get(wallet);
    if (cached && (now - cached.ts) < FAST_TTL_MS) {
      res.set('X-Source', 'cache');
      return res.json(cached.data);
    }

    // If in cooldown due to prior 429, use slow fallback
    const until = cooldown.get(wallet) || 0;
    if (now < until) {
      const slowUrl = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(wallet)}/transactions?api-key=${HELIUS_API_KEY}&limit=${encodeURIComponent(lim)}`;
      const slowRes = await fetch(slowUrl);
      const slowTxt = await slowRes.text().catch(() => '');
      if (!slowRes.ok) {
        return res.status(slowRes.status).json({ error: 'Helius slow failed (cooldown)', details: slowTxt || slowRes.statusText });
      }
      let slowData;
      try { slowData = JSON.parse(slowTxt); } catch { slowData = []; }
      if (!Array.isArray(slowData)) slowData = slowData?.items || [];
      cacheFast.set(wallet, { ts: now, data: slowData });
      res.set('X-Source', 'slow-fallback-cooldown');
      return res.json(slowData);
    }

    // A) get signatures
    const rpcBody = {
      jsonrpc: '2.0',
      id: 'getSigs',
      method: 'getSignaturesForAddress',
      params: [wallet, { limit: lim }],
    };

    const rpcTimeout = withTimeout(15000);
    const rpcRes = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpcBody),
      signal: rpcTimeout.signal,
    }).catch((e) => ({ ok: false, status: 599, statusText: String(e?.message || e) }));
    rpcTimeout.cancel();

    if (!rpcRes.ok) {
      const t = (await rpcRes.text?.().catch(() => '')) || '';
      // On RPC 429, enter cooldown and slow-fallback
      if (rpcRes.status === 429 || /429/.test(t)) {
        cooldown.set(wallet, now + COOLDOWN_MS);
        const slowUrl = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(wallet)}/transactions?api-key=${HELIUS_API_KEY}&limit=${encodeURIComponent(lim)}`;
        const slowRes = await fetch(slowUrl);
        const slowTxt = await slowRes.text().catch(() => '');
        if (!slowRes.ok) {
          return res.status(slowRes.status).json({ error: 'Helius slow failed (after 429)', details: slowTxt || slowRes.statusText });
        }
        let slowData;
        try { slowData = JSON.parse(slowTxt); } catch { slowData = []; }
        if (!Array.isArray(slowData)) slowData = slowData?.items || [];
        cacheFast.set(wallet, { ts: now, data: slowData });
        res.set('X-Source', 'slow-fallback-429');
        return res.json(slowData);
      }

      logErr(ctx, `RPC non-ok ${rpcRes.status}`, t);
      return res.status(rpcRes.status).json({ error: 'RPC error', details: t || rpcRes.statusText });
    }

    const rpcJson = await rpcRes.json();
    if (rpcJson?.error) {
      if (Number(rpcJson.error?.code) === 429) {
        cooldown.set(wallet, now + COOLDOWN_MS);
        const slowUrl = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(wallet)}/transactions?api-key=${HELIUS_API_KEY}&limit=${encodeURIComponent(lim)}`;
        const slowRes = await fetch(slowUrl);
        const slowTxt = await slowRes.text().catch(() => '');
        if (!slowRes.ok) {
          return res.status(slowRes.status).json({ error: 'Helius slow failed (after rpc error 429)', details: slowTxt || slowRes.statusText });
        }
        let slowData;
        try { slowData = JSON.parse(slowTxt); } catch { slowData = []; }
        if (!Array.isArray(slowData)) slowData = slowData?.items || [];
        cacheFast.set(wallet, { ts: now, data: slowData });
        res.set('X-Source', 'slow-fallback-429-json');
        return res.json(slowData);
      }
      logErr(ctx, 'RPC error field', JSON.stringify(rpcJson.error));
      return res.status(502).json({ error: 'RPC error', details: rpcJson.error });
    }

    const sigs = (rpcJson?.result || []).map((r) => r.signature).filter(Boolean);
    if (sigs.length === 0) {
      cacheFast.set(wallet, { ts: now, data: [] });
      res.set('X-Source', 'fast-empty');
      return res.json([]);
    }

    // B) Helius parse by signatures
    const heliusParseUrl = `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_API_KEY}`;
    const parseTimeout = withTimeout(15000);
    const parseRes = await fetch(heliusParseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactions: sigs }),
      signal: parseTimeout.signal,
    }).catch((e) => ({ ok: false, status: 599, statusText: String(e?.message || e) }));
    parseTimeout.cancel();

    if (!parseRes.ok) {
      const t = (await parseRes.text?.().catch(() => '')) || '';
      logErr(ctx, `Helius parse non-ok ${parseRes.status}`, t);
      return res.status(parseRes.status).json({ error: 'Helius parse failed', details: t || parseRes.statusText });
    }

    const parsed = await parseRes.json();
    if (!Array.isArray(parsed)) {
      logErr(ctx, 'Helius parse not array', JSON.stringify(parsed));
      return res.status(502).json({ error: 'Helius did not return array', details: parsed });
    }

    cacheFast.set(wallet, { ts: now, data: parsed });
    res.set('X-Source', 'fast-rpc+parse');
    res.json(parsed);
  } catch (e) {
    logErr(ctx, e);
    res.status(500).json({ error: 'Proxy error', details: String(e.message || e) });
  }
});

/* ----------------------------------------------------------------------------
   2) SLOWER indexer endpoint (fallback / historic)
---------------------------------------------------------------------------- */
app.get('/api/helius', async (req, res) => {
  const ctx = '/api/helius';
  try {
    const { wallet, limit } = req.query;
    if (!wallet || !HELIUS_API_KEY) {
      return res.status(400).json({ error: 'Missing wallet or API key' });
    }
    const url = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(wallet)}/transactions?api-key=${HELIUS_API_KEY}&limit=${encodeURIComponent(
      limit || 20
    )}`;

    const apiTimeout = withTimeout(15000);
    const apiRes = await fetch(url, { signal: apiTimeout.signal }).catch((e) => ({ ok: false, status: 599, statusText: String(e?.message || e) }));
    apiTimeout.cancel();

    const text = (await apiRes.text?.().catch(() => '')) || '';
    if (!apiRes.ok) {
      logErr(ctx, `Helius returned ${apiRes.status}`, text);
      return res.status(apiRes.status).json({ error: 'Failed to fetch from Helius', details: text || apiRes.statusText });
    }

    let data;
    try { data = JSON.parse(text); } catch {
      logErr(ctx, 'JSON parse error', text);
      return res.status(502).json({ error: 'Invalid JSON from Helius', details: text.slice(0, 500) });
    }

    if (!Array.isArray(data)) {
      logErr(ctx, 'Helius not array', JSON.stringify(data).slice(0, 800));
      return res.status(502).json({ error: 'Helius did not return an array', details: data });
    }

    res.json(data);
  } catch (e) {
    logErr(ctx, e);
    res.status(500).json({ error: 'Proxy error', details: String(e.message || e) });
  }
});

/* ----------------------------------------------------------------------------
   3) Token metadata (returns {symbol, name, logo})
      Order: Helius → Jupiter → SolanaFM → Birdeye → Solana Labs list → empty
---------------------------------------------------------------------------- */
app.get('/api/token-metadata', async (req, res) => {
  const { mint } = req.query;
  if (!mint) return res.status(400).json({ error: 'Missing mint param' });

  // Helius
  if (HELIUS_API_KEY) {
    const heliusUrl = `https://api.helius.xyz/v0/tokens/metadata?mint=${encodeURIComponent(
      mint
    )}&api-key=${HELIUS_API_KEY}`;
    const j = await tryJson(heliusUrl);
    const meta = Array.isArray(j) ? j[0] : j;
    if (meta && (meta.symbol || meta.name || meta.logoURI)) {
      return res.json({
        symbol: meta.symbol || '',
        name: meta.name || '',
        logo: meta.logoURI || '',
      });
    }
  }

  // Jupiter
  const jup = await tryJson('https://token.jup.ag/all');
  if (Array.isArray(jup)) {
    const t = jup.find((x) => x.address === mint);
    if (t) {
      return res.json({ symbol: t.symbol || '', name: t.name || '', logo: t.logoURI || '' });
    }
  }

  // SolanaFM
  const sfm = await tryJson(`https://api.solana.fm/v0/tokens/${encodeURIComponent(mint)}`, {
    headers: { accept: 'application/json' },
  });
  const r = sfm?.result;
  if (r && (r.symbol || r.name || r.logoURI)) {
    return res.json({ symbol: r.symbol || '', name: r.name || '', logo: r.logoURI || '' });
  }

  // Birdeye
  const be = await tryJson(`https://public-api.birdeye.so/public/token/${encodeURIComponent(mint)}`);
  const bd = be?.data;
  if (bd && (bd.symbol || bd.name || bd.logoURI)) {
    return res.json({ symbol: bd.symbol || '', name: bd.name || '', logo: bd.logoURI || '' });
  }

  // Solana Labs list (last resort)
  const tlist = await tryJson(
    'https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json'
  );
  const tk = tlist?.tokens?.find((x) => x.address === mint);
  if (tk) {
    return res.json({ symbol: tk.symbol || '', name: tk.name || '', logo: tk.logoURI || '' });
  }

  res.json({ symbol: '', name: '', logo: '' });
});

/* ----------------------------------------------------------------------------
   4) Mint-born timestamp (best-effort)
      SolanaFM (firstSeen/createdAt) → Birdeye (createdTime ms) → null
---------------------------------------------------------------------------- */
app.get('/api/mint-born', async (req, res) => {
  const { mint } = req.query;
  if (!mint) return res.status(400).json({ error: 'Missing mint param' });

  let born = null;

  // SolanaFM
  const sfm = await tryJson(`https://api.solana.fm/v0/tokens/${encodeURIComponent(mint)}`, {
    headers: { accept: 'application/json' },
  });
  const r = sfm?.result;
  if (typeof r?.firstSeen === 'number') born = r.firstSeen;
  else if (typeof r?.createdAt === 'number') born = r.createdAt;

  // Birdeye as fallback
  if (!born) {
    const be = await tryJson(`https://public-api.birdeye.so/public/token/${encodeURIComponent(mint)}`);
    const ms = be?.data?.createdTime;
    if (ms) born = Math.floor(ms / 1000);
  }

  res.json({ bornTs: born ?? null });
});

/* ----------------------------------------------------------------------------
   5) Telegram Notifications
---------------------------------------------------------------------------- */

// Rich swap notifier (BUY/SELL)
app.post('/api/notify-swap', async (req, res) => {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(200).json({ ok: false, reason: 'Telegram not configured' });
    }
    const {
      side,               // BUY | SELL
      time,               // already formatted, optional
      tokenName,
      symbol,
      mint,
      sizeSOL,
      signature,
      logo,               // token logo url (optional)
      minutesSinceBorn,   // number | null
      tokenUrl,           // solscan token url
      txUrl,              // solscan tx url
      tradeUrl,           // jup/axiom url
      wallet              // optional
    } = req.body || {};

    const name = tokenName || symbol || (mint ? mint.slice(0, 6) + '…' : 'Unknown');
    const tokenLink = tokenUrl || (mint ? `https://solscan.io/token/${mint}` : '');
    const txLink = txUrl || (signature ? `https://solscan.io/tx/${signature}` : '');
    const axiomLink = tradeUrl || (mint ? `https://app.axiom.trade/token/${mint}` : '');

    const html =
      `<b>${side || 'SWAP'} Alert</b>\n` +
      (time ? `Time: <b>${escapeHtml(time)}</b>\n` : '') +
      `Token: <a href="${tokenLink}">${escapeHtml(name)}</a>\n` +
      (typeof minutesSinceBorn === 'number' ? `Since born: <b>${minutesSinceBorn} min</b>\n` : '') +
      (typeof sizeSOL === 'number' ? `Size: <b>${Number(sizeSOL).toFixed(6)} SOL</b>\n` : '') +
      (wallet ? `Wallet: <code>${wallet}</code>\n` : '') +
      (txLink ? `Tx: <a href="${txLink}">Solscan</a>\n` : '') +
      (axiomLink ? `Trade: <a href="${axiomLink}">Axiom</a>\n` : '');

    await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_BOT_TOKEN)}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        }),
      }
    );

    if (logo) {
      await fetch(
        `https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_BOT_TOKEN)}/sendPhoto`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            photo: logo,
            caption: name,
            parse_mode: 'HTML',
          }),
        }
      );
    }

    res.json({ ok: true });
  } catch (e) {
    logErr('/api/notify-swap', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Legacy simple BUY notifier
app.post('/api/notify-buy', async (req, res) => {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(200).json({ ok: false, reason: 'Telegram not configured' });
    }
    const {
      mint,
      tokenName,
      symbol,
      wallet,
      signature,
      solUsed,
      minutesSinceBorn,
      tokenLogo,
    } = req.body || {};

    const name = tokenName || symbol || (mint ? mint.slice(0, 6) + '…' : 'Unknown');
    const tokenLink = mint ? `https://solscan.io/token/${mint}` : '';
    const txLink = signature ? `https://solscan.io/tx/${signature}` : '';
    const axiomLink = mint ? `https://app.axiom.trade/token/${mint}` : '';

    const html =
      `<b>BUY Alert</b>\n` +
      `Token: <a href="${tokenLink}">${escapeHtml(name)}</a>\n` +
      (typeof minutesSinceBorn === 'number' ? `Since born: <b>${minutesSinceBorn} min</b>\n` : '') +
      (typeof solUsed === 'number' ? `Size: <b>${Number(solUsed).toFixed(6)} SOL</b>\n` : '') +
      (wallet ? `Wallet: <code>${wallet}</code>\n` : '') +
      (txLink ? `Tx: <a href="${txLink}">Solscan</a>\n` : '') +
      (axiomLink ? `Trade: <a href="${axiomLink}">Axiom</a>\n` : '');

    await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_BOT_TOKEN)}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        }),
      }
    );

    if (tokenLogo) {
      await fetch(
        `https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_BOT_TOKEN)}/sendPhoto`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            photo: tokenLogo,
            caption: name,
            parse_mode: 'HTML',
          }),
        }
      );
    }

    res.json({ ok: true });
  } catch (e) {
    logErr('/api/notify-buy', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Global error handler ensures CORS headers on all errors
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-chain");
  res.status(500).json({ error: "Proxy crashed", details: String(err) });
});

// ----- Start HTTP server -----
http.createServer(app).listen(PORT, () => {
  console.log(`✅ Proxy listening on port ${PORT}`);
  console.log(`   RPC: ${SOLANA_RPC_URL}`);
  console.log(`   Helius Key: ${HELIUS_API_KEY ? 'present' : 'MISSING'}`);
  console.log(`   Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'configured' : 'not configured'}`);
});
