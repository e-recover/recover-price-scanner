// =============================================================
// RECOVER PRICE SCANNER — server.js (CommonJS)
// Endpoint:
//   /api/health, /api/keepa, /api/keepa-offers, /api/serpapi,
//   /api/ninja, /api/scan-asin, /api/bulk-scan, /api/scan-asin-deep,
//   /api/backmarket/listings, /api/backmarket/all, /api/bulk-price
// =============================================================

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// ENV
const KEEPA_KEY    = process.env.KEEPA_API_KEY    || "";
const SERPAPI_KEY  = process.env.SERPAPI_KEY      || "";
const BM_KEY       = process.env.BM_API_KEY || process.env.BM_KEY || "";
const NINJA_KEY    = process.env.NINJA_KEY        || "";

const RECOVER_SELLER_ID = "A2L7F1YZ0EWD52";

// =============================================================
// MAPPING DOMINI — Keepa: 8=IT, 3=DE, 4=FR, 9=ES
// =============================================================
const NINJA_COUNTRY  = { 8: "IT", 3: "DE", 4: "FR", 9: "ES" };
const SERPAPI_DOMAIN = { 8: "amazon.it", 3: "amazon.de", 4: "amazon.fr", 9: "amazon.es" };
const MARKET_CODE    = { 8: "IT", 3: "DE", 4: "FR", 9: "ES" };

// =============================================================
// HELPER — parsing
// =============================================================
function parsePrice(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return s;
  const cleaned = String(s)
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
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

function parseDeliveryFee(s) {
  if (!s) return 0;
  const lower = String(s).toLowerCase().trim();
  // Gratis / Free in IT, DE, FR, ES, EN
  if (lower === "" || lower.includes("gratis") || lower.includes("free") || lower.includes("gratuit") || lower.includes("gratuito") || lower.includes("kostenlos") || lower.includes("frei")) return 0;
  // Estrai numero (es. "por 9,99 €" → 9.99, "4,99 €" → 4.99)
  const m = lower.match(/(\d+[.,]\d+|\d+)/);
  if (m) {
    const n = parsePrice(m[1]);
    return (n !== null && n > 0) ? n : 0;
  }
  return 0;
}
function parseMonthlySoldFromText(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,5})/);
  return m ? parseInt(m[1], 10) : null;
}
function classifyCondition(raw) {
  if (!raw) return "unknown";
  const s = String(raw).toLowerCase();
  if (s.includes("premium") || s.includes("like new") || s.includes("come nuovo") || s.includes("comme neuf") || s.includes("como nuevo") || s.includes("wie neu")) return "premium";
  if (s.includes("excellent") || s.includes("eccellente") || s.includes("excelente") || s.includes("hervorragend") || s.includes("ausgezeichnet")) return "excellent";
  if (s.includes("very good") || s.includes("molto buono") || s.includes("très bon") || s.includes("muy bueno") || s.includes("sehr gut")) return "very_good";
  if (s.includes("acceptable") || s.includes("accettabile") || s.includes("aceptable") || s.includes("akzeptabel") || s.includes("correct")) return "acceptable";
  if (s.includes("good") || s.includes("buono") || s.includes("bueno") || s.includes(" gut") || s.includes("- gut") || s.includes("bon")) return "good";
  return "unknown";
}
function priceFromOffer(o) {
  if (!o) return null;
  const raw = (o.product_price !== undefined && o.product_price !== null) ? o.product_price : o.price;
  return parsePrice(raw);
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  opts = opts || {};
  timeoutMs = timeoutMs || 20000;
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(t);
  }
}

// =============================================================
// KEEPA
// =============================================================
async function callKeepa(asin, domain, offers) {
  const offersParam = offers ? `&offers=20` : "";
  const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domain}&asin=${asin}${offersParam}&stats=30`;
  const r = await fetchWithTimeout(url, {}, 25000);
  if (!r.ok) throw new Error(`Keepa status ${r.status}`);
  return await r.json();
}

app.get("/api/keepa", async (req, res) => {
  if (!KEEPA_KEY) return res.status(400).json({ error: "KEEPA_API_KEY not configured" });
  const asin = req.query.asin, domain = req.query.domain || 8;
  if (!asin) return res.status(400).json({ error: "asin required" });
  try { res.json(await callKeepa(asin, domain, false)); }
  catch (e) { res.status(500).json({ error: `Keepa error: ${e.message}` }); }
});

app.get("/api/keepa-offers", async (req, res) => {
  if (!KEEPA_KEY) return res.status(400).json({ error: "KEEPA_API_KEY not configured" });
  const asin = req.query.asin, domain = req.query.domain || 8;
  if (!asin) return res.status(400).json({ error: "asin required" });
  try { res.json(await callKeepa(asin, domain, true)); }
  catch (e) { res.status(500).json({ error: `Keepa-offers error: ${e.message}` }); }
});

// =============================================================
// SERPAPI
// =============================================================
async function callSerpapi(asin, domain) {
  const amazon_domain = SERPAPI_DOMAIN[domain] || "amazon.it";
  const url = `https://serpapi.com/search.json?engine=amazon_product&amazon_domain=${amazon_domain}&asin=${asin}&api_key=${SERPAPI_KEY}`;
  const r = await fetchWithTimeout(url, {}, 25000);
  if (!r.ok) throw new Error(`SerpApi status ${r.status}`);
  return await r.json();
}

