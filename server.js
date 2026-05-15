// =============================================================
// RECOVER PRICE SCANNER — server.js
// Versione con endpoint /api/scan-asin-deep (Ninja + condition parsing)
// =============================================================

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// ENV
const KEEPA_KEY    = process.env.KEEPA_API_KEY    || "";
const SERPAPI_KEY  = process.env.SERPAPI_KEY      || "";
const BM_KEY       = process.env.BM_API_KEY || process.env.BM_KEY || "";
const NINJA_KEY    = process.env.NINJA_KEY        || "";

// Recover seller ID Amazon EU
const RECOVER_SELLER_ID = "A2L7F1YZ0EWD52";

// =============================================================
// MAPPING DOMINI
// =============================================================
// Keepa: 8=IT, 3=DE, 4=FR, 9=ES
// Ninja country code:
const NINJA_COUNTRY = { 8: "IT", 3: "DE", 4: "FR", 9: "ES" };
// SerpApi amazon_domain:
const SERPAPI_DOMAIN = {
  8: "amazon.it",
  3: "amazon.de",
  4: "amazon.fr",
  9: "amazon.es",
};

// =============================================================
// HELPER — parsing prezzi e condition
// =============================================================
function parsePrice(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return s;
  const cleaned = String(s).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function parseSellerRating(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(",", "."));
  return isNaN(n) ? null : n;
}

function parsePositivePercent(info) {
  if (!info) return null;
  const m = String(info).match(/(\d{1,3})\s*%/);
  return m ? parseInt(m[1], 10) : null;
}

function parseMonthlySoldFromText(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,5})/);
  return m ? parseInt(m[1], 10) : null;
}

// Classifica condition multilingua (IT/DE/FR/ES/EN)
function classifyCondition(raw) {
  if (!raw) return "unknown";
  const s = String(raw).toLowerCase();

  // Premium / Like New
  if (s.includes("premium") || s.includes("like new") || s.includes("come nuovo") || s.includes("comme neuf") || s.includes("como nuevo") || s.includes("wie neu")) return "premium";

  // Excellent (top tier post-premium, oppure top tier reale)
  // DE Amazon usa "Sehr gut" come Excellent, IT "Eccellente", FR "Excellent", ES "Excelente"
  if (s.includes("excellent") || s.includes("eccellente") || s.includes("excelente") || s.includes("sehr gut") || s.includes("ausgezeichnet")) return "excellent";

  // Very good (alcune lingue separano)
  if (s.includes("very good") || s.includes("molto buono") || s.includes("très bon") || s.includes("muy bueno")) return "very_good";

  // Acceptable (controlla PRIMA di good, altrimenti "good" matcherebbe in alcuni casi)
  if (s.includes("acceptable") || s.includes("accettabile") || s.includes("aceptable") || s.includes("akzeptabel") || s.includes("correct")) return "acceptable";

  // Good
  if (s.includes("good") || s.includes("buono") || s.includes("bueno") || s.includes(" gut") || s.includes("- gut") || s.includes("bon")) return "good";

  return "unknown";
}

// Estrae prezzo numerico da product_price o product_offers[].product_price
function priceFromOffer(o) {
  if (!o) return null;
  const raw = o.product_price ?? o.price ?? null;
  return parsePrice(raw);
}

// Wrap fetch con timeout
async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

// =============================================================
// KEEPA — standard
// =============================================================
app.get("/api/keepa", async (req, res) => {
  if (!KEEPA_KEY) return res.status(400).json({ error: "KEEPA_API_KEY not configured" });
  const { asin, domain = 8 } = req.query;
  if (!asin) return res.status(400).json({ error: "asin required" });
  try {
    const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domain}&asin=${asin}&stats=30`;
    const r = await fetchWithTimeout(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Keepa error: ${e.message}` });
  }
});

// =============================================================
// KEEPA — offers=20 + condition (Eccellente = code 6)
// =============================================================
app.get("/api/keepa-offers", async (req, res) => {
  if (!KEEPA_KEY) return res.status(400).json({ error: "KEEPA_API_KEY not configured" });
  const { asin, domain = 8 } = req.query;
  if (!asin) return res.status(400).json({ error: "asin required" });
  try {
    const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domain}&asin=${asin}&offers=20&stats=30`;
    const r = await fetchWithTimeout(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Keepa-offers error: ${e.message}` });
  }
});

