const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const KEEPA_KEY = process.env.KEEPA_API_KEY;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/keepa", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) return res.status(400).json({ error: "Missing asin or domain" });
  if (!KEEPA_KEY) return res.status(500).json({ error: "Keepa API key not configured" });

  try {
    // offers=20 returns live offers with individual prices + shipping
    const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domain}&asin=${asin}&stats=1&offers=10&only-live-offers=1`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error(`Keepa API error: ${response.status}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Recover Price Scanner running on port ${PORT}`);
});
