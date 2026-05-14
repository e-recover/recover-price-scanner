const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV ---
const KEEPA_KEY = process.env.KEEPA_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
const BM_KEY = process.env.BM_API_KEY || process.env.BM_KEY;
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

// --- Mapping Keepa domain -> Country code ---
const DOMAIN_TO_COUNTRY = {
  "8": "IT",
  "3": "DE",
  "4": "FR",
  "9": "ES",
  "1": "US",
  "2": "UK"
};

// --- Mapping Back Market market (TLD + locale) ---
const BM_MARKETS = {
  IT: { host: "www.backmarket.it", locale: "it-it" },
  FR: { host: "www.backmarket.fr", locale: "fr-fr" },
  DE: { host: "www.backmarket.de", locale: "de-de" },
  ES: { host: "www.backmarket.es", locale: "es-es" },
  NL: { host: "www.backmarket.nl", locale: "nl-nl" }
};

// =====================================================
// HELPERS - chiamate base
// =====================================================
async function fetchKeepa(asin, domain) {
  const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domain}&asin=${asin}&stats=1&offers=20`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Keepa error ${r.status}`);
  return r.json();
}

async function fetchSerpApi(asin, domain) {
  const amazon_domain = SERPAPI_DOMAIN_MAP[String(domain)];
  if (!amazon_domain) throw new Error(`Unsupported domain code: ${domain}`);
  const url = `https://serpapi.com/search.json?engine=amazon_product&amazon_domain=${amazon_domain}&asin=${asin}&api_key=${SERPAPI_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`SerpApi error ${r.status}`);
  return r.json();
}

// =====================================================
// HELPER - normalize SerpApi purchase_options
// =====================================================
function parsePurchaseOption(opt) {
  if (!opt) return { price: null, seller: null, available: false };
  return {
    price: opt.extracted_price ?? null,
    seller: opt?.features?.shipper_seller?.text || opt?.features?.sold_by?.text || null,
    available: !!opt.extracted_price,
    stock: opt.stock || null,
    delivery: opt.delivery?.[0] || null
  };
}

// =====================================================
// KEEPA - standard
// =====================================================
app.get("/api/keepa", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!KEEPA_KEY) return res.status(500).json({ error: "Keepa API key not configured" });
  try {
    const data = await fetchKeepa(asin, domain);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// KEEPA OFFERS - with live offers + monthlySold
// =====================================================
app.get("/api/keepa-offers", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!KEEPA_KEY) return res.status(500).json({ error: "Keepa API key not configured" });
  try {
    const data = await fetchKeepa(asin, domain);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// SERPAPI - raw response
// =====================================================
app.get("/api/serpapi", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!SERPAPI_KEY) return res.status(500).json({ error: "SerpApi key not configured" });
  try {
    const data = await fetchSerpApi(asin, domain);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// SCAN ASIN - endpoint combinato Keepa + SerpApi
// =====================================================
app.get("/api/scan-asin", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!KEEPA_KEY || !SERPAPI_KEY) {
    return res.status(500).json({ error: "Missing Keepa or SerpApi key" });
  }

  try {
    const [keepaData, serpData] = await Promise.all([
      fetchKeepa(asin, domain).catch(e => ({ error: e.message })),
      fetchSerpApi(asin, domain).catch(e => ({ error: e.message }))
    ]);

    const keepaProduct = keepaData?.products?.[0] || {};
    const purchase = serpData?.purchase_options || {};
    const productResults = serpData?.product_results || {};

    const excellent = parsePurchaseOption(purchase.refurbished_excellent);
    const good = parsePurchaseOption(purchase.refurbished_good);
    const acceptable = parsePurchaseOption(purchase.refurbished_acceptable);
    const premium = parsePurchaseOption(purchase.refurbished_premium);

    res.json({
      asin,
      domain: Number(domain),
      market: DOMAIN_TO_COUNTRY[String(domain)] || null,
      title: productResults?.title || keepaProduct?.title || null,
      monthlySold: keepaProduct?.monthlySold ?? null,
      amazonBuyBoxCents: keepaProduct?.stats?.buyBoxPrice ?? null,
      amazonBuyBoxEur: keepaProduct?.stats?.buyBoxPrice
        ? Number((keepaProduct.stats.buyBoxPrice / 100).toFixed(2))
        : null,
      pageDisplayedPrice: productResults?.extracted_price ?? null,
      premium,
      excellent,
      good,
      acceptable,
      competitionExcellent: excellent.available ? "presente" : "nessuna",
      keepaOk: !keepaData.error,
      serpapiOk: !serpData.error,
      keepaError: keepaData.error || null,
      serpapiError: serpData.error || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// BULK SCAN - massivo per N ASIN x N domini
// =====================================================
app.post("/api/bulk-scan", async (req, res) => {
  const { items = [] } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "items array required" });
  }
  if (!KEEPA_KEY || !SERPAPI_KEY) {
    return res.status(500).json({ error: "Missing Keepa or SerpApi key" });
  }

  const out = [];
  const BATCH = 3;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const batchRes = await Promise.all(slice.map(async (it) => {
      try {
        const [keepaData, serpData] = await Promise.all([
          fetchKeepa(it.asin, it.domain).catch(e => ({ error: e.message })),
          fetchSerpApi(it.asin, it.domain).catch(e => ({ error: e.message }))
        ]);

        const keepaProduct = keepaData?.products?.[0] || {};
        const purchase = serpData?.purchase_options || {};
        const productResults = serpData?.product_results || {};

        return {
          asin: it.asin,
          domain: Number(it.domain),
          market: DOMAIN_TO_COUNTRY[String(it.domain)] || null,
          color: it.color || null,
          model: it.model || null,
          storage: it.storage || null,
          monthlySold: keepaProduct?.monthlySold ?? null,
          amazonBuyBoxEur: keepaProduct?.stats?.buyBoxPrice
            ? Number((keepaProduct.stats.buyBoxPrice / 100).toFixed(2))
            : null,
          pageDisplayedPrice: productResults?.extracted_price ?? null,
          excellent: parsePurchaseOption(purchase.refurbished_excellent),
          good: parsePurchaseOption(purchase.refurbished_good),
          acceptable: parsePurchaseOption(purchase.refurbished_acceptable),
          keepaOk: !keepaData.error,
          serpapiOk: !serpData.error
        };
      } catch (err) {
        return {
          asin: it.asin,
          domain: it.domain,
          ok: false,
          error: err.message
        };
      }
    }));
    out.push(...batchRes);
  }

  res.json({ count: out.length, results: out });
});

// =====================================================
// NINJA / RapidAPI Real-Time Amazon Data
// =====================================================
app.get("/api/ninja", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!NINJA_KEY) return res.status(500).json({ error: "Ninja/RapidAPI key not configured" });

  const country = DOMAIN_TO_COUNTRY[String(domain)] || "IT";
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
// BACK MARKET - single market
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
// LEGACY BULK PRICE
// =====================================================
app.post("/api/bulk-price", async (req, res) => {
  const { items = [] } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "items array required" });
  }
  if (!KEEPA_KEY) return res.status(500).json({ error: "Keepa API key not configured" });

  const out = [];
  const BATCH = 5;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const batchRes = await Promise.all(slice.map(async (it) => {
      try {
        const data = await fetchKeepa(it.asin, it.domain);
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
    endpoints: [
      "GET /api/health",
      "GET /api/keepa?asin=&domain=",
      "GET /api/keepa-offers?asin=&domain=",
      "GET /api/serpapi?asin=&domain=",
      "GET /api/scan-asin?asin=&domain=",
      "POST /api/bulk-scan",
      "GET /api/ninja?asin=&domain=",
      "GET /api/backmarket/listings?market=FR",
      "GET /api/backmarket/all",
      "POST /api/bulk-price"
    ],
    time: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Recover Price Scanner running on port ${PORT}`);
});
