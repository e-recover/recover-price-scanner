const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV ---
const KEEPA_KEY = process.env.KEEPA_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
const BM_KEY = process.env.BM_KEY;
const NINJA_KEY = process.env.NINJA_KEY || process.env.RAPIDAPI_KEY;

// --- Middleware ---
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Mapping Keepa domain (numerico) -> SerpApi amazon_domain (TLD) ---
const SERPAPI_DOMAIN_MAP = {
  "8": "amazon.it",
  "3": "amazon.de",
  "4": "amazon.fr",
  "9": "amazon.es",
  "1": "amazon.com",
  "2": "amazon.co.uk"
};

// --- Mapping Keepa domain -> Back Market market (TLD + locale) ---
const BM_MARKETS = {
  IT: { host: "www.backmarket.it", locale: "it-it" },
  FR: { host: "www.backmarket.fr", locale: "fr-fr" },
  DE: { host: "www.backmarket.de", locale: "de-de" },
  ES: { host: "www.backmarket.es", locale: "es-es" },
  NL: { host: "www.backmarket.nl", locale: "nl-nl" }
};

// =====================================================
// KEEPA - standard product call
// =====================================================
app.get("/api/keepa", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!KEEPA_KEY) return res.status(500).json({ error: "Keepa API key not configured" });

  try {
    const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domain}&asin=${asin}&stats=1`;
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) throw new Error(`Keepa error: ${r.status}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// KEEPA OFFERS - includes live offers + monthlySold
// =====================================================
app.get("/api/keepa-offers", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!KEEPA_KEY) return res.status(500).json({ error: "Keepa API key not configured" });

  try {
    const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domain}&asin=${asin}&stats=1&offers=20`;
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) throw new Error(`Keepa error: ${r.status}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// SERPAPI - with proper domain mapping (FIXED)
// =====================================================
app.get("/api/serpapi", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });

  const amazon_domain = SERPAPI_DOMAIN_MAP[String(domain)];
  if (!amazon_domain) return res.status(400).json({ error: `Unsupported domain code: ${domain}` });

  if (!SERPAPI_KEY) return res.status(500).json({ error: "SerpApi key not configured" });

  try {
    const url = `https://serpapi.com/search.json?engine=amazon_product&amazon_domain=${amazon_domain}&asin=${asin}&api_key=${SERPAPI_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) throw new Error(`SerpApi error: ${r.status}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// NINJA / RapidAPI Real-Time Amazon Data
// =====================================================
app.get("/api/ninja", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!NINJA_KEY) return res.status(500).json({ error: "Ninja/RapidAPI key not configured" });

  const country = SERPAPI_DOMAIN_MAP[String(domain)]?.replace("amazon.", "").toUpperCase() || "IT";

  try {
    const url = `https://real-time-amazon-data.p.rapidapi.com/product-offers?asin=${asin}&country=${country}&limit=20`;
    const r = await fetch(url, {
      headers: {
        "x-rapidapi-host": "real-time-amazon-data.p.rapidapi.com",
        "x-rapidapi-key": NINJA_KEY
      }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Ninja error: ${r.status}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// BACK MARKET - listings for a single market (default FR)
// =====================================================
app.get("/api/backmarket/listings", async (req, res) => {
  if (!BM_KEY) return res.status(500).json({ error: "BM key not configured" });
  const market = (req.query.market || "FR").toUpperCase();
  const m = BM_MARKETS[market];
  if (!m) return res.status(400).json({ error: `Unsupported market: ${market}` });

  try {
    const url = `https://${m.host}/ws/listings`;
    const r = await fetch(url, {
      headers: {
        "Authorization": `Basic ${BM_KEY}`,
        "Accept": "application/json",
        "Accept-Language": m.locale
      }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`BM error: ${r.status}`);
    res.json({ market, count: Array.isArray(data?.results) ? data.results.length : null, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// BACK MARKET - all 5 markets in parallel
// =====================================================
app.get("/api/backmarket/all", async (req, res) => {
  if (!BM_KEY) return res.status(500).json({ error: "BM key not configured" });

  const markets = Object.keys(BM_MARKETS);
  const results = {};

  await Promise.all(markets.map(async (market) => {
    const m = BM_MARKETS[market];
    try {
      const url = `https://${m.host}/ws/listings`;
      const r = await fetch(url, {
        headers: {
          "Authorization": `Basic ${BM_KEY}`,
          "Accept": "application/json",
          "Accept-Language": m.locale
        }
      });
      const data = await r.json();
      results[market] = {
        ok: r.ok,
        status: r.status,
        count: Array.isArray(data?.results) ? data.results.length : null,
        data
      };
    } catch (err) {
      results[market] = { ok: false, error: err.message };
    }
  }));

  res.json(results);
});

// =====================================================
// BULK PRICE - report massivo
// Body: { items: [{ asin, domain, color, model, storage }], source: "keepa-offers" }
// =====================================================
app.post("/api/bulk-price", async (req, res) => {
  const { items = [], source = "keepa-offers" } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "items array required" });
  }
  if (!KEEPA_KEY) return res.status(500).json({ error: "Keepa API key not configured" });

  const out = [];
  // process in small batches to be gentle with API
  const BATCH = 5;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const batchRes = await Promise.all(slice.map(async (it) => {
      try {
        const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${it.domain}&asin=${it.asin}&stats=1&offers=20`;
        const r = await fetch(url);
        const data = await r.json();
        const p = data?.products?.[0] || {};
        return {
          asin: it.asin,
          domain: it.domain,
          color: it.color,
          model: it.model,
          storage: it.storage,
          buyBoxPrice: p?.stats?.buyBoxPrice ?? null,
          monthlySold: p?.monthlySold ?? null,
          offers: p?.offers || [],
          ok: true
        };
      } catch (err) {
        return { asin: it.asin, domain: it.domain, ok: false, error: err.message };
      }
    }));
    out.push(...batchRes);
  }
  res.json({ count: out.length, results: out });
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    env: {
      keepa: !!KEEPA_KEY,
      serpapi: !!SERPAPI_KEY,
      backmarket: !!BM_KEY,
      ninja: !!NINJA_KEY
    },
    time: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Recover Price Scanner running on port ${PORT}`);
});
