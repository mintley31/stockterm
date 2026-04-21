require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
const cache = new NodeCache({ stdTTL: 60 }); // 60초 캐시

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AV_KEY = process.env.ALPHA_VANTAGE_KEY || 'demo';
const YF_BASE = 'https://query1.finance.yahoo.com';
const YF_BASE2 = 'https://query2.finance.yahoo.com';

// ─── 공통 Yahoo Finance 헤더 (CORS 우회) ───
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  'Referer': 'https://finance.yahoo.com',
};

// ─── 캐시 미들웨어 ───
function withCache(key, ttl = 60) {
  return (req, res, next) => {
    const cacheKey = key + JSON.stringify(req.query);
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
    res.sendCached = (data) => {
      cache.set(cacheKey, data, ttl);
      res.json(data);
    };
    next();
  };
}

// ════════════════════════════════════════
// API: 실시간 시세 (Yahoo Finance)
// GET /api/quotes?symbols=AAPL,005930.KS,...
// ════════════════════════════════════════
app.get('/api/quotes', withCache('quotes', 30), async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols 파라미터 필요' });

  try {
    const url = `${YF_BASE}/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,marketCap,shortName,longName,currency,fiftyTwoWeekHigh,fiftyTwoWeekLow,trailingPE`;
    const r = await fetch(url, { headers: YF_HEADERS });
    const data = await r.json();
    res.sendCached(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
// API: 차트 데이터 (Yahoo Finance)
// GET /api/chart/:symbol?range=5d&interval=1h
// ════════════════════════════════════════
app.get('/api/chart/:symbol', withCache('chart', 120), async (req, res) => {
  const { symbol } = req.params;
  const { range = '5d', interval = '1h' } = req.query;

  try {
    const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
    const r = await fetch(url, { headers: YF_HEADERS });
    const data = await r.json();
    res.sendCached(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
// API: 지수 한 번에 (인덱스 스트립용)
// GET /api/indices
// ════════════════════════════════════════
app.get('/api/indices', withCache('indices', 30), async (req, res) => {
  const symbols = ['^KS11', '^KQ11', '^GSPC', '^IXIC', '^DJI', 'KRW=X', 'GC=F', 'BTC-USD'];
  try {
    const url = `${YF_BASE}/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}&fields=regularMarketPrice,regularMarketChangePercent,shortName`;
    const r = await fetch(url, { headers: YF_HEADERS });
    const data = await r.json();
    res.sendCached(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
// API: 섹터 히트맵
// GET /api/sectors
// ════════════════════════════════════════
app.get('/api/sectors', withCache('sectors', 120), async (req, res) => {
  const etfs = ['SOXX', 'LIT', 'BOTZ', 'XBI', 'XLE', 'XLF', 'XLY', 'IYR', 'ITA', 'WCLD', 'SMH', 'ARKK'];
  try {
    const url = `${YF_BASE}/v7/finance/quote?symbols=${etfs.join(',')}&fields=regularMarketPrice,regularMarketChangePercent,shortName`;
    const r = await fetch(url, { headers: YF_HEADERS });
    const data = await r.json();
    res.sendCached(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
// API: 종목 검색 (자동완성)
// GET /api/search?q=삼성
// ════════════════════════════════════════
app.get('/api/search', withCache('search', 300), async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q 파라미터 필요' });

  try {
    const url = `${YF_BASE}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`;
    const r = await fetch(url, { headers: YF_HEADERS });
    const data = await r.json();
    const results = (data.quotes || []).map(q => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      type: q.quoteType,
      exchange: q.exchDisp,
    }));
    res.sendCached({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
// API: Alpha Vantage — 기업 정보
// GET /api/company/:symbol
// ════════════════════════════════════════
app.get('/api/company/:symbol', withCache('company', 3600), async (req, res) => {
  const { symbol } = req.params;
  try {
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${AV_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.sendCached(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
// API: Alpha Vantage — RSI / 기술적 지표
// GET /api/rsi/:symbol
// ════════════════════════════════════════
app.get('/api/rsi/:symbol', withCache('rsi', 3600), async (req, res) => {
  const { symbol } = req.params;
  try {
    const url = `https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=daily&time_period=14&series_type=close&apikey=${AV_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    const values = data['Technical Analysis: RSI'];
    if (!values) return res.json({ rsi: null, note: 'API 한도 초과 또는 잘못된 키' });
    const latest = Object.entries(values)[0];
    res.sendCached({ date: latest[0], rsi: parseFloat(latest[1]['RSI']) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
// API: 뉴스 (Yahoo Finance)
// GET /api/news?q=삼성전자
// ════════════════════════════════════════
app.get('/api/news', withCache('news', 300), async (req, res) => {
  const { q = '한국주식' } = req.query;
  try {
    const url = `${YF_BASE}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=10&listsCount=0`;
    const r = await fetch(url, { headers: YF_HEADERS });
    const data = await r.json();
    const news = (data.news || []).map(n => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      time: new Date(n.providerPublishTime * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
      thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
    }));
    res.sendCached({ news });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
// API: 환율 (Yahoo Finance)
// GET /api/forex
// ════════════════════════════════════════
app.get('/api/forex', withCache('forex', 60), async (req, res) => {
  const pairs = ['KRW=X', 'JPYKRW=X', 'EURKRW=X', 'CNYKRW=X'];
  try {
    const url = `${YF_BASE}/v7/finance/quote?symbols=${pairs.join(',')}&fields=regularMarketPrice,regularMarketChangePercent`;
    const r = await fetch(url, { headers: YF_HEADERS });
    const data = await r.json();
    res.sendCached(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────
// 헬스체크
// ────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), avKey: AV_KEY !== 'demo' ? 'set' : 'demo' });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ STOCKTERM 서버 실행 중 → http://localhost:${PORT}`));
