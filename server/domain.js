const STOP_WORDS = new Set(["il", "lo", "la", "i", "gli", "le", "di", "da", "con", "per", "the", "and"]);

export function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokens(value = "") {
  return normalize(value).split(" ").filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

const SEARCH_ALIASES = new Map([
  ["nat", "naturale"], ["natural", "naturale"], ["natur", "naturale"],
  ["min", "minerale"], ["qual", "qualita"], ["ross", "rossa"],
  ["yoghurt", "yogurt"], ["spag", "spaghetti"],
]);

export function productSearchTokens(value = "") {
  const prepared = String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/(\d)\s*[,.]\s*(\d)/g, "$1 $2")
    .replace(/(\d)\s*[x×]\s*(\d)/g, "$1 x $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return prepared
    .split(" ")
    .filter((token) => token && token !== "x" && !STOP_WORDS.has(token))
    .map((token) => SEARCH_ALIASES.get(token) ?? token);
}

export function editDistance(left = "", right = "") {
  const a = String(left); const b = String(right);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

function tokenScore(queryToken, candidateToken) {
  if (queryToken === candidateToken) return 12;
  if (candidateToken.startsWith(queryToken) && queryToken.length >= 3) return 9;
  if (queryToken.startsWith(candidateToken) && candidateToken.length >= 4) return 7;
  if (/^\d+$/.test(queryToken) || /^\d+$/.test(candidateToken)) return -20;
  const tolerance = queryToken.length >= 8 ? 2 : queryToken.length >= 5 ? 1 : 0;
  return tolerance && editDistance(queryToken, candidateToken) <= tolerance ? 6 : -20;
}

export function productSearchScore(query, product) {
  const queryTokens = productSearchTokens(query);
  if (!queryTokens.length) return 1;
  const candidateTokens = productSearchTokens([
    product.brand, product.productName, product.variant, product.packSize,
    ...(product.aliases ?? []),
  ].filter(Boolean).join(" "));
  let score = 0;
  for (const queryToken of queryTokens) {
    const best = Math.max(...candidateTokens.map((candidate) => tokenScore(queryToken, candidate)));
    if (best < 0) return 0;
    score += best;
  }
  const queryCompact = queryTokens.join("");
  const candidateCompact = candidateTokens.join("");
  if (candidateCompact.includes(queryCompact)) score += 18;
  return score + Math.max(0, 12 - candidateTokens.length);
}

export function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

export function offerSaving(offer) {
  const price = money(offer.price);
  const list = money(offer.listPrice);
  return price !== null && list !== null && list > price ? money(list - price) : 0;
}

export function matchWatchToOffer(watch, offer) {
  if (watch.productId && offer.productId) {
    if (watch.productId !== offer.productId) return { matched: false, reason: "canonical_product_mismatch", confidence: 1 };
    const saving = offerSaving(offer);
    if (saving < Number(watch.minSaving ?? 1)) return { matched: false, reason: "saving_below_threshold", confidence: 1, saving };
    return { matched: true, reason: "canonical_product", confidence: Number(offer.confidence ?? 1), saving };
  }
  const wantedBrand = normalize(watch.brand);
  const offeredBrand = normalize(offer.brand);
  if (!wantedBrand || wantedBrand !== offeredBrand) {
    return { matched: false, reason: "brand_mismatch", confidence: 0 };
  }

  const wanted = tokens(watch.productName);
  const haystack = new Set(tokens(`${offer.productName} ${offer.variant ?? ""}`));
  const missing = wanted.filter((token) => !haystack.has(token));
  if (missing.length) {
    return { matched: false, reason: `missing_product_tokens:${missing.join(",")}`, confidence: 0.4 };
  }

  if (watch.packSize && normalize(watch.packSize) !== normalize(offer.packSize)) {
    return { matched: false, reason: "pack_size_mismatch", confidence: 0.65 };
  }

  const saving = offerSaving(offer);
  if (saving < Number(watch.minSaving ?? 1)) {
    return { matched: false, reason: "saving_below_threshold", confidence: 0.9, saving };
  }

  return {
    matched: true,
    reason: watch.packSize ? "exact_brand_product_and_pack" : "exact_brand_and_product",
    confidence: Number(offer.confidence ?? 1),
    saving,
  };
}

export function parseEuropeanPrice(value) {
  const match = String(value).match(/(\d{1,3}(?:[. ]\d{3})*[,.]\d{2})/);
  if (!match) return null;
  return money(match[1].replace(/[. ]/g, "").replace(",", "."));
}

export function slug(value) {
  return normalize(value).replace(/\s+/g, "-");
}