app.get("/api/serpapi", async (req, res) => {
  if (!SERPAPI_KEY) return res.status(400).json({ error: "SERPAPI_KEY not configured" });
  const asin = req.query.asin, domain = req.query.domain || 8;
  if (!asin) return res.status(400).json({ error: "asin required" });
  try { res.json(await callSerpapi(asin, domain)); }
  catch (e) { res.status(500).json({ error: `SerpApi error: ${e.message}` }); }
});

// =============================================================
// NINJA / RapidAPI
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
  const asin = req.query.asin, domain = req.query.domain || 8;
  if (!asin) return res.status(400).json({ error: "asin required" });
  try { res.json(await callNinja(asin, parseInt(domain, 10))); }
  catch (e) { res.status(500).json({ error: `Ninja error: ${e.message}` }); }
});

// =============================================================
// EXTRACT SerpApi purchase_options — supporta percorsi multipli
// =============================================================
function extractSerpapiPurchaseOptions(serpapiData) {
  // SerpApi mette purchase_options alla root del JSON
  const po = (serpapiData && serpapiData.purchase_options)
          || (serpapiData && serpapiData.product_results && serpapiData.product_results.purchase_options)
          || {};
  const out = {};
  const keys = ["refurbished_premium", "refurbished_excellent", "refurbished_good", "refurbished_acceptable"];

  for (const key of keys) {
    const item = po[key];
    // L'item può essere oggetto singolo (caso reale verificato) o array (legacy)
    let entry = null;
    if (Array.isArray(item) && item.length > 0) {
      entry = item[0];
    } else if (item && typeof item === "object") {
      entry = item;
    }

    if (entry) {
      const priceNum = (typeof entry.extracted_price === "number")
        ? entry.extracted_price
        : parsePrice(entry.price);

      // Seller: priorità a shipper_seller (3rd party), poi sold_by (FBA), poi dispatches_from
      let seller = null;
      const f = entry.features || {};
      if (f.shipper_seller && f.shipper_seller.text) {
        seller = f.shipper_seller.text;
      } else if (f.sold_by && f.sold_by.text) {
        seller = f.sold_by.text;
      } else if (f.dispatches_from && f.dispatches_from.text) {
        seller = f.dispatches_from.text;
      } else if (entry.seller || entry.seller_name || entry.merchant) {
        seller = entry.seller || entry.seller_name || entry.merchant;
      }

      out[key] = {
        price: priceNum,
        seller: seller,
        available: !!priceNum,
      };
    } else {
      out[key] = { price: null, seller: null, available: false };
    }
  }
  return out;
}