// =============================================================
// SERPAPI
// =============================================================
app.get("/api/serpapi", async (req, res) => {
  if (!SERPAPI_KEY) return res.status(400).json({ error: "SERPAPI_KEY not configured" });
  const { asin, domain = 8 } = req.query;
  if (!asin) return res.status(400).json({ error: "asin required" });
  const amazon_domain = SERPAPI_DOMAIN[domain] || "amazon.it";
  try {
    const url = `https://serpapi.com/search.json?engine=amazon&amazon_domain=${amazon_domain}&asin=${asin}&api_key=${SERPAPI_KEY}`;
    const r = await fetchWithTimeout(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `SerpApi error: ${e.message}` });
  }
});

// =============================================================
// NINJA / RapidAPI Real-Time Amazon Data — endpoint /product-offers
// =============================================================
async function callNinja(asin, domain) {
  const country = NINJA_COUNTRY[domain] || "IT";
  const url = `https://real-time-amazon-data.p.rapidapi.com/product-offers?asin=${asin}&country=${country}&limit=20&page=1`;
  const r = await fetchWithTimeout(url, {
    headers: {
      "x-rapidapi-key": NINJA_KEY,
      "x-rapidapi-host": "real-time-amazon-data.p.rapidapi.com",
    },
  });
  if (!r.ok) throw new Error(`Ninja status ${r.status}`);
  return await r.json();
}

