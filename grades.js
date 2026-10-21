// =============================================================
// RECOVER PRICE SCANNER — grades.js
// Modulo "BOX PER GRADO" (nuovo layout Amazon, rilevato 21/10/2026)
//
// Endpoint montati:
//   GET  /api/grades?asin=XXXX&domain=8[&force=1][&deep=1]
//   POST /api/grades-bulk   { items:[{asin,domain}], force?:bool }
//   GET  /api/grades-stats  (contatore chiamate Ninja = crediti consumati)
//
// Fonte UNICA: Ninja (RapidAPI real-time-amazon-data /product-offers).
//   - buy_boxes[]     = un box per grado (identico alla pagina prodotto)
//   - main_buy_box    = box principale, l'unico con seller + seller_id
//   - product_offers  = lista offerte (paginata)
//   - buy_boxes vuoto = layout vecchio (Buy Box unica)
//
// Risparmio crediti:
//   - niente Keepa / SerpApi
//   - cache in memoria per ASIN+mercato (default 30 min, env GRADES_CACHE_MIN)
//   - default: SOLO pagina 1 (come lo scanner attuale). Pagina extra solo se un grado
//     con box non ha offerte in lista (serve per abbinare il venditore del box).
//   - deep=1: lettura completa offerte (minimo certo), più crediti
//   - tetto pagine per ASIN (default 3, env GRADES_MAX_PAGES)
// =============================================================

const RECOVER_SELLER_ID = "A2L7F1YZ0EWD52";
const NINJA_COUNTRY = { 8: "IT", 3: "DE", 4: "FR", 9: "ES" };
const GRADES = ["premium", "excellent", "good", "acceptable"];
const EPS = 0.01;

const CACHE_MIN = parseInt(process.env.GRADES_CACHE_MIN || "30", 10);
const MAX_PAGES = parseInt(process.env.GRADES_MAX_PAGES || "3", 10);
const BULK_CONCURRENCY = 3;

const cache = new Map();
const stats = { ninjaCalls: 0, cacheHits: 0, since: new Date().toISOString() };

// ---------------- helper ----------------
function parsePrice(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return s;
  let str = String(s).replace(/[^\d,.-]/g, "");
  if (!str) return null;
  const lc = str.lastIndexOf(","), ld = str.lastIndexOf(".");
  if (lc > -1 && ld > -1) {
    str = lc > ld ? str.replace(/\./g, "").replace(",", ".") : str.replace(/,/g, "");
  } else if (lc > -1) {
    str = str.replace(/\./g, "").replace(",", ".");
  }
  const n = parseFloat(str);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function parseDeliveryFee(s) {
  if (!s) return 0;
  const l = String(s).toLowerCase().trim();
  if (l === "" || /gratis|free|gratuit|kostenlos|frei/.test(l)) return 0;
  const m = l.match(/(\d+[.,]\d+|\d+)/);
  const n = m ? parsePrice(m[1]) : null;
  return n && n > 0 ? n : 0;
}

function classifyCondition(raw) {
  if (!raw) return "unknown";
  const s = String(raw).toLowerCase();
  if (/premium|like new|come nuovo|comme neuf|como nuevo|wie neu/.test(s)) return "premium";
  if (/excellent|eccellente|excelente|hervorragend|ausgezeichnet/.test(s)) return "excellent";
  if (/very good|molto buono|très bon|muy bueno|sehr gut/.test(s)) return "very_good";
  if (/acceptable|accettabile|aceptable|akzeptabel|correct/.test(s)) return "acceptable";
  if (/good|buono|bueno| gut|- gut|bon/.test(s)) return "good";
  return "unknown";
}

function r2(n) { return n === null || n === undefined ? null : Math.round(n * 100) / 100; }

function normOffer(o) {
  const price = parsePrice(o.product_price !== undefined ? o.product_price : o.price);
  const fee = parseDeliveryFee(o.delivery_price);
  const link = o.seller_link || "";
  return {
    grade: classifyCondition(o.product_condition),
    price: price,
    deliveryFee: fee,
    total: price !== null ? r2(price + fee) : null,
    seller: o.seller || null,
    sellerId: o.seller_id || null,
    isFBA: o.is_fba === true || o.ships_from === "Amazon" || /isAmazonFulfilled=1/.test(link),
    isRecover: o.seller_id === RECOVER_SELLER_ID,
    positivePercent: (function () {
      const m = String(o.seller_star_rating_info || "").match(/(\d{1,3})\s*%/);
      return m ? parseInt(m[1], 10) : null;
    })(),
    deliveryTime: o.delivery_time || null,
  };
}

// ---------------- Ninja ----------------
async function callNinjaPage(fetchFn, key, asin, domain, page) {
  const country = NINJA_COUNTRY[domain] || "IT";
  const url = `https://real-time-amazon-data.p.rapidapi.com/product-offers?asin=${asin}&country=${country}&limit=20&page=${page}`;
  stats.ninjaCalls++;
  const r = await fetchFn(url, {
    headers: { "x-rapidapi-key": key, "x-rapidapi-host": "real-time-amazon-data.p.rapidapi.com" },
  });
  if (!r.ok) throw new Error(`Ninja status ${r.status}`);
  const j = await r.json();
  return (j && j.data) || {};
}

// Solo informativo: la lista offerte Amazon NON è garantita in ordine di prezzo
// (verificato 21/10/2026). Il minimo è certo solo se complete=true.
function isSortedByTotal(offers) {
  const t = offers.slice(1).map(o => o.total).filter(v => v !== null);
  for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1] - EPS) return false;
  return true;
}

