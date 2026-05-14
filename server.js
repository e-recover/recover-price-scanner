// Mapping Keepa domain (numerico) → SerpApi amazon_domain (TLD)
const SERPAPI_DOMAIN_MAP = {
  "8": "amazon.it",
  "3": "amazon.de",
  "4": "amazon.fr",
  "9": "amazon.es",
  "1": "amazon.com",
  "2": "amazon.co.uk"
};

app.get("/api/serpapi", async (req, res) => {
  const { asin, domain } = req.query;
  if (!asin || !domain) {
    return res.status(400).json({ error: "Missing asin or domain" });
  }

  const amazon_domain = SERPAPI_DOMAIN_MAP[String(domain)];
  if (!amazon_domain) {
    return res.status(400).json({ error: `Unsupported domain code: ${domain}` });
  }

  const SERPAPI_KEY = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
  if (!SERPAPI_KEY) {
    return res.status(500).json({ error: "SerpApi key not configured" });
  }

  try {
    const url = `https://serpapi.com/search.json?engine=amazon_product&amazon_domain=${amazon_domain}&asin=${asin}&api_key=${SERPAPI_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error(`SerpApi error: ${response.status}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
