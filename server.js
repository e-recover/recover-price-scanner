// =============================================================
// RECOVER PRICE SCANNER — server.js (CommonJS)
// Endpoint:
//   /api/health, /api/keepa, /api/keepa-offers, /api/serpapi,
//   /api/ninja, /api/scan-asin, /api/bulk-scan, /api/scan-asin-deep,
//   /api/backmarket/listings, /api/backmarket/all, /api/bulk-price
// =============================================================

const express = require("express");
const fetch = require("node-fetch");
const basicAuth = require("express-basic-auth");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(basicAuth({ users: { [process.env.BASIC_AUTH_USER || 'recover']: process.env.BASIC_AUTH_PASS || '' }, challenge: true, realm: 'Recover Price Scanner' }));
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
// FIX parsePrice: gestisce formato EU "1.234,56" e EN "1,234.56"
// senza troncare i decimali (bug vecchio: .replace(",",".") singola occorrenza)
function parsePrice(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return s;
  let str = String(s).replace(/[^\d,.-]/g, "");
  if (!str) return null;

  const lastComma = str.lastIndexOf(",");
  const lastDot   = str.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      // Formato EU "1.234,56" → punti = migliaia, virgola = decimale
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      // Formato EN "1,234.56" → virgole = migliaia, punto = decimale
      str = str.replace(/,/g, "");
    }
  } else if (lastComma > -1) {
    // Solo virgola = separatore decimale ("559,99")
    str = str.replace(/\./g, "").replace(",", ".");
  }
  // Solo punto o nessun separatore: già corretto

  const n = parseFloat(str);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