// ---------------- analisi per grado ----------------
function analyze(asin, domain, first, offers, meta) {
  const buyBoxesRaw = Array.isArray(first.buy_boxes) ? first.buy_boxes : [];
  const main = first.main_buy_box || null;
  const layout = buyBoxesRaw.length > 0 ? "nuovo" : "vecchio";

  // Box per grado
  const boxes = {};
  const boxList = layout === "nuovo" ? buyBoxesRaw : (main ? [main] : []);
  boxList.forEach(function (b) {
    const g = classifyCondition(b.title);
    if (!GRADES.includes(g) || boxes[g]) return;
    const price = parsePrice(b.price);
    let seller = null, sellerId = null, matchType = "non_trovato", candidates = [];

    if (main && classifyCondition(main.title) === g && Math.abs(parsePrice(main.price) - price) < EPS && main.seller_id) {
      seller = main.seller; sellerId = main.seller_id; matchType = "certo";
    } else {
      candidates = offers.filter(o => o.grade === g && o.price !== null && Math.abs(o.price - price) < EPS);
      if (candidates.length === 1) {
        seller = candidates[0].seller; sellerId = candidates[0].sellerId; matchType = "prezzo";
      } else if (candidates.length > 1) {
        seller = candidates.map(c => c.seller).join(" / "); matchType = "ambiguo";
      }
    }
    const matched = sellerId ? offers.find(o => o.grade === g && o.sellerId === sellerId && Math.abs(o.price - price) < EPS) : null;
    const fee = matched ? matched.deliveryFee : (candidates[0] ? candidates[0].deliveryFee : null);
    boxes[g] = {
      price: price,
      deliveryFee: fee,
      total: fee !== null ? r2(price + fee) : null,
      seller: seller,
      sellerId: sellerId,
      isFBA: b.is_fba === true,
      isRecover: sellerId === RECOVER_SELLER_ID,
      recoverPossibile: matchType === "ambiguo" && candidates.some(c => c.isRecover),
      match: matchType,
    };
  });

  const out = {};
  GRADES.forEach(function (g) {
    const list = offers.filter(o => o.grade === g && o.total !== null).sort((a, b) => a.total - b.total);
    const box = boxes[g] || null;
    let min = list[0] || null;
    // Il minimo non può essere più alto del box: se l'offerta del box non è tra quelle lette,
    // il minimo del grado è almeno il prezzo del box (venditore eventualmente n.d.)
    if (box && (!min || box.price < min.price - EPS)) {
      min = { price: box.price, deliveryFee: box.deliveryFee || 0, total: box.total !== null ? box.total : box.price,
              seller: box.seller, sellerId: box.sellerId, isFBA: box.isFBA, isRecover: box.isRecover, daBox: true };
    }
    const recIdx = list.findIndex(o => o.isRecover);
    const rec = recIdx >= 0 ? list[recIdx] : null;
    const nextComp = rec ? list.find(o => !o.isRecover) || null : null;

    let recover = null;
    if (rec) {
      recover = {
        price: rec.price, total: rec.total, posizione: recIdx + 1, su: list.length,
        gapMin: r2(rec.total - min.total),
        gapBox: box && box.total !== null ? r2(rec.total - box.total) : (box ? r2(rec.price - box.price) : null),
        prossimo: nextComp ? { seller: nextComp.seller, total: nextComp.total, positivePercent: nextComp.positivePercent } : null,
        tetto: nextComp && nextComp.total > rec.total + EPS ? r2(nextComp.total - 0.01) : null,
      };
    }

    // ----- stato -----
    let stato;
    if (!min && !box) stato = "VUOTO";
    else if (box && (box.isRecover)) stato = "RECOVER_BOX";
    else if (rec && rec.total <= min.total + EPS && (!box || rec.total <= (box.total !== null ? box.total : box.price) + EPS)) {
      stato = layout === "vecchio" ? "RECOVER_MIN" : "RECOVER_MIN_SENZA_BOX";
    }
    else if (rec) stato = "RECOVER_SOTTO";
    else if (!box && min) stato = layout === "vecchio" ? "LAYOUT_VECCHIO" : "GRADO_SENZA_BOX";
    else if (box && min && (box.total !== null ? box.total : box.price) > min.total + EPS) stato = "BOX_DIVERSO_DA_MIN";
    else stato = "OK";

    out[g] = {
      stato: stato,
      box: box,
      min: min ? { price: min.price, deliveryFee: min.deliveryFee, total: min.total, seller: min.seller, sellerId: min.sellerId, isFBA: min.isFBA, isRecover: min.isRecover, daBox: !!min.daBox } : null,
      recover: recover,
      offerte: list.length,
    };
  });

  return {
    ok: true,
    asin: asin,
    domain: domain,
    market: NINJA_COUNTRY[domain] || "IT",
    title: first.product_title || null,
    layout: layout,
    offersTotal: first.product_num_offers || null,
    offersFetched: offers.length,
    pagesFetched: meta.pages,
    complete: !first.product_num_offers || offers.length >= first.product_num_offers,
    sorted: meta.sorted,
    recoverInList: offers.some(o => o.isRecover),
    grades: out,
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
}

async function scanGrades(fetchFn, key, asin, domain, opts) {
  opts = opts || {};
  const ck = asin + "|" + domain;
  if (!opts.force) {
    const c = cache.get(ck);
    if (c && Date.now() - c.ts < CACHE_MIN * 60000 && (!opts.deep || c.deep)) {
      stats.cacheHits++;
      return Object.assign({}, c.data, { cached: true });
    }
  }

  const first = await callNinjaPage(fetchFn, key, asin, domain, 1);
  let raw = Array.isArray(first.product_offers) ? first.product_offers.slice() : [];
  const total = first.product_num_offers || raw.length;
  const sorted = isSortedByTotal(raw.map(normOffer));
  let page = 1;

  function needMore() {
    if (raw.length >= total || page >= MAX_PAGES) return false;
    if (opts.deep) return true;
    const offers = raw.map(normOffer);
    const boxes = Array.isArray(first.buy_boxes) ? first.buy_boxes : [];
    const main = first.main_buy_box || {};
    // serve la pagina dopo se il venditore di un box non è tra le offerte lette
    // (box principale escluso: il venditore lo dà già Ninja)
    return boxes.some(b => {
      const g = classifyCondition(b.title);
      if (!GRADES.includes(g)) return false;
      const bp = parsePrice(b.price);
      if (main.seller_id && classifyCondition(main.title) === g && Math.abs(parsePrice(main.price) - bp) < EPS) return false;
      return !offers.some(o => o.grade === g && o.price !== null && Math.abs(o.price - bp) < EPS);
    });
  }

  while (needMore()) {
    page++;
    const d = await callNinjaPage(fetchFn, key, asin, domain, page);
    const more = Array.isArray(d.product_offers) ? d.product_offers : [];
    if (more.length === 0) break;
    const seen = new Set(raw.map(o => [o.seller_id, o.product_condition, o.product_price].join("|")));
    const fresh = more.filter(o => !seen.has([o.seller_id, o.product_condition, o.product_price].join("|")));
    if (fresh.length === 0) break; // la pagina non porta nulla di nuovo: stop, non sprecare chiamate
    raw = raw.concat(fresh);
  }

  const data = analyze(asin, domain, first, raw.map(normOffer), { pages: page, sorted: sorted });
  cache.set(ck, { ts: Date.now(), data: data, deep: !!opts.deep });
  return data;
}

// ---------------- montaggio endpoint ----------------
function mountGrades(app, deps) {
  const fetchFn = deps.fetchWithTimeout
    ? function (u, o) { return deps.fetchWithTimeout(u, o, 25000); }
    : deps.fetch;
  const key = deps.ninjaKey;
  const isValidAsin = a => typeof a === "string" && /^[A-Z0-9]{10}$/.test(a.trim().toUpperCase());

  app.get("/api/grades", async (req, res) => {
    if (!key) return res.status(400).json({ ok: false, error: "Ninja key not configured" });
    const asin = String(req.query.asin || "").trim().toUpperCase();
    const domain = parseInt(req.query.domain || 8, 10);
    if (!isValidAsin(asin)) return res.status(400).json({ ok: false, error: "ASIN non valido" });
    try {
      res.json(await scanGrades(fetchFn, key, asin, domain, { force: req.query.force === "1", deep: req.query.deep === "1" }));
    } catch (e) {
      res.status(500).json({ ok: false, asin: asin, domain: domain, error: e.message });
    }
  });

  app.post("/api/grades-bulk", async (req, res) => {
    if (!key) return res.status(400).json({ ok: false, error: "Ninja key not configured" });
    const items = (req.body && req.body.items) || [];
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok: false, error: "items[] required" });
    if (items.length > 120) return res.status(400).json({ ok: false, error: "max 120 ASIN per richiesta" });
    const force = !!(req.body && req.body.force);
    const deep = !!(req.body && req.body.deep);
    const callsBefore = stats.ninjaCalls;
    const out = new Array(items.length);
    let i = 0;
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        const it = items[idx];
        const asin = String(it.asin || "").trim().toUpperCase();
        const domain = parseInt(it.domain || 8, 10);
        if (!isValidAsin(asin)) { out[idx] = { ok: false, asin: asin, domain: domain, error: "ASIN non valido" }; continue; }
        try { out[idx] = await scanGrades(fetchFn, key, asin, domain, { force: force, deep: deep }); }
        catch (e) { out[idx] = { ok: false, asin: asin, domain: domain, error: e.message }; }
      }
    }
    await Promise.all(Array.from({ length: BULK_CONCURRENCY }, worker));
    res.json({ ok: true, count: out.length, ninjaCalls: stats.ninjaCalls - callsBefore, results: out });
  });

  app.get("/api/grades-stats", (req, res) => {
    res.json(Object.assign({ cacheEntries: cache.size, cacheMin: CACHE_MIN, maxPages: MAX_PAGES }, stats));
  });
}

module.exports = { mountGrades, scanGrades, analyze, normOffer, classifyCondition, parsePrice, _cache: cache, _stats: stats };
