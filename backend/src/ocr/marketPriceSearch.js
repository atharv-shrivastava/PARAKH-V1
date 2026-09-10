const USER_AGENT = "PARAKH-V1/1.0";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function extractPrices(text) {
  const source = String(text ?? "");
  const values = [];
  const patterns = [
    /(?:mrp|m\.r\.p\.?|maximum retail price)[^₹\d]{0,20}₹\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)/gi,
    /₹\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)/g,
    /(?:rs\.?|inr)[\s:.-]*([0-9]{1,6}(?:\.[0-9]{1,2})?)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 10 && value <= 10000) values.push(value);
    }
  }
  return values;
}

async function searchEngine(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`Web search returned HTTP ${response.status}`);
  return response.text();
}

export async function searchMrpRange({ productName, brandName, netQuantity, unit }) {
  const product = clean(productName);
  const brand = clean(brandName);
  const quantity = [clean(netQuantity), clean(unit)].filter(Boolean).join(" ");
  if (!product && !brand) return { status: "NO_QUERY" };

  const queries = [
    [brand, product, quantity].filter(Boolean).join(" "),
    [product, quantity, "MRP"].filter(Boolean).join(" "),
  ];
  const prices = [];
  const successfulQueries = [];
  for (const query of queries) {
    try {
      prices.push(...extractPrices(await searchEngine(query)));
      successfulQueries.push(query);
    } catch (error) {
      console.warn("[Web MRP]", query, error?.message || error);
    }
  }

  const unique = [...new Set(prices)].sort((a, b) => a - b);
  if (!unique.length) return { status: "NOT_FOUND", queries: successfulQueries };
  return {
    status: "FOUND",
    min: unique[0],
    max: unique[unique.length - 1],
    currency: "INR",
    label: `₹${unique[0]}–₹${unique[unique.length - 1]}`,
    queries: successfulQueries,
    disclaimer: "Indicative web MRP range; not used by the Rules Engine and not a legal MRP determination.",
  };
}
