require('dotenv').config();
const express = require('express');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
const cache = new NodeCache({ stdTTL: 60 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// yahoo-finance2 uses ESM — load dynamically
let yf = null;
(async () => {
  try {
    const mod = await import('yahoo-finance2');
    yf = mod.default;
    yf.setGlobalConfig({ validation: { logErrors: false } });
    console.log('✅ yahoo-finance2 ready');
  } catch (e) {
    console.error('❌ yahoo-finance2 load failed:', e.message);
  }
})();

function getYF() {
  if (!yf) throw new Error('yahoo-finance2 not ready yet');
  return yf;
}

// ── cache wrapper ────────────────────────────────────────
function cached(key, ttl, fn) {
  return async (req, res) => {
    const cacheKey = key + JSON.stringify(req.params) + JSON.stringify(req.query);
    const hit = cache.get(cacheKey);
    if (hit) return res.json(hit);
    try {
      const data = await fn(req);
      cache.set(cacheKey, data, ttl);
      res.json(data);
    } catch (e) {
      console.error(`[${key}]`, e.message);
      res.status(500).json({ error: e.message });
    }
  };
}

// range string → Date
function rangeToDate(range) {
  const map = { '1d':1,'5d':5,'1mo':30,'3mo':90,'6mo':180,'1y':365,'2y':730,'5y':1825 };
  const days = map[range] || 5;
  return new Date(Date.now() - days * 864e5);
}

// ── /api/quotes?symbols=AAPL,^KS11 ─────────────────────
app.get('/api/quotes', cached('quotes', 30, async (req) => {
  const yf = getYF();
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) throw new Error('symbols required');

  const results = await Promise.allSettled(
    symbols.map(sym => yf.quote(sym))
  );

  const quotes = results
    .map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      console.warn(`quote failed for ${symbols[i]}:`, r.reason?.message);
      return null;
    })
    .filter(Boolean);

  return { quoteResponse: { result: quotes, error: null } };
}));

// ── /api/chart/:symbol?range=5d&interval=1h ─────────────
app.get('/api/chart/:symbol', cached('chart', 120, async (req) => {
  const yf = getYF();
  const { symbol } = req.params;
  const { range = '5d', interval = '1h' } = req.query;

  const result = await yf.chart(symbol, {
    period1: rangeToDate(range),
    interval,
    includePrePost: false,
  });

  const quotes = result.quotes || [];
  const timestamps = quotes.map(q => Math.floor(new Date(q.date).getTime() / 1000));
  const closes    = quotes.map(q => q.close  ?? null);
  const opens     = quotes.map(q => q.open   ?? null);
  const highs     = quotes.map(q => q.high   ?? null);
  const lows      = quotes.map(q => q.low    ?? null);
  const volumes   = quotes.map(q => q.volume ?? null);

  return {
    chart: {
      result: [{
        timestamp: timestamps,
        meta: result.meta || {},
        indicators: {
          quote: [{ close: closes, open: opens, high: highs, low: lows, volume: volumes }]
        }
      }],
      error: null
    }
  };
}));

// ── /api/indices ─────────────────────────────────────────
app.get('/api/indices', cached('indices', 30, async () => {
  const yf = getYF();
  const symbols = ['^KS11', '^KQ11', '^GSPC', '^IXIC', 'KRW=X', 'BTC-USD', 'GC=F'];
  const results = await Promise.allSettled(symbols.map(s => yf.quote(s)));
  const quotes = results
    .map((r, i) => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);
  return { quoteResponse: { result: quotes, error: null } };
}));

// ── /api/sectors ─────────────────────────────────────────
app.get('/api/sectors', cached('sectors', 120, async () => {
  const yf = getYF();
  const etfs = ['SOXX','LIT','BOTZ','XBI','XLE','XLF','XLY','IYR','ITA','WCLD','SMH','ARKK'];
  const results = await Promise.allSettled(etfs.map(s => yf.quote(s)));
  const quotes = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);
  return { quoteResponse: { result: quotes, error: null } };
}));

// ── /api/search?q=samsung ────────────────────────────────
app.get('/api/search', cached('search', 300, async (req) => {
  const yf = getYF();
  const { q } = req.query;
  if (!q) throw new Error('q required');
  const data = await yf.search(q, { quotesCount: 8, newsCount: 0 });
  const results = (data.quotes || []).map(r => ({
    symbol:   r.symbol,
    name:     r.shortname || r.longname || r.symbol,
    type:     r.quoteType,
    exchange: r.exchDisp,
  }));
  return { results };
}));

// ── /api/news?q=stock ────────────────────────────────────
app.get('/api/news', cached('news', 300, async (req) => {
  const yf = getYF();
  const { q = 'stock market' } = req.query;
  const data = await yf.search(q, { quotesCount: 0, newsCount: 12 });
  const news = (data.news || []).map(n => ({
    title:     n.title,
    publisher: n.publisher,
    link:      n.link,
    time:      new Date((n.providerPublishTime || 0) * 1000)
                 .toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' }),
  }));
  return { news };
}));

// ── /api/summary/:symbol ─────────────────────────────────
app.get('/api/summary/:symbol', cached('summary', 3600, async (req) => {
  const yf = getYF();
  const data = await yf.quoteSummary(req.params.symbol, {
    modules: ['summaryDetail', 'financialData', 'defaultKeyStatistics']
  });
  return data;
}));

// ── /api/health ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', yfReady: !!yf, time: new Date().toISOString() });
});

// ── SPA fallback ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ STOCKTERM 서버 실행 중 → http://localhost:${PORT}`);
});
