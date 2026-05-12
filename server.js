const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const KEEPA_KEY = process.env.KEEPA_API_KEY;
const BM_KEY = process.env.BM_API_KEY;

app.use(express.static(path.join(__dirname, "public")));

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

// ─── BACK MARKET ─────────────────────────────────────────────────────────────
// Test endpoint - fetch listings to understand data structure
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

// Get BuyBox prices for any product across all countries
app.get("/api/backmarket/price", async (req, res) => {
  const { id } = req.query;
  if (!BM_KEY) return res.status(500).json({ error: "Back Market API key not configured" });

  const countries = [
    { code:"it", host:"https://www.backmarket.it", lang:"it-it" },
    { code:"fr", host:"https://www.backmarket.fr", lang:"fr-fr" },
    { code:"de", host:"https://www.backmarket.de", lang:"de-de" },
    { code:"es", host:"https://www.backmarket.es", lang:"es-es" },
    { code:"nl", host:"https://www.backmarket.nl", lang:"nl-nl" },
    { code:"be", host:"https://www.backmarket.be", lang:"fr-be" },
  ];

  const results = {};

  for (const c of countries) {
    try {
      // Try endpoint with numeric Back Market ID
      const url = `${c.host}/ws/listings/${id}`;
      const r = await fetch(url, {
        headers: {
          "Authorization": `Basic ${BM_KEY}`,
          "Accept": "application/json",
          "Accept-Language": c.lang,
        }
      });
      const data = await r.json();
      results[c.code] = { status: r.status, data };
    } catch(e) {
      results[c.code] = { error: e.message };
    }
  }

  res.json(results);
});

app.listen(PORT, () => {
  console.log(`Recover Price Scanner running on port ${PORT}`);
});