// =============================================================
// SCAN-ASIN — Keepa + SerpApi (formato per index.html)
// =============================================================
app.get("/api/scan-asin", async (req, res) => {
  const asin = req.query.asin;
  const domain = parseInt(req.query.domain || 8, 10);
  if (!asin) return res.status(400).json({ error: "asin required" });

  let keepaOk = false, serpapiOk = false, ninjaOk = false;
  let title = null, monthlySold = null, amazonBuyBox = null;
  // Featured (SerpApi) — Buy Box ufficiale per condition
  let excellent  = { price: null, seller: null, available: false };
  let good       = { price: null, seller: null, available: false };
  let acceptable = { price: null, seller: null, available: false };
  let premium    = { price: null, seller: null, available: false };
  // MIN reale (Ninja) — più basso TOTALE (prezzo + spedizione) tra tutte le offerte di quella condition
  let excellentMinReal  = { price: null, totalPrice: null, deliveryFee: 0, seller: null, sellerId: null, positivePercent: null, rank: null, count: 0, available: false, apparentMin: null };
  let goodMinReal       = { price: null, totalPrice: null, deliveryFee: 0, seller: null, sellerId: null, positivePercent: null, rank: null, count: 0, available: false, apparentMin: null };
  let acceptableMinReal = { price: null, totalPrice: null, deliveryFee: 0, seller: null, sellerId: null, positivePercent: null, rank: null, count: 0, available: false, apparentMin: null };
  // Featured da Ninja product_offers[0 Excellent] (variabile dedicata per evitare race con SerpApi)
  let ninjaFeaturedExcellent = null;
  let recoverPosition   = { inList: false, rank: null, condition: null, price: null };

  const promises = [];

  // Keepa
  promises.push(
    callKeepa(asin, domain, false).then(json => {
      const p = json && json.products && json.products[0];
      if (p) {
        keepaOk = true;
        title = p.title || null;
        if (typeof p.monthlySold === "number") monthlySold = p.monthlySold;
        const csv = p.csv || [];
        if (Array.isArray(csv[1]) && csv[1].length >= 2) {
          const last = csv[1][csv[1].length - 1];
          if (typeof last === "number" && last > 0) amazonBuyBox = last;
        }
      }
    }).catch(() => { keepaOk = false; })
  );

  // SerpApi (Featured)
  if (SERPAPI_KEY) {
    promises.push(
      callSerpapi(asin, domain).then(data => {
        serpapiOk = true;
        if (!title && data && data.product_results && data.product_results.title) {
          title = data.product_results.title;
        }
        const po = extractSerpapiPurchaseOptions(data);
        excellent  = po.refurbished_excellent;
        good       = po.refurbished_good;
        acceptable = po.refurbished_acceptable;
        premium    = po.refurbished_premium;
      }).catch(() => { serpapiOk = false; })
    );
  }

  // Ninja (MIN reale + Featured Excellent da buy_boxes + posizione Recover)
  if (NINJA_KEY) {
    promises.push(
      callNinja(asin, domain).then(raw => {
        ninjaOk = true;
        const d = (raw && raw.data) || {};
        if (!title && d.product_title) title = d.product_title;
        const offers = Array.isArray(d.product_offers) ? d.product_offers : [];

        const enriched = offers.map(function (o, idx) {
          const p = priceFromOffer(o);
          const df = parseDeliveryFee(o.delivery_price);
          return {
            rank: idx + 1,
            price: p,
            deliveryFee: df,
            totalPrice: p !== null ? Math.round((p + df) * 100) / 100 : null,
            condition: classifyCondition(o.product_condition),
            seller: o.seller || null,
            sellerId: o.seller_id || null,
            sellerRating: parseSellerRating(o.seller_star_rating),
            positivePercent: parsePositivePercent(o.seller_star_rating_info),
            deliveryText: o.delivery_price || null,
          };
        }).filter(function (o) { return o.price !== null; });

        function buildMin(cond) {
          const list = enriched.filter(o => o.condition === cond);
          if (list.length === 0) {
            return { price: null, totalPrice: null, deliveryFee: 0, seller: null, sellerId: null, positivePercent: null, rank: null, count: 0, available: false, apparentMin: null };
          }
          const byTotal = [...list].sort((a, b) => a.totalPrice - b.totalPrice);
          const minByTotal = byTotal[0];
          const byPrice = [...list].sort((a, b) => a.price - b.price);
          const minByPrice = byPrice[0];

          let apparent = null;
          if (minByPrice.sellerId !== minByTotal.sellerId && minByPrice.price < minByTotal.totalPrice) {
            apparent = {
              price: minByPrice.price,
              deliveryFee: minByPrice.deliveryFee,
              totalPrice: minByPrice.totalPrice,
              seller: minByPrice.seller,
              sellerId: minByPrice.sellerId,
              positivePercent: minByPrice.positivePercent,
              rank: minByPrice.rank,
            };
          }

          return {
            price: minByTotal.price,
            totalPrice: minByTotal.totalPrice,
            deliveryFee: minByTotal.deliveryFee,
            seller: minByTotal.seller,
            sellerId: minByTotal.sellerId,
            positivePercent: minByTotal.positivePercent,
            rank: minByTotal.rank,
            count: list.length,
            available: true,
            apparentMin: apparent,
          };
        }

        excellentMinReal  = buildMin("excellent");
        goodMinReal       = buildMin("good");
        acceptableMinReal = buildMin("acceptable");

        // FEATURED EXCELLENT = prima offerta Eccellente nella lista product_offers di Ninja
        // (su Amazon corrisponde all'"Offerta consigliata" / Buy Box Excellent)
        const excellentByRank = enriched
          .filter(o => o.condition === "excellent")
          .sort((a, b) => a.rank - b.rank);
        if (excellentByRank.length > 0) {
          const first = excellentByRank[0];
          ninjaFeaturedExcellent = {
            price: first.price,
            seller: first.seller,
            available: true,
          };
        }

        const myOffer = enriched.find(o => o.sellerId === RECOVER_SELLER_ID);
        if (myOffer) {
          recoverPosition = { inList: true, rank: myOffer.rank, condition: myOffer.condition, price: myOffer.price };
        }

        if (monthlySold === null && d.sales_volume) {
          const n = parseMonthlySoldFromText(d.sales_volume);
          if (n !== null) monthlySold = n;
        }
      }).catch(() => { ninjaOk = false; })
    );
  }

  await Promise.all(promises);

  // MERGE: Ninja Buy Box ha priorità su SerpApi per Featured Excellent (più affidabile)
  if (ninjaFeaturedExcellent && ninjaFeaturedExcellent.available) {
    excellent = ninjaFeaturedExcellent;
  }

  res.json({
    ok: true,
    asin: asin,
    domain: domain,
    market: MARKET_CODE[domain] || "IT",
    title: title,
    monthlySold: monthlySold,
    amazonBuyBox: amazonBuyBox,
    // Featured (SerpApi)
    excellent: excellent,
    good: good,
    acceptable: acceptable,
    premium: premium,
    // MIN reale (Ninja)
    excellentMinReal: excellentMinReal,
    goodMinReal: goodMinReal,
    acceptableMinReal: acceptableMinReal,
    // Recover
    recoverPosition: recoverPosition,
    // Flags
    keepaOk: keepaOk,
    serpapiOk: serpapiOk,
    ninjaOk: ninjaOk,
  });
});

