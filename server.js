const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const KEEPA_KEY = process.env.KEEPA_API_KEY;
const BM_KEY = process.env.BM_API_KEY;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ─── KEEPA WITH OFFERS ───────────────────────────────────────────────────────
app.get("/api/keepa-offers", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!KEEPA_KEY) return res.status(500).json({ error: "Keepa API key not configured" });
  try {
    const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domain}&asin=${asin}&stats=1&offers=20&only-live-offers=1`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error(`Keepa API error: ${response.status}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── KEEPA ────────────────────────────────────────────────────────────────────
app.get("/api/keepa", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!KEEPA_KEY) return res.status(500).json({ error: "Keepa API key not configured" });
  try {
    const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domain}&asin=${asin}&stats=1`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error(`Keepa API error: ${response.status}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OPENWEB NINJA ────────────────────────────────────────────────────────────
app.get("/api/ninja", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  const key = "06373c312emshcdbda3da9d2a3b1p16500cjsna8804749f0c5";
  try {
    const url = `https://real-time-amazon-data.p.rapidapi.com/product-offers?asin=${asin}&country=${domain.toUpperCase()}&limit=20&no_cache=true`;
    const response = await fetch(url, {
      headers: {
        "x-rapidapi-key": key,
        "x-rapidapi-host": "real-time-amazon-data.p.rapidapi.com"
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SERPAPI ──────────────────────────────────────────────────────────────────
app.get("/api/serpapi", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  const key = "6863c962f37b3c868d7e178b94e8ea0ab1e87bf9f70854c875ae458eea6584f1";
  try {
    const amazon_domain = `amazon.${domain.toLowerCase()}`;
    const url = `https://serpapi.com/search?engine=amazon_product&asin=${asin}&amazon_domain=${amazon_domain}&api_key=${key}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BULK REPORT ─────────────────────────────────────────────────────────────
app.post("/api/bulk-price", async (req, res) => {
  const { items } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: "No items" });

  const key = "06373c312emshcdbda3da9d2a3b1p16500cjsna8804749f0c5";
  const markets = [
    { id: "IT", country: "IT" },
    { id: "DE", country: "DE" },
    { id: "FR", country: "FR" },
    { id: "ES", country: "ES" },
  ];

  const results = [];

  for (const item of items) {
    const row = { modello: item.modello, prezzo_acquisto: item.prezzo_acquisto, markets: {} };

    for (const mkt of markets) {
      const asinKey = `asin_${mkt.id.toLowerCase()}`;
      const asin = item[asinKey];
      if (!asin) {
        row.markets[mkt.id] = { error: "ASIN mancante" };
        continue;
      }

      try {
        await new Promise(r => setTimeout(r, 300));
        const url = `https://real-time-amazon-data.p.rapidapi.com/product-offers?asin=${asin}&country=${mkt.country}&limit=20`;
        const r2 = await fetch(url, {
          headers: {
            "x-rapidapi-key": key,
            "x-rapidapi-host": "real-time-amazon-data.p.rapidapi.com"
          }
        });
        const data = await r2.json();

        let excellent = null;
        const offers = data?.data?.product_offers || [];
        for (const o of offers) {
          const cond = (o.product_condition || '').toLowerCase();
          if (!cond.includes('excellent')) continue;
          const price = parseFloat((o.product_price || '').replace(/[^\d,\.]/g, '').replace(',', '.'));
          const shipStr = o.delivery_price || '';
          const ship = shipStr.toLowerCase().includes('gratuit') || shipStr.toLowerCase().includes('free') || shipStr.toLowerCase().includes('gratui') ? 0 : parseFloat(shipStr.replace(/[^\d,\.]/g, '').replace(',', '.')) || 0;
          if (!isNaN(price)) {
            const total = price + ship;
            if (!excellent || total < excellent) excellent = total;
          }
        }

        if (excellent && item.prezzo_acquisto) {
          const comm = excellent * 0.073 + 15;
          const iva = (excellent - item.prezzo_acquisto) * 22 / 122;
          const net = excellent - item.prezzo_acquisto - comm - iva;
          row.markets[mkt.id] = { excellent, net: Math.round(net * 100) / 100 };
        } else {
          row.markets[mkt.id] = { excellent: excellent || null, net: null };
        }
      } catch (e) {
        row.markets[mkt.id] = { error: e.message };
      }
    }

    results.push(row);
  }

  res.json(results);
});

// ─── BACK MARKET ─────────────────────────────────────────────────────────────
app.get("/api/backmarket/listings", async (req, res) => {
  if (!BM_KEY) return res.status(500).json({ error: "Back Market API key not configured" });
  try {
    const response = await fetch("https://www.backmarket.fr/ws/listings?page=1", {
      headers: {
        "Authorization": `Basic ${BM_KEY}`,
        "Accept": "application/json",
        "Accept-Language": "fr-fr",
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/backmarket/all", async (req, res) => {
  if (!BM_KEY) return res.status(500).json({ error: "Back Market API key not configured" });
  const countries = [
    { code: "it", host: "https://www.backmarket.it", lang: "it-it" },
    { code: "fr", host: "https://www.backmarket.fr", lang: "fr-fr" },
    { code: "de", host: "https://www.backmarket.de", lang: "de-de" },
    { code: "es", host: "https://www.backmarket.es", lang: "es-es" },
    { code: "nl", host: "https://www.backmarket.nl", lang: "nl-nl" },
  ];
  const results = {};
  for (const c of countries) {
    try {
      let allListings = [];
      let url = `${c.host}/ws/listings?page=1`;
      while (url) {
        const r = await fetch(url, {
          headers: {
            "Authorization": `Basic ${BM_KEY}`,
            "Accept": "application/json",
            "Accept-Language": c.lang,
          }
        });
        const data = await r.json();
        if (!r.ok) break;
        allListings = allListings.concat(data.results || []);
        url = data.next || null;
      }
      results[c.code] = allListings;
    } catch (e) {
      results[c.code] = [];
    }
  }
  res.json(results);
});

app.listen(PORT, () => {
  console.log(`Recover Price Scanner running on port ${PORT}`);
});
