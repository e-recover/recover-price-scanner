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

// Get BuyBox prices for any product by Back Market product UUID
app.get("/api/backmarket/price", async (req, res) => {
  const { product_id, country } = req.query;
  if (!BM_KEY) return res.status(500).json({ error: "Back Market API key not configured" });

  const countryHosts = {
    "fr": "https://www.backmarket.fr",
    "de": "https://www.backmarket.de",
    "it": "https://www.backmarket.it",
    "es": "https://www.backmarket.es",
    "nl": "https://www.backmarket.nl",
    "be": "https://www.backmarket.be",
  };

  const host = countryHosts[country] || "https://www.backmarket.fr";
  const lang = `${country}-${country}`;

  try {
    // Try the product endpoint with UUID
    const url = `${host}/ws/products/${product_id}/prices`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `Basic ${BM_KEY}`,
        "Accept": "application/json",
        "Accept-Language": lang,
      }
    });
    const data = await response.json();
    res.json({ url, status: response.status, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Recover Price Scanner running on port ${PORT}`);
});