// =============================================================
// BULK-SCAN — versione massiva di scan-asin
// =============================================================
app.post("/api/bulk-scan", async (req, res) => {
  const items = req.body && req.body.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: "items[] required" });

  const out = [];
  const batchSize = 5;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchRes = await Promise.all(batch.map(async function (it) {
      const asin = it.asin;
      const domain = parseInt(it.domain || 8, 10);
      let keepaOk = false, serpapiOk = false;
      let title = null, monthlySold = null;
      let excellent  = { price: null, seller: null, available: false };
      let good       = { price: null, seller: null, available: false };
      let acceptable = { price: null, seller: null, available: false };
      let premium    = { price: null, seller: null, available: false };

      const promises = [];
      promises.push(
        callKeepa(asin, domain, false).then(json => {
          const p = json && json.products && json.products[0];
          if (p) {
            keepaOk = true;
            title = p.title || null;
            if (typeof p.monthlySold === "number") monthlySold = p.monthlySold;
          }
        }).catch(() => { keepaOk = false; })
      );
      if (SERPAPI_KEY) {
        promises.push(
          callSerpapi(asin, domain).then(data => {
            serpapiOk = true;
            const po = extractSerpapiPurchaseOptions(data);
            excellent  = po.refurbished_excellent;
            good       = po.refurbished_good;
            acceptable = po.refurbished_acceptable;
            premium    = po.refurbished_premium;
          }).catch(() => { serpapiOk = false; })
        );
      }

      await Promise.all(promises);
      return {
        asin: asin, domain: domain,
        market: MARKET_CODE[domain] || "IT",
        title: title, monthlySold: monthlySold,
        excellent: excellent, good: good, acceptable: acceptable, premium: premium,
        keepaOk: keepaOk, serpapiOk: serpapiOk,
      };
    }));
    out.push.apply(out, batchRes);
  }

  res.json({ count: out.length, results: out });
});

