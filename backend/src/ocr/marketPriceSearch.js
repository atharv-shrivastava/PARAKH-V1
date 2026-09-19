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

function extractQuantities(text) {
  const source = String(text ?? "");
  const values = [];
  const pattern = /\b([0-9]{1,6}(?:[.,][0-9]+)?)\s*(kg|g|mg|l|ml|cl|pcs?|pieces?|packs?)\b/gi;
  for (const match of source.matchAll(pattern)) {
    const numericValue = Number(String(match[1]).replace(/,/g, ""));
    const unit = String(match[2] || "").toLowerCase().replace(/pieces?/g, "pcs").replace(/packs?/g, "pack");
    if (Number.isFinite(numericValue) && numericValue > 0 && numericValue <= 10000) {
      values.push({ value: numericValue, unit });
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
  const quantities = [];
  const successfulQueries = [];
  for (const query of queries) {
    try {
      const html = await searchEngine(query);
      prices.push(...extractPrices(html));
      quantities.push(...extractQuantities(html));
      successfulQueries.push(query);
    } catch (error) {
      console.warn("[Web Product Reference]", query, error?.message || error);
    }
  }

  const uniquePrices = [...new Set(prices)].sort((a, b) => a - b);
  const uniqueQuantities = [];
  const seenQuantities = new Set();
  for (const item of quantities) {
    const key = `${item.value} ${item.unit}`;
    if (!seenQuantities.has(key)) {
      seenQuantities.add(key);
      uniqueQuantities.push(item);
    }
  }

  if (!uniquePrices.length && !uniqueQuantities.length) {
    return { status: "NOT_FOUND", queries: successfulQueries };
  }

  return {
    status: "FOUND",
    ...(uniquePrices.length ? {
      min: uniquePrices[0],
      max: uniquePrices[uniquePrices.length - 1],
      currency: "INR",
      label: `₹${uniquePrices[0]}–₹${uniquePrices[uniquePrices.length - 1]}`,
    } : {}),
    netQuantityCandidates: uniqueQuantities.slice(0, 10),
    queries: successfulQueries,
    disclaimer: "Web product data is reference-only. It is never treated as package evidence or used as a legal MRP determination.",
  };
}