app.get("/api/ninja", async (req, res) => {
  if (!NINJA_KEY) return res.status(400).json({ error: "Ninja/RapidAPI key not configured" });
  const { asin, domain = 8 } = req.query;
  if (!asin) return res.status(400).json({ error: "asin required" });
  try {
    const data = await callNinja(asin, parseInt(domain, 10));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Ninja error: ${e.message}` });
  }
});

// =============================================================
// /api/scan-asin-deep
// =============================================================
// Usa SOLO Ninja (product-offers). Estrae:
//  - featured (Buy Box principale) con condition esplicita
//  - excellent/good/acceptable/premium: count + MIN + lista offerte
//  - vendite mese (da sales_volume)
//  - posizione Recover nella lista (se presente)
// =============================================================
app.get("/api/scan-asin-deep", async (req, res) => {
  if (!NINJA_KEY) return res.status(400).json({ error: "Ninja key not configured" });
  const { asin, domain = 8 } = req.query;
  if (!asin) return res.status(400).json({ error: "asin required" });

  try {
    const raw = await callNinja(asin, parseInt(domain, 10));
    const d = raw?.data || {};
    const offers = Array.isArray(d.product_offers) ? d.product_offers : [];

    // Classifica ogni offerta
    const enriched = offers.map((o, idx) => ({
      rank: idx + 1,
      price: priceFromOffer(o),
      condition: classifyCondition(o.product_condition),
      rawCondition: o.product_condition || null,
      seller: o.seller || null,
      sellerId: o.seller_id || null,
      sellerRating: parseSellerRating(o.seller_star_rating),
      positivePercent: parsePositivePercent(o.seller_star_rating_info),
      delivery: o.delivery_price || null,
      deliveryTime: o.delivery_time || null,
    })).filter(o => o.price !== null);

    // Helper raggruppa per condition
    const groupBy = (cond) => {
      const list = enriched.filter(o => o.condition === cond).sort((a, b) => a.price - b.price);
      return {
        count: list.length,
        min: list[0] || null,
        offers: list,
      };
    };

    // Featured = quella in product_price del prodotto
    const featuredPriceRaw = d.product_price ?? null;
    const featuredCondition = classifyCondition(d.product_condition);
    const featured = {
      price: parsePrice(featuredPriceRaw),
      condition: featuredCondition,
      rawCondition: d.product_condition || null,
    };

    // Vendite mese
    const salesVolumeText = d.sales_volume || null;
    const monthlySold = parseMonthlySoldFromText(salesVolumeText);

    // Posizione Recover
    const recoverOffer = enriched.find(o => o.sellerId === RECOVER_SELLER_ID) || null;

    // Stato competitivo
    const excellent = groupBy("excellent");
    const good = groupBy("good");
    const acceptable = groupBy("acceptable");
    const premium = groupBy("premium");

    // Suggerimento veloce: se Recover non è in lista, suggerisci prezzo a MIN-1
    let suggestion = null;
    if (excellent.min) {
      if (recoverOffer && recoverOffer.condition === "excellent") {
        if (recoverOffer.price === excellent.min.price) {
          suggestion = { status: "win", note: "Recover è MIN Eccellente" };
        } else {
          suggestion = {
            status: "behind",
            note: `Recover a €${recoverOffer.price}, MIN a €${excellent.min.price} (${excellent.min.seller})`,
            targetPrice: Math.max(0, excellent.min.price - 1),
          };
        }
      } else {
        suggestion = {
          status: "not_listed",
          note: `Recover non in lista. MIN Eccellente €${excellent.min.price} (${excellent.min.seller})`,
          targetPrice: Math.max(0, excellent.min.price - 1),
        };
      }
    } else {
      suggestion = { status: "no_excellent", note: "Nessuna offerta Eccellente attiva" };
    }

    res.json({
      ok: true,
      asin,
      domain: parseInt(domain, 10),
      market: NINJA_COUNTRY[domain] || "IT",
      title: d.product_title || null,
      productUrl: d.product_url || null,
      totalOffersInListing: d.product_num_offers || null,
      offersReturned: offers.length,
      salesVolumeText,
      monthlySold,
      featured,
      excellent,
      good,
      acceptable,
      premium,
      recover: {
        inList: !!recoverOffer,
        offer: recoverOffer,
      },
      suggestion,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: `scan-asin-deep error: ${e.message}` });
  }
});

// =============================================================
// BACK MARKET — listings per singolo mercato
// =============================================================
app.get("/api/backmarket/listings", async (req, res) => {
  if (!BM_KEY) return res.status(400).json({ error: "BM key not configured" });
  const market = (req.query.market || "FR").toLowerCase();
  const hosts = {
    fr: "https://www.backmarket.fr",
    de: "https://www.backmarket.de",
    it: "https://www.backmarket.it",
    es: "https://www.backmarket.es",
    nl: "https://www.backmarket.nl",
  };
  const host = hosts[market] || hosts.fr;
  const lang = `${market}-${market}`;
  try {
    const r = await fetchWithTimeout(`${host}/ws/listings`, {
      headers: {
        Authorization: `Basic ${BM_KEY}`,
        Accept: "application/json",
        "Accept-Language": lang,
      },
    }, 25000);
    const data = await r.json();
    res.json({ market: market.toUpperCase(), data });
  } catch (e) {
    res.status(500).json({ error: `BM listings error: ${e.message}` });
  }
});

// =============================================================
// BACK MARKET — tutti i mercati IT/FR/DE/ES/NL in parallelo
// =============================================================
app.get("/api/backmarket/all", async (req, res) => {
  if (!BM_KEY) return res.status(400).json({ error: "BM key not configured" });
  const markets = ["it", "fr", "de", "es", "nl"];
  const hosts = {
    fr: "https://www.backmarket.fr",
    de: "https://www.backmarket.de",
    it: "https://www.backmarket.it",
    es: "https://www.backmarket.es",
    nl: "https://www.backmarket.nl",
  };
  try {
    const results = await Promise.all(markets.map(async (m) => {
      try {
        const r = await fetchWithTimeout(`${hosts[m]}/ws/listings`, {
          headers: {
            Authorization: `Basic ${BM_KEY}`,
            Accept: "application/json",
            "Accept-Language": `${m}-${m}`,
          },
        }, 25000);
        const data = await r.json();
        return { market: m.toUpperCase(), ok: true, data };
      } catch (err) {
        return { market: m.toUpperCase(), ok: false, error: err.message };
      }
    }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: `BM all error: ${e.message}` });
  }
});

// =============================================================
// BULK PRICE (Report Fornitore) — preservato come è
// =============================================================
app.post("/api/bulk-price", async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: "items[] required" });
  const out = [];
  const batchSize = 5;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchRes = await Promise.all(batch.map(async (it) => {
      try {
        const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${it.domain}&asin=${it.asin}&offers=20&stats=30`;
        const r = await fetchWithTimeout(url);
        const json = await r.json();
        const p = json?.products?.[0];
        return {
          asin: it.asin,
          domain: it.domain,
          title: p?.title || null,
          monthlySold: p?.monthlySold || null,
          offers: p?.offers || [],
          ok: true,
        };
      } catch (err) {
        return { asin: it.asin, domain: it.domain, ok: false, error: err.message };
      }
    }));
    out.push(...batchRes);
  }
  res.json({ count: out.length, results: out });
});

// =============================================================
// HEALTH CHECK
// =============================================================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    env: {
      keepa: !!KEEPA_KEY,
      serpapi: !!SERPAPI_KEY,
      backmarket: !!BM_KEY,
      ninja: !!NINJA_KEY,
    },
    endpoints: [
      "GET /api/health",
      "GET /api/keepa?asin=&domain=",
      "GET /api/keepa-offers?asin=&domain=",
      "GET /api/serpapi?asin=&domain=",
      "GET /api/ninja?asin=&domain=",
      "GET /api/scan-asin-deep?asin=&domain=",
      "GET /api/backmarket/listings?market=FR",
      "GET /api/backmarket/all",
      "POST /api/bulk-price",
    ],
    time: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Recover Price Scanner running on port ${PORT}`);
});