// =============================================================
// SCAN-ASIN-DEEP — Ninja con MIN reale + seller + posizione Recover
// =============================================================
app.get("/api/scan-asin-deep", async (req, res) => {
  if (!NINJA_KEY) return res.status(400).json({ error: "Ninja key not configured" });
  const asin = req.query.asin, domain = req.query.domain || 8;
  if (!asin) return res.status(400).json({ error: "asin required" });

  try {
    const raw = await callNinja(asin, parseInt(domain, 10));
    const d = (raw && raw.data) || {};
    const offers = Array.isArray(d.product_offers) ? d.product_offers : [];

    const enriched = offers.map(function (o, idx) {
      return {
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
      };
    }).filter(function (o) { return o.price !== null; });

    function groupBy(cond) {
      const list = enriched
        .filter(function (o) { return o.condition === cond; })
        .sort(function (a, b) { return a.price - b.price; });
      return { count: list.length, min: list[0] || null, offers: list };
    }

    const featured = {
      price: parsePrice(d.product_price),
      condition: classifyCondition(d.product_condition),
      rawCondition: d.product_condition || null,
    };

    const salesVolumeText = d.sales_volume || null;
    const monthlySold = parseMonthlySoldFromText(salesVolumeText);
    const recoverOffer = enriched.find(function (o) { return o.sellerId === RECOVER_SELLER_ID; }) || null;

    const excellent = groupBy("excellent");
    const good = groupBy("good");
    const acceptable = groupBy("acceptable");
    const premium = groupBy("premium");

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
      ok: true, asin: asin, domain: parseInt(domain, 10),
      market: NINJA_COUNTRY[domain] || "IT",
      title: d.product_title || null,
      productUrl: d.product_url || null,
      totalOffersInListing: d.product_num_offers || null,
      offersReturned: offers.length,
      salesVolumeText: salesVolumeText,
      monthlySold: monthlySold,
      featured: featured,
      excellent: excellent, good: good, acceptable: acceptable, premium: premium,
      recover: { inList: !!recoverOffer, offer: recoverOffer },
      suggestion: suggestion,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: `scan-asin-deep error: ${e.message}` });
  }
});

// =============================================================
// BACK MARKET
// =============================================================
const BM_HOSTS = {
  fr: "https://www.backmarket.fr",
  de: "https://www.backmarket.de",
  it: "https://www.backmarket.it",
  es: "https://www.backmarket.es",
  nl: "https://www.backmarket.nl",
};

app.get("/api/backmarket/listings", async (req, res) => {
  if (!BM_KEY) return res.status(400).json({ error: "BM key not configured" });
  const market = String(req.query.market || "FR").toLowerCase();
  const host = BM_HOSTS[market] || BM_HOSTS.fr;
  const lang = `${market}-${market}`;
  try {
    const r = await fetchWithTimeout(`${host}/ws/listings`, {
      headers: { Authorization: `Basic ${BM_KEY}`, Accept: "application/json", "Accept-Language": lang },
    }, 25000);
    const data = await r.json();
    res.json({ market: market.toUpperCase(), data: data });
  } catch (e) {
    res.status(500).json({ error: `BM listings error: ${e.message}` });
  }
});

app.get("/api/backmarket/all", async (req, res) => {
  if (!BM_KEY) return res.status(400).json({ error: "BM key not configured" });
  const markets = ["it", "fr", "de", "es", "nl"];
  try {
    const out = {};
    await Promise.all(markets.map(async function (m) {
      try {
        const r = await fetchWithTimeout(`${BM_HOSTS[m]}/ws/listings`, {
          headers: { Authorization: `Basic ${BM_KEY}`, Accept: "application/json", "Accept-Language": `${m}-${m}` },
        }, 25000);
        const data = await r.json();
        out[m] = { data: data };
      } catch (err) {
        out[m] = { error: err.message };
      }
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: `BM all error: ${e.message}` });
  }
});

// =============================================================
// BULK PRICE (legacy)
// =============================================================
app.post("/api/bulk-price", async (req, res) => {
  const items = req.body && req.body.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: "items[] required" });
  const out = [];
  const batchSize = 5;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchRes = await Promise.all(batch.map(async function (it) {
      try {
        const json = await callKeepa(it.asin, it.domain, true);
        const p = json && json.products && json.products[0];
        return { asin: it.asin, domain: it.domain, title: (p && p.title) || null, monthlySold: (p && p.monthlySold) || null, offers: (p && p.offers) || [], ok: true };
      } catch (err) {
        return { asin: it.asin, domain: it.domain, ok: false, error: err.message };
      }
    }));
    out.push.apply(out, batchRes);
  }
  res.json({ count: out.length, results: out });
});

// =============================================================
// HEALTH
// =============================================================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    env: { keepa: !!KEEPA_KEY, serpapi: !!SERPAPI_KEY, backmarket: !!BM_KEY, ninja: !!NINJA_KEY },
    endpoints: [
      "GET /api/health",
      "GET /api/keepa?asin=&domain=",
      "GET /api/keepa-offers?asin=&domain=",
      "GET /api/serpapi?asin=&domain=",
      "GET /api/ninja?asin=&domain=",
      "GET /api/scan-asin?asin=&domain=",
      "POST /api/bulk-scan",
      "GET /api/scan-asin-deep?asin=&domain=",
      "GET /api/backmarket/listings?market=FR",
      "GET /api/backmarket/all",
      "POST /api/bulk-price",
    ],
    time: new Date().toISOString(),
  });
});

app.listen(PORT, function () {
  console.log(`Recover Price Scanner running on port ${PORT}`);
});