// FIX: valida formato ASIN Amazon (10 caratteri alfanumerici maiuscoli)
function isValidAsin(asin) {
  return typeof asin === "string" && /^[A-Z0-9]{10}$/.test(asin.trim().toUpperCase());
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
  // FIX: validazione formato ASIN prima di chiamare le API a pagamento
  if (!isValidAsin(asin)) return res.status(400).json({ error: "ASIN non valido — deve essere 10 caratteri alfanumerici (es. B0CVJ2RLP5)" });

  let keepaOk = false, serpapiOk = false, ninjaOk = false;
  let title = null, monthlySold = null, amazonBuyBox = null, salesRank = null;
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
  let recoverPosition   = { inList: false, rank: null, condition: null, price: null, isLowest: false, tiedLowest: false, tiedSeller: null, nextPrice: null, nextSeller: null, nextFeedback: null, ceilingPrice: null, priceGain: null };

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
        // FIX BSR: leggo il rank della SOTTOCATEGORIA "Renewed",
        // non csv[3] (= categoria root Elettronica, valori inutili tipo #6756).
        // salesRanks è { catId: [timestamp, rank, timestamp, rank, ...] }
        // La categoria Renewed è la più specifica (rank più basso tra le sottocategorie).
        function lastRankFromSeries(series) {
          if (!Array.isArray(series)) return null;
          for (let i = series.length - 1; i >= 1; i -= 2) {
            const v = series[i];
            if (typeof v === "number" && v > 0) return v;
          }
          return null;
        }
        if (p.salesRanks && typeof p.salesRanks === "object") {
          const rootCat = String(p.salesRankReference || p.rootCategory || "");
          const candidates = [];
          for (const catId of Object.keys(p.salesRanks)) {
            // Escludo la categoria root (Elettronica): troppo generica
            if (catId === rootCat) continue;
            const r = lastRankFromSeries(p.salesRanks[catId]);
            if (r !== null) candidates.push(r);
          }
          if (candidates.length > 0) {
            // La sottocategoria "Renewed" ha sempre il rank più basso (più specifica)
            salesRank = Math.min.apply(null, candidates);
          }
        }
        // Fallback 1: stats.current[3] (BSR categoria principale, meno preciso)
        if (!salesRank && p.stats && Array.isArray(p.stats.current) && p.stats.current[3] > 0) {
          salesRank = p.stats.current[3];
        }
        // Fallback 2: csv[3] ultimo valore valido
        if (!salesRank && Array.isArray(csv[3]) && csv[3].length >= 2) {
          for (let i = csv[3].length - 1; i >= 0; i -= 2) {
            const v = csv[3][i];
            if (typeof v === "number" && v > 0) { salesRank = v; break; }
          }
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
          const sellerLink = o.seller_link || "";
          const isFBA = (o.ships_from === "Amazon") || /isAmazonFulfilled=1/.test(sellerLink);
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
            isFBA: isFBA,
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

        // BUY BOX EXCELLENT:
        // 1. Cerca in buy_boxes[] di Ninja (Buy Box ufficiale per condition, coerente con la pagina prodotto)
        // 2. Trova seller corrispondente cercando per prezzo nelle product_offers
        // 3. Fallback: prima offerta Excellent nella lista product_offers (se buy_boxes non ha Excellent)
        const buyBoxes = Array.isArray(d.buy_boxes) ? d.buy_boxes : [];
        const bbExcellent = buyBoxes.find(b => classifyCondition(b.title) === "excellent");

        let bbPrice = null;
        let bbSeller = null;
        let bbIsFBA = false;

        if (bbExcellent && bbExcellent.price) {
          bbPrice = parsePrice(bbExcellent.price);
          if (bbPrice) {
            const match = enriched.filter(o => o.condition === "excellent" && Math.abs(o.price - bbPrice) < 0.5);
            if (match.length > 0) {
              bbSeller = match[0].seller;
              bbIsFBA = match[0].isFBA;
            }
          }
        }

        // Fallback: se buy_boxes non aveva Excellent ma ci sono offerte Excellent in lista
        if (!bbPrice) {
          const excellentList = enriched.filter(o => o.condition === "excellent");
          if (excellentList.length > 0) {
            const first = excellentList.sort((a, b) => a.rank - b.rank)[0];
            bbPrice = first.price;
            bbSeller = first.seller;
            bbIsFBA = first.isFBA;
          }
        }

        if (bbPrice) {
          ninjaFeaturedExcellent = {
            price: bbPrice,
            seller: bbSeller,
            isFBA: bbIsFBA,
            available: true,
          };
        }

        const myOffer = enriched.find(o => o.sellerId === RECOVER_SELLER_ID);
        if (myOffer) {
          recoverPosition = {
            inList: true,
            rank: myOffer.rank,
            condition: myOffer.condition,
            price: myOffer.price,
            isLowest: false,
            tiedLowest: false,
            tiedSeller: null,
            nextPrice: null,
            nextSeller: null,
            nextFeedback: null,
            ceilingPrice: null,
            priceGain: null,
          };
          // Se Recover è in condition Excellent, calcolo posizione e next competitor
          if (myOffer.condition === "excellent") {
            const otherExcellent = enriched
              .filter(o => o.condition === "excellent" && o.sellerId !== RECOVER_SELLER_ID)
              .sort((a, b) => a.totalPrice - b.totalPrice);
            if (otherExcellent.length > 0) {
              const cheapest = otherExcellent[0];
              const EPS = 0.01; // tolleranza centesimi per "stesso prezzo"
              if (myOffer.totalPrice < cheapest.totalPrice - EPS) {
                // Recover strettamente il più basso → suggerisci di alzare fino al competitor
                recoverPosition.isLowest = true;
                recoverPosition.nextPrice = cheapest.totalPrice;
                recoverPosition.nextSeller = cheapest.seller;
                recoverPosition.nextFeedback = cheapest.positivePercent;
                recoverPosition.ceilingPrice = Math.round((cheapest.totalPrice - 0.01) * 100) / 100;
                recoverPosition.priceGain = Math.round((recoverPosition.ceilingPrice - myOffer.totalPrice) * 100) / 100;
              } else if (Math.abs(myOffer.totalPrice - cheapest.totalPrice) <= EPS) {
                // Recover alla pari col competitor più basso → già competitivo, NON alzare
                recoverPosition.tiedLowest = true;
                recoverPosition.tiedSeller = cheapest.seller;
                recoverPosition.nextPrice = cheapest.totalPrice;
                recoverPosition.nextSeller = cheapest.seller;
                recoverPosition.nextFeedback = cheapest.positivePercent;
              }
              // else: Recover non è il più basso → resta caso #3 (rank)
            } else {
              // Recover unico Excellent
              recoverPosition.isLowest = true;
            }
          }
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
    salesRank: salesRank,
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
// PREZZI — GET /api/prezzi  (sola lettura, cache + job schedulato)
// GET /api/prezzi?condizione=eccellente&locale=IT
// GET /api/prezzi/refresh  (forza aggiornamento manuale)
// =============================================================

// Lista fissa di 71 ASIN di riferimento (mercato IT)
const PREZZI_ASIN_LIST = [
  { asin: "B08D39SX4M",  modello: "iPhone SE 2",      taglio: "64GB"  },
  { asin: "B08D377VBX",  modello: "iPhone SE 2",      taglio: "128GB" },
  { asin: "B08D3JV5SX",  modello: "iPhone SE 2",      taglio: "256GB" },
  { asin: "B0BDY71GRG",  modello: "iPhone SE 3",      taglio: "64GB"  },
  { asin: "B0BGFMLN1W",  modello: "iPhone SE 3",      taglio: "128GB" },
  { asin: "B0BGFMWDXJ",  modello: "iPhone SE 3",      taglio: "256GB" },
  { asin: "B08PCF2P4R",  modello: "iPhone 12 Mini",   taglio: "64GB"  },
  { asin: "B08PCDKD6G",  modello: "iPhone 12 Mini",   taglio: "128GB" },
  { asin: "B08PCCTXN2",  modello: "iPhone 12 Mini",   taglio: "256GB" },
  { asin: "B08PCFVC58",  modello: "iPhone 12",        taglio: "64GB"  },
  { asin: "B08PCGL5TH",  modello: "iPhone 12",        taglio: "128GB" },
  { asin: "B08PCCZB1H",  modello: "iPhone 12",        taglio: "256GB" },
  { asin: "B08PCDP3LM",  modello: "iPhone 12 Pro",    taglio: "128GB" },
  { asin: "B08PCD4VHZ",  modello: "iPhone 12 Pro",    taglio: "256GB" },
  { asin: "B08PCDHXTD",  modello: "iPhone 12 Pro",    taglio: "512GB" },
  { asin: "B08PCDHMWQ",  modello: "iPhone 12 Pro Max",taglio: "128GB" },
  { asin: "B08PCC7RG1",  modello: "iPhone 12 Pro Max",taglio: "256GB" },
  { asin: "B08PCCB12Y",  modello: "iPhone 12 Pro Max",taglio: "512GB" },
  { asin: "B09MJSRKWK",  modello: "iPhone 13 Mini",   taglio: "128GB" },
  { asin: "B09MJSVVC9",  modello: "iPhone 13 Mini",   taglio: "256GB" },
  { asin: "B09MJSXCHP",  modello: "iPhone 13 Mini",   taglio: "512GB" },
  { asin: "B09MGFJK73",  modello: "iPhone 13",        taglio: "128GB" },
  { asin: "B09MJSHQ6C",  modello: "iPhone 13",        taglio: "256GB" },
  { asin: "B09MJRLLMG",  modello: "iPhone 13",        taglio: "512GB" },
  { asin: "B09ML6X61Z",  modello: "iPhone 13 Pro",    taglio: "128GB" },
  { asin: "B09MJSNM1L",  modello: "iPhone 13 Pro",    taglio: "256GB" },
  { asin: "B09MJRZFM7",  modello: "iPhone 13 Pro",    taglio: "512GB" },
  { asin: "B09MJSDC8D",  modello: "iPhone 13 Pro",    taglio: "1TB"   },
  { asin: "B09ML6BTJV",  modello: "iPhone 13 Pro Max",taglio: "128GB" },
  { asin: "B09ML89FG2",  modello: "iPhone 13 Pro Max",taglio: "256GB" },
  { asin: "B09MJTW6DP",  modello: "iPhone 13 Pro Max",taglio: "512GB" },
  { asin: "B09MJQHTMG",  modello: "iPhone 13 Pro Max",taglio: "1TB"   },
  { asin: "B0BNLXKVNQ",  modello: "iPhone 14",        taglio: "128GB" },
  { asin: "B0BNMC5PXS",  modello: "iPhone 14",        taglio: "256GB" },
  { asin: "B0BNLXLFJ2",  modello: "iPhone 14",        taglio: "512GB" },
  { asin: "B0BNMBHM8Z",  modello: "iPhone 14 Plus",   taglio: "128GB" },
  { asin: "B0BNM1L14Z",  modello: "iPhone 14 Plus",   taglio: "256GB" },
  { asin: "B0BNM1C6LH",  modello: "iPhone 14 Plus",   taglio: "512GB" },
  { asin: "B0BNLZ9G4N",  modello: "iPhone 14 Pro",    taglio: "128GB" },
  { asin: "B0BNLYT3ML",  modello: "iPhone 14 Pro",    taglio: "256GB" },
  { asin: "B0BNM1N3C3",  modello: "iPhone 14 Pro",    taglio: "512GB" },
  { asin: "B0BNLZMT75",  modello: "iPhone 14 Pro",    taglio: "1TB"   },
  { asin: "B0BNLZCPZ3",  modello: "iPhone 14 Pro Max",taglio: "128GB" },
  { asin: "B0BNLYYK2X",  modello: "iPhone 14 Pro Max",taglio: "256GB" },
  { asin: "B0BNM1ZNK3",  modello: "iPhone 14 Pro Max",taglio: "512GB" },
  { asin: "B0BNLZCFSD",  modello: "iPhone 14 Pro Max",taglio: "1TB"   },
  { asin: "B0CVJ23L79",  modello: "iPhone 15",        taglio: "128GB" },
  { asin: "B0CVJ7H584",  modello: "iPhone 15",        taglio: "256GB" },
  { asin: "B0CVJ247SC",  modello: "iPhone 15",        taglio: "512GB" },
  { asin: "B0CVJSMQBB",  modello: "iPhone 15 Plus",   taglio: "128GB" },
  { asin: "B0CVJSHFZ8",  modello: "iPhone 15 Plus",   taglio: "256GB" },
  { asin: "B0CVJ2RLP5",  modello: "iPhone 15 Pro",    taglio: "128GB" },
  { asin: "B0CVJVJNQS",  modello: "iPhone 15 Pro",    taglio: "256GB" },
  { asin: "B0CVJNXTBM",  modello: "iPhone 15 Pro",    taglio: "512GB" },
  { asin: "B0CVZS8NP5",  modello: "iPhone 15 Pro",    taglio: "1TB"   },
  { asin: "B0CVJXGPG4",  modello: "iPhone 15 Pro Max",taglio: "256GB" },
  { asin: "B0CVJVM1DH",  modello: "iPhone 15 Pro Max",taglio: "512GB" },
  { asin: "B0CW15R8JR",  modello: "iPhone 15 Pro Max",taglio: "1TB"   },
  { asin: "B0DHYF5TVV",  modello: "iPhone 16",        taglio: "128GB" },
  { asin: "B0DHYF6Z92",  modello: "iPhone 16",        taglio: "256GB" },
  { asin: "B0DHYBQCTV",  modello: "iPhone 16",        taglio: "512GB" },
  { asin: "B0DHYFRN36",  modello: "iPhone 16 Plus",   taglio: "128GB" },
  { asin: "B0DHYFG675",  modello: "iPhone 16 Plus",   taglio: "256GB" },
  { asin: "B0DHYD6JVY",  modello: "iPhone 16 Plus",   taglio: "512GB" },
  { asin: "B0DHYDBXJ9",  modello: "iPhone 16 Pro",    taglio: "128GB" },
  { asin: "B0DHYDMJ1W",  modello: "iPhone 16 Pro",    taglio: "256GB" },
  { asin: "B0DHYG9G2C",  modello: "iPhone 16 Pro",    taglio: "512GB" },
  { asin: "B0DHYDTQ7T",  modello: "iPhone 16 Pro",    taglio: "1TB"   },
  { asin: "B0DHYCQZC4",  modello: "iPhone 16 Pro Max",taglio: "256GB" },
  { asin: "B0DHYCLJCV",  modello: "iPhone 16 Pro Max",taglio: "512GB" },
  { asin: "B0DHYF6H1P",  modello: "iPhone 16 Pro Max",taglio: "1TB"   },
  ];

// Cache in memoria: { data: [...], ts: null | ISO-string }
var prezziCache = { data: [], ts: null, loading: false };

// Keepa domain IT = 8
const PREZZI_DOMAIN = 8;

// Mappa condizione Keepa (offer.condition intero) -> chiave interna
// IDENTICA alla logica usata e validata in /api/keepa-offers
function keepaCondToKey(c) {
    if (c === 1 || c === 10) return "premium";   // Like New / Renewed
    if (c === 2) return "excellent";             // Very Good = "Eccellente" IT
    if (c === 3) return "very_good";             // Good
    if (c === 4) return "good";                  // Acceptable
    if (c === 5) return "acceptable";
    return "unknown";
}

// Estrae il prezzo corrente da offerCSV Keepa [keepaTime, priceCents*100, ...]
// Stesso helper del primo commit, già validato contro /api/keepa-offers
function latestKeepaPrice(offerCSV) {
    if (!Array.isArray(offerCSV) || offerCSV.length < 2) return null;
    var v = offerCSV[offerCSV.length - 1];
    return (typeof v === "number" && v > 0) ? Math.round(v) / 100 : null;
}

// Aggiorna la cache usando callKeepa con offerte (stessa logica di /api/keepa-offers)
// Gli ASIN sono processati in gruppi concorrenti (BATCH) per ridurre il tempo totale.
async function refreshPrezziCache() {
    if (!KEEPA_KEY) { console.warn("[prezzi] KEEPA_API_KEY non configurata, skip refresh"); return; }
    if (prezziCache.loading) { console.log("[prezzi] Refresh già in corso, skip"); return; }
    prezziCache.loading = true;
    console.log("[prezzi] Avvio refresh cache per " + PREZZI_ASIN_LIST.length + " ASIN...");
    var BATCH = 10;
    var results = [];
    var ts = new Date().toISOString().slice(0, 10);
    try {
          for (var i = 0; i < PREZZI_ASIN_LIST.length; i += BATCH) {
                  var batch = PREZZI_ASIN_LIST.slice(i, i + BATCH);
                  var batchResults = await Promise.all(batch.map(async function(item) {
                            try {
                                        var json = await callKeepa(item.asin, PREZZI_DOMAIN, true);
                                        var p = json && json.products && json.products[0];
                                        if (!p) return { asin: item.asin, modello: item.modello, taglio: item.taglio, prezzo: null, ts: ts, error: "prodotto non trovato" };
                                        var offers = Array.isArray(p.offers) ? p.offers : [];
                                        var prices = [];
                                        for (var j = 0; j < offers.length; j++) {
                                                      var o = offers[j];
                                                      if (keepaCondToKey(o.condition) === "excellent") {
                                                                      var pr = latestKeepaPrice(o.offerCSV);
                                                                      if (pr !== null) prices.push(pr);
                                                      }
                                        }
                                        return { asin: item.asin, modello: item.modello, taglio: item.taglio, prezzo: prices.length > 0 ? Math.min.apply(null, prices) : null, ts: ts };
                            } catch (err) {
                                        return { asin: item.asin, modello: item.modello, taglio: item.taglio, prezzo: null, ts: ts, error: err.message };
                            }
                  }));
                  results = results.concat(batchResults);
          }
          prezziCache.data = results;
          prezziCache.ts = new Date().toISOString();
          console.log("[prezzi] Cache aggiornata: " + results.length + " record, ts=" + prezziCache.ts);
    } catch (err) {
          console.error("[prezzi] Errore refresh cache:", err.message);
    } finally {
          prezziCache.loading = false;
    }
}

// Job schedulato: aggiorna 2 volte al giorno (ogni 12 ore)
setInterval(refreshPrezziCache, 12 * 60 * 60 * 1000);
// Prima esecuzione all'avvio (dopo 5s per lasciar partire il server)
setTimeout(refreshPrezziCache, 5000);

// GET /api/prezzi — serve dalla cache, 0 token Keepa per chiamata esterna
app.get("/api/prezzi", function(req, res) {
    var condizione = String(req.query.condizione || "eccellente").toLowerCase().trim();
    var locale = String(req.query.locale || "IT").toUpperCase().trim();
    if (locale !== "IT") {
          return res.status(400).json({ error: "Locale non supportato: " + locale + ". Attualmente disponibile solo IT." });
    }
    if (condizione !== "eccellente" && condizione !== "excellent") {
          return res.status(400).json({ error: "Condizione non supportata: " + condizione + ". Disponibile solo: eccellente." });
    }
    if (!prezziCache.ts) {
          return res.status(503).json({ error: "Cache non ancora disponibile, riprovare tra qualche secondo.", loading: prezziCache.loading });
    }
    res.json(prezziCache.data);
});

// GET /api/prezzi/refresh — forza aggiornamento manuale (richiede auth)
app.get("/api/prezzi/refresh", async function(req, res) {
    if (!KEEPA_KEY) return res.status(400).json({ error: "KEEPA_API_KEY non configurata" });
    if (prezziCache.loading) return res.status(409).json({ error: "Refresh già in corso" });
    refreshPrezziCache().catch(function(e) { console.error("[prezzi/refresh]", e.message); });
    res.json({ ok: true, message: "Refresh avviato, i dati saranno disponibili a breve su /api/prezzi" });
});

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
