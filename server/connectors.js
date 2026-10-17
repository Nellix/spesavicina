import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { extractText } from "unpdf";
import { parseEuropeanPrice, slug } from "./domain.js";

function sourceId(retailer, storeId, name, price) {
  return createHash("sha1").update(`${retailer}|${storeId}|${name}|${price}`).digest("hex").slice(0, 18);
}

function demoDate(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export const demoOffers = [
  {
    retailer: "Carrefour",
    storeId: "carrefour-corso-belgio",
    productName: "Acqua minerale naturale Sant'Anna",
    brand: "Sant'Anna",
    variant: "Naturale",
    packSize: "6 × 1,5 L",
    price: 2.49,
    listPrice: 3.99,
    unitPrice: "€0,28/L",
    condition: "Carta PAYBACK",
    validFrom: demoDate(-2),
    validUntil: demoDate(7),
    sourceUrl: "https://www.carrefour.it/volantini.html",
    confidence: 0.96,
    status: "approved",
  },
  {
    retailer: "Esselunga",
    storeId: "esselunga-porta-nuova",
    productName: "Yogurt intero Brimi",
    brand: "Brimi",
    variant: "Bianco",
    packSize: "2 × 125 g",
    price: 1.19,
    listPrice: 1.79,
    unitPrice: "€4,76/kg",
    condition: "Carta Fìdaty",
    validFrom: demoDate(-2),
    validUntil: demoDate(7),
    sourceUrl: "https://www.esselunga.it/it-it/promozioni.html",
    confidence: 0.98,
    status: "approved",
  },
  {
    retailer: "Esselunga",
    storeId: "esselunga-porta-nuova",
    productName: "Pasta di semola Barilla",
    brand: "Barilla",
    variant: "Spaghetti n.5",
    packSize: "500 g",
    price: 0.89,
    listPrice: 1.35,
    unitPrice: "€1,78/kg",
    condition: "",
    validFrom: demoDate(-2),
    validUntil: demoDate(7),
    sourceUrl: "https://www.esselunga.it/it-it/promozioni.html",
    confidence: 0.98,
    status: "approved",
  },
  {
    retailer: "Carrefour",
    storeId: "carrefour-corso-belgio",
    productName: "Caffè Lavazza Qualità Rossa",
    brand: "Lavazza",
    variant: "Qualità Rossa",
    packSize: "2 × 250 g",
    price: 5.49,
    listPrice: 7.79,
    unitPrice: "€10,98/kg",
    condition: "",
    validFrom: demoDate(-2),
    validUntil: demoDate(7),
    sourceUrl: "https://www.carrefour.it/volantini.html",
    confidence: 0.91,
    status: "approved",
  },
];

function collectJsonOffers(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (value.name && value.offers) {
    const rawOffer = Array.isArray(value.offers) ? value.offers[0] : value.offers;
    const price = Number(rawOffer?.price ?? rawOffer?.lowPrice);
    if (Number.isFinite(price)) output.push({ item: value, rawOffer, price });
  }
  for (const child of Object.values(value)) {
    if (typeof child === "object") collectJsonOffers(child, output);
  }
  return output;
}

export function parseEsselungaHtml(html, storeId = "esselunga-porta-nuova", sourceUrl = "") {
  const blocks = [...String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const parsed = [];
  for (const block of blocks) {
    try {
      const json = JSON.parse(block[1]);
      for (const { item, rawOffer, price } of collectJsonOffers(json)) {
        const brand = typeof item.brand === "string" ? item.brand : item.brand?.name ?? "";
        if (!brand) continue;
        parsed.push({
          retailer: "Esselunga",
          storeId,
          productName: item.name,
          brand,
          variant: item.description ?? "",
          packSize: item.size ?? "",
          price,
          listPrice: Number(rawOffer.highPrice) || null,
          unitPrice: "",
          condition: rawOffer.eligibleCustomerType ? "Carta Fìdaty" : "",
          validFrom: rawOffer.validFrom ?? null,
          validUntil: rawOffer.priceValidUntil ?? null,
          sourceUrl,
          confidence: 0.94,
          status: "approved",
        });
      }
    } catch {
      // Invalid analytics blocks are ignored; parser drift is visible in the run log.
    }
  }
  return parsed;
}

const KNOWN_BRANDS = [
  "Sant'Anna", "Grissin Bon", "Esselunga", "Coop", "Coca-Cola", "Mulino Bianco", "Fior di Natura",
  "Brimi", "Barilla", "Lavazza", "Yomo", "Fileni", "Citterio", "Rovagnati", "Parmareggio",
  "Parmalat", "Galbani", "Ichnusa", "Fanta", "Pril", "Bravo", "Berni", "Limmi", "Maruzzella",
  "AIA", "Rio Mare", "Philadelphia", "Vallelata", "Findus", "Mutti", "De Cecco", "Ferrero",
  "Pavesi", "Rovagnati", "Nestlé", "Voiello", "Saclà", "Carapelli", "Riso Gallo", "Morato",
  "Callipo", "Danone", "Arborea", "Tempo", "Sole", "Longo", "Osella", "Galbani", "Bonduelle",
  "Negroni", "Amadori", "Kinder", "Yomo", "Mila", "Buitoni", "Biraghi", "Exquisa", "Jocca",
  "Parmareggio", "Granarolo", "Zuegg", "Novi", "Bauli", "Misura", "Scottex", "Dash", "Finish",
  "Fruittella", "Ballarini",
];

function normalizedText(value = "") {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function inferKnownBrand(title = "") {
  const folded = normalizedText(title).toLocaleLowerCase("it").replace(/[’]/g, "'");
  return KNOWN_BRANDS.find((brand) => {
    const candidate = brand.toLocaleLowerCase("it").replace(/[’]/g, "'").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9à-ÿ])${candidate}($|[^a-z0-9à-ÿ])`, "i").test(folded);
  }) ?? "";
}

function isoDate(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const [year, month, day] = value.map(Number);
    if (year && month && day) return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const match = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : null;
}

function localIsoDate(value, timeZone = "Europe/Rome") {
  if (!value) return null;
  const date = typeof value === "number" ? new Date(value > 100_000_000_000 ? value : value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return isoDate(value);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function packFromTitle(title = "") {
  const matches = [...normalizedText(title).matchAll(/(?:\d+\s*[x×]\s*)?\d+(?:[,.]\d+)?\s*(?:kg|g|ml|cl|litri|litro|l|pz|pezzi)\b/gi)];
  return matches.at(-1)?.[0] ?? "";
}

export function parseEsselungaApi(payload, storeId = "esselunga-porta-nuova", sourceUrl = "") {
  const rows = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.data?.items) ? payload.data.items : [];
  const offers = [];
  for (const item of rows) {
    const productName = normalizedText(item.title ?? item.name);
    if (!productName || /^Parent_/i.test(productName)) continue;
    const price = Number(item.promozioni_prezzoPromo?.[0] ?? item.prezzoPromo ?? item.promoPrice ?? item.prezzo);
    if (!Number.isFinite(price) || price <= 0) continue;
    const regularPrice = Number(item.prezzo ?? item.price);
    const promotionType = normalizedText(item.promozioni_desMeccanica?.[0] ?? item.promotionDescription);
    if (/senza offerta/i.test(promotionType)) continue;
    const brand = inferKnownBrand(productName);
    const productCode = String(item.code ?? item.codice ?? item.id ?? sourceId("esselunga", storeId, productName, price));
    offers.push({
      sourceId: `esselunga-${productCode}`,
      retailer: "Esselunga",
      storeId,
      productName,
      brand: brand || productName.split(/\s+/)[0],
      variant: "",
      packSize: packFromTitle(productName),
      price,
      listPrice: Number.isFinite(regularPrice) && regularPrice > price ? regularPrice : null,
      unitPrice: Number(item.promozioni_prezzoPromoAl?.[0]) > 0 ? `€${Number(item.promozioni_prezzoPromoAl[0]).toFixed(2).replace(".", ",")}/${normalizedText(item.promozioni_misuraPrezzoPromoAl?.[0] ?? "unità")}` : "",
      condition: promotionType || "Check Esselunga promotion conditions",
      validFrom: isoDate(item.promozioni_dataInizioPromoArticolo?.[0] ?? item.promozioni_dataInizio?.[0] ?? item.dataInizio),
      validUntil: isoDate(item.promozioni_dataFinePromoArticolo?.[0] ?? item.promozioni_dataFine?.[0] ?? item.dataFine),
      sourceUrl,
      sourceEvidence: { retailerProductId: productCode, imageUrl: item.imgUrl ?? item.imageUrl ?? item.image ?? "", parser: "esselunga-digital-grid-v1" },
      confidence: brand ? 0.94 : 0.68,
      status: brand ? "approved" : "review",
    });
  }
  return offers.slice(0, 500);
}

export function parseEkomLeaflet(payload, storeId = "ekom", sourceUrl = "") {
  const leaflet = payload?.data?.leaflet ?? payload?.leaflet ?? payload?.data ?? payload;
  const pages = leaflet?.leafletPage ?? leaflet?.leafletPages ?? [];
  const offers = [];
  for (const page of pages) {
    for (const area of page.leafletArea ?? page.leafletAreas ?? []) {
      const metadata = area.metadata?.leafletareatype_ekomproduct ?? area.metadata?.ekomproduct ?? area.metadata;
      if (!metadata || typeof metadata !== "object") continue;
      const productName = normalizedText(metadata.TITLE ?? metadata.title);
      const price = Number(String(metadata.PRICE ?? metadata.price ?? "").replace(",", "."));
      if (!productName || !Number.isFinite(price) || price <= 0) continue;
      const brand = inferKnownBrand(productName);
      const areaId = area.leafletAreaId ?? area.id ?? sourceId("ekom", storeId, productName, price);
      offers.push({
        sourceId: `ekom-${leaflet?.leafletId ?? leaflet?.id ?? "leaflet"}-${areaId}`,
        retailer: "Ekom",
        storeId,
        productName,
        brand: brand || productName.split(/\s+/)[0],
        variant: normalizedText(metadata.SUBTITLE ?? metadata.subtitle),
        packSize: normalizedText(metadata.PIECES ?? metadata.pieces) || packFromTitle(productName),
        price,
        listPrice: null,
        unitPrice: metadata.WEIGHT_PRICE ? `€${String(metadata.WEIGHT_PRICE).replace(".", ",")} prezzo unitario` : "",
        condition: "Official Ekom leaflet",
        validFrom: isoDate(metadata.START_DATE ?? metadata.startDate),
        validUntil: isoDate(metadata.END_DATE ?? metadata.endDate),
        sourceUrl,
        sourceEvidence: { leafletId: leaflet?.leafletId ?? leaflet?.id, leafletAreaId: areaId, imageUrl: metadata.IMAGE?.location ?? metadata.IMAGE ?? "", parser: "ekom-leaflet-api-v1" },
        confidence: brand ? 0.94 : 0.68,
        status: brand ? "approved" : "review",
      });
    }
  }
  return offers.slice(0, 500);
}

export function parseCoopProductDetails(payload, productId, storeId = "coop", sourceUrl = "") {
  const body = String(payload?.result?.body ?? payload?.body ?? "");
  const productName = normalizedText(body.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1]);
  const description = normalizedText(body.match(/<div[^>]+class=['"][^'"]*pb-0[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
  const priceBlock = body.match(/class=['"][^'"]*product-price[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
  const price = parseEuropeanPrice(decodeHtml(priceBlock));
  if (!productName || price === null || price <= 0) return null;
  const brand = inferKnownBrand(`${productName} ${description}`) || productName.split(/\s+/)[0];
  const imageUrl = body.match(/<img[^>]+src=['"]([^'"]+(?:promo|screenshot)[^'"]+)['"]/i)?.[1]?.replace(/\\\//g, "/") ?? "";
  return {
    sourceId: `coop-${productId}`,
    retailer: "Coop",
    storeId,
    productName,
    brand,
    variant: description,
    packSize: packFromTitle(`${productName} ${description}`),
    price,
    listPrice: null,
    unitPrice: "",
    condition: "Official Coop flyer",
    validFrom: null,
    validUntil: null,
    sourceUrl,
    sourceEvidence: { flyerProductId: String(productId), imageUrl, parser: "coop-volantinopiu-v1" },
    confidence: 0.92,
    status: "approved",
  };
}

export function parseLidlHtml(html, storeId = "lidl", sourceUrl = "https://www.lidl.it/c/c1150", regionId = "41000") {
  const offers = [];
  const attributes = [...String(html).matchAll(/data-grid-data=["']([^"']+)["']/gi)];
  for (const attribute of attributes) {
    let item;
    try { item = JSON.parse(decodeHtml(attribute[1])); } catch { continue; }
    if (item.productType !== "RETAIL" || !item.havingPrice) continue;
    const region = item.regionsV2?.[String(regionId)];
    const regionPrice = region ? item.regionsPrices?.[String(region.regionPriceId)] : null;
    const publicPrice = regionPrice?.currentPrice ?? item.price;
    const plusPrice = regionPrice?.currentLidlPlusPrice?.price ?? item.lidlPlus?.[0]?.price;
    const priceData = Number.isFinite(Number(publicPrice?.price)) ? publicPrice : plusPrice;
    const price = Number(priceData?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const productName = normalizedText(item.fullTitle ?? item.title);
    const productId = String(item.productId ?? item.itemId ?? item.erpNumber ?? "");
    if (!productName || !productId) continue;
    const explicitBrand = normalizedText(item.brand?.name ?? item.brandName ?? "");
    const inferredBrand = inferKnownBrand(productName);
    const brand = explicitBrand || inferredBrand || "Lidl";
    const listPrice = Number(priceData.discount?.deletedPrice ?? priceData.oldPrice);
    const lidlPlusOnly = priceData === plusPrice && !Number.isFinite(Number(publicPrice?.price));
    const canonicalUrl = new URL(item.canonicalUrl ?? item.canonicalPath ?? `/p/p${productId}`, sourceUrl).href;
    const validFrom = localIsoDate(item.storeStartDate ?? priceData.startDate, item.timezoneId ?? "Europe/Rome");
    const validUntil = localIsoDate(item.storeEndDate ?? priceData.endDate, item.timezoneId ?? "Europe/Rome");
    if (validFrom && validFrom > localIsoDate(new Date(), item.timezoneId ?? "Europe/Rome")) continue;
    offers.push({
      sourceId: `lidl-${productId}-${validFrom ?? "current"}`,
      retailer: "Lidl",
      storeId,
      productName,
      brand,
      variant: "",
      packSize: normalizedText(priceData.packaging?.text) || packFromTitle(productName),
      price,
      listPrice: Number.isFinite(listPrice) && listPrice > price ? listPrice : null,
      unitPrice: normalizedText(priceData.basePrice?.text),
      condition: lidlPlusOnly ? "Lidl Plus required" : "Official Lidl in-store offer",
      validFrom,
      validUntil,
      sourceUrl: canonicalUrl,
      identifiers: [{ scheme: "retailer_sku", retailer: "Lidl", value: productId }],
      sourceEvidence: {
        retailerProductId: productId,
        imageUrl: item.image ?? item.image_V1?.image ?? item.imageList?.[0] ?? "",
        parser: "lidl-product-grid-v1",
        regionId: String(regionId),
        regionName: region?.regionName ?? null,
        lidlPlusOnly,
      },
      confidence: explicitBrand || inferredBrand ? 0.96 : 0.9,
      status: "approved",
    });
  }
  return offers.slice(0, 500);
}

export function parseCarrefourText(text, storeId = "carrefour-corso-belgio", sourceUrl = "") {
  const lines = String(text).split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const offers = [];
  for (let index = 1; index < lines.length; index += 1) {
    const price = parseEuropeanPrice(lines[index]);
    if (price === null || price > 100) continue;
    const name = lines[index - 1].replace(/€.*$/, "").trim();
    if (name.length < 4 || /^(dal|al|offerta|prezzo|cad)$/i.test(name)) continue;
    const brandGuess = name.split(" ").find((token) => /^[A-ZÀ-Ý][A-Za-zÀ-ÿ'’-]{2,}$/.test(token)) ?? name.split(" ")[0];
    offers.push({
      retailer: "Carrefour",
      storeId,
      productName: name,
      brand: brandGuess,
      variant: "",
      packSize: "",
      price,
      listPrice: null,
      unitPrice: "",
      condition: "Check flyer conditions",
      validFrom: null,
      validUntil: null,
      sourceUrl,
      confidence: 0.62,
      status: "review",
    });
  }
  return offers.slice(0, 500);
}

const FLYER_RETAILERS = {
  ins: "IN'S",
  conad: "Conad",
  md: "MD",
  pam: "Pam",
  borello: "Borello",
  crai: "Crai",
  mercato: "Mercatò",
};

function decodeAttribute(value = "") {
  return String(value)
    .replace(/\\\//g, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&");
}

function compactDate(value) {
  const match = String(value ?? "").match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : localIsoDate(value, "Europe/Rome");
}

export function discoverOfficialFlyer(html, retailer, pageUrl = "") {
  const key = String(retailer).toLowerCase();
  const source = decodeAttribute(html);
  if (key === "conad") {
    const encoded = String(html).match(/data-flyers="([\s\S]*?)"/i)?.[1];
    if (encoded) {
      try {
        const flyers = JSON.parse(decodeAttribute(encoded));
        const flyer = flyers.find((item) => item.valid && item.mainFlyer && item.pdfUrl)
          ?? flyers.find((item) => item.valid && item.pdfUrl)
          ?? flyers.find((item) => item.pdfUrl);
        if (flyer) return { pdfUrl: flyer.pdfUrl, validFrom: localIsoDate(flyer.validFrom), validUntil: localIsoDate(flyer.validTo), title: flyer.title ?? "" };
      } catch { /* A changed Conad payload is reported as no_current_flyer. */ }
    }
  }
  if (key === "mercato") {
    const block = source.match(/"flyers":\s*\[(\{[\s\S]*?\})\]/i)?.[1];
    if (block) {
      try {
        const flyer = JSON.parse(block);
        return { pdfUrl: flyer.linkFlyer ?? flyer.linkDigitalFlyer, imageUrl: flyer.linkImageFlyer ?? "", validFrom: compactDate(flyer.startDate), validUntil: compactDate(flyer.endDate), title: flyer.title ?? "" };
      } catch { /* Fall through to generic PDF discovery. */ }
    }
  }
  if (key === "ins") {
    const root = source.match(/data-default-url="([^"]+)"/i)?.[1];
    const active = source.match(/data-current-flyer="([12])"/i)?.[1] ?? "1";
    const edition = source.match(new RegExp(`data-edition-${active === "1" ? "one" : "two"}="([^"]+)"`, "i"))?.[1];
    const codeField = active === "1" ? "one" : "two";
    const torino = [...source.matchAll(new RegExp(`<span class="store-option"[\\s\\S]*?data-location="([^"]*Torino[^"]*)"[\\s\\S]*?data-code-${codeField}="([^"]+)"[\\s\\S]*?<\\/span>`, "gi"))][0];
    if (root && edition && torino?.[2]) return { pdfUrl: `${root}/${edition}/pdf/volantino-${torino[2]}.pdf`, validFrom: null, validUntil: null, title: "Volantino IN'S Torino" };
  }
  if (key === "crai") {
    const path = source.match(/"volantinis"[\s\S]*?"file"[\s\S]*?"url"\s*:\s*"(\/uploads\/[^"?]+\.pdf)"/i)?.[1];
    if (path) return { pdfUrl: new URL(path, "https://strapi.crai.it").href, validFrom: null, validUntil: null, title: source.match(/"volantinis"[\s\S]*?"titolo"\s*:\s*"([^"]+)"/i)?.[1] ?? "CRAI flyer" };
  }
  const directPatterns = key === "borello"
    ? [/(?:"source"|href)\s*[:=]\s*["'](https?:[^"']+\.pdf[^"']*)/i]
    : [/(https?:[^"'<>\s]+\.pdf(?:\?[^"'<>\s]*)?)/i];
  for (const pattern of directPatterns) {
    const found = source.match(pattern)?.[1];
    if (found && !/whistleblowing|accessibilit|company.profile/i.test(found)) return { pdfUrl: found, validFrom: null, validUntil: null, title: `${FLYER_RETAILERS[key] ?? retailer} flyer` };
  }
  if (/\.pdf(?:$|\?)/i.test(pageUrl)) return { pdfUrl: pageUrl, validFrom: null, validUntil: null, title: `${FLYER_RETAILERS[key] ?? retailer} flyer` };
  return null;
}

export function parseOfficialFlyerText(text, retailer, storeId, sourceUrl = "", validity = {}) {
  const key = String(retailer).toLowerCase();
  const retailerName = FLYER_RETAILERS[key] ?? retailer;
  const lines = String(text).split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const offers = [];
  const seen = new Set();
  const noise = /^(?:€|euro|offerta|offerte|prezzo|sconto|cad\.?|al pezzo|volantino|dal |fino al |[\d.,%\s-]+)$/i;
  const metadata = /^(?:bis|\d+\s*(?:pezzi|conf\.)|1\s*(?:pezzo|conf\.)|all['’]etto|al (?:kg|l|lt|pezzo)|pagina\s*\d+|€?\/(?:kg|l|lt)|vari tipi|reparto |conf\. |\d+(?:[,.]\d+)?\s*(?:g|kg|ml|cl|l|lt|pezzi)\b)/i;
  const candidateWindow = (from, direction) => {
    const selected = [];
    for (let offset = 1; offset <= 7; offset += 1) {
      const candidate = lines[from + direction * offset];
      if (!candidate || /(?:€\s*)?\d{1,2}[,.]\d{2}(?!\d)(?:\s*€)?/.test(candidate)) break;
      if (noise.test(candidate) || metadata.test(candidate)) continue;
      direction < 0 ? selected.unshift(candidate) : selected.push(candidate);
    }
    return normalizedText(selected.join(" "));
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/€?\s*\/(?:kg|l|lt|etto)\b|\bal\s+(?:kg|l|lt|etto)\b/i.test(line)) continue;
    const priceMatches = [...line.matchAll(/(?:€\s*)?(\d{1,2}[,.]\d{2})(?!\d)(?:\s*€)?/g)];
    for (const priceMatch of priceMatches) {
      const price = parseEuropeanPrice(priceMatch[1]);
      if (price === null || price <= 0 || price > 100) continue;
      const direct = normalizedText(line.slice(0, priceMatch.index).replace(/[-–•|]+$/g, ""));
      const backward = candidateWindow(index, -1);
      const forward = candidateWindow(index, 1);
      const candidates = /^\s*€?\s*\d/i.test(line) ? [direct, forward, backward] : [direct, backward, forward];
      let productName = candidates.find((value) => value.length >= 4 && inferKnownBrand(value))
        ?? candidates.find((value) => value.length >= 4 && !noise.test(value))
        ?? "";
      if (productName.length < 4 || productName.length > 140 || noise.test(productName)) continue;
      productName = productName.replace(/^(?:(?:SCONTO\s+\d+%|OFFERTA|SEMPRE PIÙ BUONI!|BUONO SPESA\s*\d+€)\s*)+/i, "").trim();
      const brand = inferKnownBrand(productName);
      if (!brand) continue;
      const dedupe = `${productName.toLocaleLowerCase("it")}|${price}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      offers.push({
        sourceId: `${key}-${sourceId(key, storeId, productName, price)}`,
        retailer: retailerName,
        storeId,
        productName,
        brand,
        variant: "",
        packSize: packFromTitle(productName),
        price,
        listPrice: null,
        unitPrice: "",
        condition: "Check official flyer conditions",
        validFrom: validity.validFrom ?? null,
        validUntil: validity.validUntil ?? null,
        sourceUrl,
        sourceEvidence: { parser: "official-flyer-text-v1", flyerTitle: validity.title ?? null },
        confidence: 0.82,
        status: "approved",
      });
    }
  }
  const best = new Map();
  for (const offer of offers) {
    const keyName = offer.productName.toLocaleLowerCase("it");
    if (!best.has(keyName) || best.get(keyName).price > offer.price) best.set(keyName, offer);
  }
  return [...best.values()].slice(0, 500);
}

function decodeHtml(value = "") {
  return String(value)
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/&euro;|&#8364;/g, "€").replace(/&agrave;/g, "à").replace(/&egrave;/g, "è")
    .replace(/&igrave;/g, "ì").replace(/&ograve;/g, "ò").replace(/&ugrave;/g, "ù")
    .replace(/&rsquo;|&lsquo;/g, "’").replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim();
}

function flyerDates(html, now = new Date()) {
  const match = decodeHtml(html).match(/(?:Validità promozioni )?dal\s+(\d{1,2})\/(\d{1,2})\s+al\s+(\d{1,2})\/(\d{1,2})/i);
  if (!match) return { validFrom: null, validUntil: null };
  const year = now.getUTCFullYear();
  const start = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[1])));
  let endYear = year;
  if (Number(match[4]) < Number(match[2])) endYear += 1;
  const end = new Date(Date.UTC(endYear, Number(match[4]) - 1, Number(match[3])));
  return { validFrom: start.toISOString().slice(0, 10), validUntil: end.toISOString().slice(0, 10) };
}

export function parseCarrefourHtml(html, storeId = "carrefour-corso-belgio", sourceUrl = "", now = new Date()) {
  const chunks = String(html).split(/<div\s+class="product tile flyer-tile/i).slice(1);
  const dates = flyerDates(html, now);
  const offers = [];
  for (const chunk of chunks) {
    const id = chunk.match(/data-pid="([^"]+)"/i)?.[1];
    const encoded = chunk.match(/data-product-json="([^"]+)"/i)?.[1];
    if (!id || !encoded) continue;
    let product;
    try { product = JSON.parse(decodeHtml(encoded)); } catch { continue; }
    const original = parseEuropeanPrice(decodeHtml(chunk.match(/d-prices__original[\s\S]*?<\/p>/i)?.[0] ?? ""));
    const finalPrice = parseEuropeanPrice(decodeHtml(chunk.match(/d-prices__final[\s\S]*?<\/p>/i)?.[0] ?? ""));
    if (finalPrice === null) continue;
    const name = decodeHtml(product.name);
    const packMatches = [...name.matchAll(/(?:\d+\s*[x×]\s*)?\d+(?:[,.]\d+)?\s*(?:kg|g|ml|l)\b/gi)];
    const brand = decodeHtml(product.brand ?? "");
    const unitPrice = decodeHtml(chunk.match(/d-prices__partial[^>]*>[\s\S]*?<\/span>/i)?.[0] ?? "");
    const condition = /SPESAMICA/i.test(chunk) ? "SpesAmica PAYBACK" : /PUNTI SPRINT/i.test(chunk) ? "Punti Sprint" : "";
    const imageUrl = decodeHtml(chunk.match(/<img(?=[^>]*\btile-image\b)[^>]*\bdata-src=["']([^"']+)["']/i)?.[1] ?? "");
    offers.push({
      sourceId: id, retailer: "Carrefour", storeId, productName: name,
      brand: brand || name.split(/\s+/)[0], variant: "", packSize: packMatches.at(-1)?.[0] ?? "",
      price: finalPrice, listPrice: original && original > finalPrice ? original : null,
      unitPrice, condition, ...dates, sourceUrl,
      sourceEvidence: { retailerProductId: id, imageUrl, parser: "carrefour-html-v1" },
      confidence: brand ? 0.94 : 0.68, status: brand ? "approved" : "review",
    });
  }
  return offers.slice(0, 500);
}

async function pdfToText(buffer) {
  try {
    return await new Promise((resolve, reject) => {
    const process = spawn("pdftotext", ["-layout", "-", "-"]);
    const chunks = [];
    const errors = [];
    process.stdout.on("data", (chunk) => chunks.push(chunk));
    process.stderr.on("data", (chunk) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error(Buffer.concat(errors).toString("utf8"))));
    process.stdin.end(buffer);
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const extracted = await extractText(new Uint8Array(buffer), { mergePages: true });
    return extracted.text;
  }
}

async function ocrPdf(buffer, env = process.env) {
  if (!env.OCR_URL) return null;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${env.OCR_URL.replace(/\/$/, "")}/ocr`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SERVICE_TOKEN ?? "development-only"}`,
        "content-type": "application/pdf",
      },
      body: buffer,
      signal: AbortSignal.timeout(Number(env.OCR_REQUEST_TIMEOUT_MS ?? 300_000)),
    });
    if (response.status === 429) {
      lastError = new Error("OCR worker is busy");
      await new Promise((resolve) => setTimeout(resolve, Math.min(Number(response.headers.get("retry-after") ?? 15), 30) * 1000));
      continue;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`OCR worker failed: ${result.error ?? response.status}`);
    return result;
  }
  throw lastError ?? new Error("OCR worker did not accept the flyer");
}

function reviewOcrOffers(offers, ocr) {
  return offers.filter((offer) => {
    const name = normalizedText(offer.productName);
    const words = name.split(/\s+/).filter(Boolean);
    const brandIndex = name.toLocaleLowerCase("it").indexOf(String(offer.brand).toLocaleLowerCase("it"));
    return name.length >= 5 && name.length <= 90 && words.length >= 2 && words.length <= 14
      && brandIndex >= 0 && brandIndex <= 60
      && !/\b(?:misura|capacità|ideale per|microonde|frigorifero|stampa digitale|soggetti assortiti)\b/i.test(name)
      && !/[.!?].*[.!?]/.test(name);
  }).map((offer) => ({
    ...offer,
    confidence: Math.min(0.7, Number(ocr.confidence) || 0.55),
    status: "review",
    sourceEvidence: {
      ...offer.sourceEvidence,
      parser: "official-flyer-ocr-v1",
      ocrEngine: ocr.engine,
      ocrConfidence: ocr.confidence,
      ocrChecksum: ocr.checksum,
      ocrPages: ocr.pages,
    },
  }));
}

function ocrOfferText(text = "") {
  return String(text).replace(/\b(\d{1,2}):(\d{2})\b/g, "$1,$2");
}

export async function fetchLiveOffers(env = process.env) {
  const results = [];
  const diagnostics = [];

  if (env.LIDL_OFFERS_URL) {
    const response = await fetch(env.LIDL_OFFERS_URL, { headers: { "user-agent": "SpesaVicina/1.0 (+local grocery offer pilot)" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Lidl offers page returned ${response.status}`);
    const offers = parseLidlHtml(await response.text(), env.LIDL_STORE_ID ?? "lidl", env.LIDL_OFFERS_URL, env.LIDL_REGION_ID ?? "41000");
    results.push(...offers);
    diagnostics.push({ retailer: "Lidl", count: offers.length, sourceUrl: env.LIDL_OFFERS_URL, regionId: env.LIDL_REGION_ID ?? "41000", parser: "product-grid" });
  }

  if (env.FLYER_RETAILER && env.FLYER_SOURCE_URL) {
    const key = String(env.FLYER_RETAILER).toLowerCase();
    const pageResponse = await fetch(env.FLYER_SOURCE_URL, { headers: { "user-agent": "SpesaVicina/1.0 (+local grocery offer pilot)" }, signal: AbortSignal.timeout(30_000) });
    if (!pageResponse.ok) throw new Error(`${FLYER_RETAILERS[key] ?? key} flyer page returned ${pageResponse.status}`);
    const contentType = pageResponse.headers.get("content-type") ?? "";
    let flyer;
    let pdfResponse = pageResponse;
    if (/pdf/i.test(contentType) || /\.pdf(?:$|\?)/i.test(env.FLYER_SOURCE_URL)) {
      flyer = { pdfUrl: env.FLYER_SOURCE_URL, validFrom: env.FLYER_VALID_FROM ?? null, validUntil: env.FLYER_VALID_UNTIL ?? null, title: "" };
    } else {
      flyer = discoverOfficialFlyer(await pageResponse.text(), key, env.FLYER_SOURCE_URL);
      if (!flyer?.pdfUrl) {
        diagnostics.push({ retailer: FLYER_RETAILERS[key] ?? key, count: 0, status: "no_current_flyer", sourceUrl: env.FLYER_SOURCE_URL });
        return { offers: results, diagnostics };
      }
      pdfResponse = await fetch(flyer.pdfUrl, { headers: { "user-agent": "SpesaVicina/1.0 (+local grocery offer pilot)" }, signal: AbortSignal.timeout(60_000) });
      if (!pdfResponse.ok) throw new Error(`${FLYER_RETAILERS[key] ?? key} flyer PDF returned ${pdfResponse.status}`);
    }
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
    const text = await pdfToText(pdfBuffer);
    let offers = parseOfficialFlyerText(text, key, env.FLYER_STORE_ID ?? key, flyer.pdfUrl, flyer);
    let ocr = null;
    if (!offers.length && env.OCR_URL) {
      ocr = await ocrPdf(pdfBuffer, env);
      offers = reviewOcrOffers(parseOfficialFlyerText(ocrOfferText(ocr.text), key, env.FLYER_STORE_ID ?? key, flyer.pdfUrl, flyer), ocr);
    }
    results.push(...offers);
    diagnostics.push({
      retailer: FLYER_RETAILERS[key] ?? key,
      count: offers.length,
      sourceUrl: flyer.pdfUrl,
      parser: ocr ? "official-flyer-ocr" : "official-flyer-text",
      ...(ocr ? { ocr: { engine: ocr.engine, confidence: ocr.confidence, pages: ocr.pages, cached: ocr.cached } } : {}),
      ...(offers.length ? {} : { status: ocr ? "ocr_no_searchable_products" : (text.trim() ? "no_searchable_products" : "image_only_flyer") }),
    });
  }

  if (env.COOP_STORE_URL) {
    const headers = { "user-agent": "SpesaVicina/1.0 (+local grocery offer pilot)" };
    const storeResponse = await fetch(env.COOP_STORE_URL, { headers, signal: AbortSignal.timeout(30_000) });
    if (!storeResponse.ok) throw new Error(`Coop store page returned ${storeResponse.status}`);
    const storeHtml = (await storeResponse.text()).replace(/\\\//g, "/");
    const directoryHref = storeHtml.match(/https?:\/\/negozi\.volantinopiu\.com\/ccno-[^"'\s<]+\.html/i)?.[0]
      ?? storeHtml.match(/href=["']([^"']*volantinopiu\.com\/ccno-[^"']+)["']/i)?.[1];
    if (!directoryHref) {
      diagnostics.push({ retailer: "Coop", count: 0, status: "no_current_flyer", sourceUrl: env.COOP_STORE_URL });
    } else {
      const directoryUrl = new URL(decodeHtml(directoryHref), env.COOP_STORE_URL).href;
      const directoryResponse = await fetch(directoryUrl, { headers, signal: AbortSignal.timeout(30_000) });
      if (!directoryResponse.ok) throw new Error(`Coop flyer directory returned ${directoryResponse.status}`);
      const directoryHtml = await directoryResponse.text();
      const flyerHrefs = [...new Set([...directoryHtml.matchAll(/href=["']([^"']*redirect\d+\.html\?id_pv=\d+[^"']*)["']/gi)].map((match) => match[1]))].slice(0, 6);
      if (!flyerHrefs.length) {
        diagnostics.push({ retailer: "Coop", count: 0, status: "no_current_flyer", sourceUrl: directoryUrl });
      } else {
        let selectedFlyer = null;
        for (const flyerHref of flyerHrefs) {
          const redirectUrl = new URL(decodeHtml(flyerHref), directoryUrl).href;
          const viewerResponse = await fetch(redirectUrl, { headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
          if (!viewerResponse.ok) continue;
          const viewerUrl = viewerResponse.url;
          const flyerId = viewerUrl.match(/volantino(\d+)00pv/i)?.[1] ?? viewerUrl.match(/volantino(\d+)/i)?.[1];
          const pointId = new URL(viewerUrl).searchParams.get("pv") ?? new URL(redirectUrl).searchParams.get("id_pv");
          if (!flyerId || !pointId) continue;
          const routesUrl = new URL("/src/routes.php", viewerUrl).href;
          const response = await fetch(routesUrl, {
            method: "POST",
            headers: { ...headers, "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
            body: new URLSearchParams({ data: JSON.stringify({ value: "___", tipo: "cerca_prodotti_volantino", id_volantino: flyerId, id_pdv: pointId }) }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) continue;
          const index = await response.json();
          const productIds = [...new Set([...String(index.result ?? "").matchAll(/data-id=['"](\d+)['"]/gi)].map((match) => match[1]))].slice(0, 500);
          if (!selectedFlyer || productIds.length > selectedFlyer.productIds.length) selectedFlyer = { flyerId, pointId, viewerUrl, routesUrl, productIds };
        }
        if (!selectedFlyer?.productIds.length) {
          diagnostics.push({ retailer: "Coop", count: 0, status: "no_searchable_products", sourceUrl: directoryUrl });
          return { offers: results, diagnostics };
        }
        const { flyerId, pointId, viewerUrl, routesUrl, productIds } = selectedFlyer;
        const post = async (data) => {
          const response = await fetch(routesUrl, {
            method: "POST",
            headers: { ...headers, "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
            body: new URLSearchParams({ data: JSON.stringify(data) }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) throw new Error(`Coop flyer API returned ${response.status}`);
          return response.json();
        };
        const offers = [];
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(8, productIds.length) }, async () => {
          while (cursor < productIds.length) {
            const productId = productIds[cursor++];
            const details = await post({ id_prodotto: productId, tipo: "visualizza_dettagli", id_volantino: flyerId, mobile: false, is_app: "" });
            const offer = parseCoopProductDetails(details, productId, env.COOP_STORE_ID ?? "coop", viewerUrl);
            if (offer) offers.push(offer);
          }
        }));
        results.push(...offers);
        diagnostics.push({ retailer: "Coop", count: offers.length, flyerId, pointId, sourceUrl: viewerUrl, parser: "volantinopiu" });
      }
    }
  }

  if (env.ESSELUNGA_PROMOTIONS_URL) {
    const headers = { "user-agent": "SpesaVicina/1.0 (+local grocery offer pilot)" };
    const listingResponse = await fetch(env.ESSELUNGA_PROMOTIONS_URL, { headers });
    if (!listingResponse.ok) throw new Error(`Esselunga returned ${listingResponse.status}`);
    let pageUrl = env.ESSELUNGA_PROMOTIONS_URL;
    let html = await listingResponse.text();
    if (!/<digital-grid\b/i.test(html)) {
      const href = html.match(/href=["']([^"']*volantino-digitale[^"']+)["']/i)?.[1];
      if (href) {
        pageUrl = new URL(decodeHtml(href), env.ESSELUNGA_PROMOTIONS_URL).href;
        const pageResponse = await fetch(pageUrl, { headers });
        if (!pageResponse.ok) throw new Error(`Esselunga flyer returned ${pageResponse.status}`);
        html = await pageResponse.text();
      }
    }
    const store = html.match(/data-store=["']([^"']+)["']/i)?.[1];
    const promo = html.match(/data-cod-promo=["']([^"']+)["']/i)?.[1];
    let offers;
    if (store && promo) {
      const apiUrl = new URL(`/services/istituzionale35/digital-grid.condition:nav_menu.abbrev:${encodeURIComponent(store)}.page:0.rows:500.codPromo:${encodeURIComponent(promo)}.onlyInFlyer:1.shift:0.json`, pageUrl);
      const apiResponse = await fetch(apiUrl, { headers: { ...headers, accept: "application/json" } });
      if (!apiResponse.ok) throw new Error(`Esselunga offer API returned ${apiResponse.status}`);
      offers = parseEsselungaApi(await apiResponse.json(), env.ESSELUNGA_STORE_ID ?? "esselunga-porta-nuova", pageUrl);
    } else {
      offers = parseEsselungaHtml(html, env.ESSELUNGA_STORE_ID ?? "esselunga-porta-nuova", pageUrl);
    }
    results.push(...offers);
    diagnostics.push({ retailer: "Esselunga", count: offers.length, sourceUrl: pageUrl, parser: store && promo ? "digital-grid" : "json-ld" });
  }

  if (env.EKOM_API_URL) {
    const headers = { accept: "application/json", "x-ebsn-client": "site", "x-ebsn-version": "2.1.0", "user-agent": "SpesaVicina/1.0 (+local grocery offer pilot)" };
    const searchResponse = await fetch(`${env.EKOM_API_URL.replace(/\/$/, "")}/leaflet/search`, { headers });
    if (!searchResponse.ok) throw new Error(`Ekom leaflet search returned ${searchResponse.status}`);
    const search = await searchResponse.json();
    const candidates = search?.data?.leaflets ?? search?.data ?? search?.leaflets ?? [];
    const leaflets = Array.isArray(candidates) ? candidates : [];
    const region = String(env.EKOM_REGION ?? "PIEMONTE").toLocaleUpperCase("it");
    const leaflet = leaflets.find((item) => String(item.descr ?? item.description ?? "").toLocaleUpperCase("it").includes(region)) ?? leaflets[0];
    const leafletId = leaflet?.leafletId ?? leaflet?.id;
    if (!leafletId) {
      diagnostics.push({ retailer: "Ekom", count: 0, status: "no_current_leaflet" });
    } else {
      const detailResponse = await fetch(`${env.EKOM_API_URL.replace(/\/$/, "")}/leaflet/view?leaflet_id=${encodeURIComponent(leafletId)}`, { headers });
      if (!detailResponse.ok) throw new Error(`Ekom leaflet returned ${detailResponse.status}`);
      const sourceUrl = leaflet?.slug ? `https://www.ekomdiscount.it/leaflet/${leaflet.slug}` : (env.EKOM_OFFERS_URL ?? "https://www.ekomdiscount.it/leaflet");
      const offers = parseEkomLeaflet(await detailResponse.json(), env.EKOM_STORE_ID ?? "ekom", sourceUrl);
      results.push(...offers);
      diagnostics.push({ retailer: "Ekom", count: offers.length, leafletId, sourceUrl, parser: "leaflet-api" });
    }
  }

  if (env.CARREFOUR_FLYER_URL) {
    const response = await fetch(env.CARREFOUR_FLYER_URL, { headers: { "user-agent": "SpesaVicina/1.0 (+local grocery offer pilot)" } });
    if (!response.ok) throw new Error(`Carrefour returned ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    let offers;
    if (/pdf/i.test(contentType) || /\.pdf(?:$|\?)/i.test(env.CARREFOUR_FLYER_URL)) {
      const pdfBuffer = Buffer.from(await response.arrayBuffer());
      const text = await pdfToText(pdfBuffer);
      offers = parseCarrefourText(text, env.CARREFOUR_STORE_ID ?? "carrefour-corso-belgio", env.CARREFOUR_FLYER_URL);
      if (!offers.length && env.OCR_URL) {
        const ocr = await ocrPdf(pdfBuffer, env);
        offers = reviewOcrOffers(parseCarrefourText(ocrOfferText(ocr.text), env.CARREFOUR_STORE_ID ?? "carrefour-corso-belgio", env.CARREFOUR_FLYER_URL), ocr);
        diagnostics.push({ retailer: "Carrefour", count: offers.length, sourceUrl: env.CARREFOUR_FLYER_URL, parser: "carrefour-ocr", ocr: { engine: ocr.engine, confidence: ocr.confidence, pages: ocr.pages, cached: ocr.cached } });
      }
    } else {
      offers = parseCarrefourHtml(await response.text(), env.CARREFOUR_STORE_ID ?? "carrefour-corso-belgio", env.CARREFOUR_FLYER_URL);
    }
    results.push(...offers);
    diagnostics.push({ retailer: "Carrefour", count: offers.length });
  }

  return { offers: results, diagnostics };
}

export function prepareOffer(offer) {
  return {
    ...offer,
    sourceId: offer.sourceId ?? sourceId(offer.retailer, offer.storeId, offer.productName, offer.price),
    slug: slug(`${offer.brand}-${offer.productName}`),
  };
}
