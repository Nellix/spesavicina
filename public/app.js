const app = document.querySelector("#app");
const authShell = document.querySelector("#auth-shell");
const content = document.querySelector("#content");
const dialog = document.querySelector("#add-dialog");
const toastNode = document.querySelector("#toast");
let state = null;
let toastTimer;
let productSearchTimer;
let analysisPollTimer;
let authCapabilities = { googleEnabled: false };
const catalogueProducts = new Map();

const h = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const euro = (value) => new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(Number(value ?? 0));
const date = (value) => value ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(`${value}T12:00:00`)) : "Check source";
const fullDate = (value) => value ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${String(value).slice(0, 10)}T12:00:00`)) : "No previous promotion";
const route = () => (location.hash.slice(1) || "home").split("?")[0];

function toast(message, type = "success") {
  clearTimeout(toastTimer);
  toastNode.textContent = message;
  toastNode.className = `toast show ${type === "error" ? "error" : ""}`;
  toastTimer = setTimeout(() => { toastNode.className = "toast"; }, 3300);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  let data = {};
  try { data = await response.json(); } catch { /* non-json response */ }
  if (response.status === 401 && !path.startsWith("/api/auth/")) showAuth(authCapabilities);
  if (!response.ok) throw Object.assign(new Error(data.error ?? "Request failed"), { status: response.status });
  return data;
}

function setAuthMode(mode) {
  const register = mode === "register";
  document.querySelector("#login-form").hidden = register;
  document.querySelector("#register-form").hidden = !register;
  document.querySelectorAll("[data-auth-mode]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.authMode === mode)));
  const input = document.querySelector(`#${register ? "register" : "login"}-form input`);
  setTimeout(() => input?.focus(), 0);
}

function showAuth(capabilities = authCapabilities, message = "") {
  authCapabilities = { ...authCapabilities, ...capabilities };
  state = null;
  clearInterval(analysisPollTimer);
  if (dialog.open) dialog.close();
  app.hidden = true;
  authShell.hidden = false;
  document.querySelector("#google-signin").hidden = !authCapabilities.googleEnabled;
  document.querySelector("#google-unavailable").hidden = authCapabilities.googleEnabled;
  if (message) toast(message, "error");
}

async function enterApp(message = "") {
  state = await api("/api/bootstrap");
  authShell.hidden = true;
  app.hidden = false;
  render(); scheduleAnalysisPolling();
  if (message) toast(message);
}

function retailerKey(retailer, preferred = "") {
  if (preferred && preferred !== "market") return preferred;
  const name = String(retailer).toLowerCase();
  if (name.includes("carrefour")) return "carrefour";
  if (name.includes("esselunga")) return "esselunga";
  if (name.includes("coop")) return "coop";
  if (name.includes("conad")) return "conad";
  if (name.includes("pam")) return "pam";
  if (name.includes("in's") || name.includes("ins")) return "ins";
  if (name.includes("ekom")) return "ekom";
  if (name.includes("mercat")) return "mercato";
  if (name.includes("borello")) return "borello";
  if (name.includes("lidl")) return "lidl";
  if (/\bmd\b/.test(name) || name.includes("md discount")) return "md";
  if (name.includes("eurospin")) return "eurospin";
  if (name.includes("crai")) return "crai";
  return "market";
}

function retailerLogo(retailer, large = false, preferred = "") {
  const key = retailerKey(retailer, preferred);
  const marks = { carrefour: "C", esselunga: "ES", coop: "COOP", conad: "CONAD", pam: "PAM", ins: "IN'S", ekom: "EK", mercato: "M", borello: "B", lidl: "LIDL", md: "MD", eurospin: "EU", crai: "CR", market: "●" };
  const logos = {
    carrefour: "/logo-carrefour.svg",
    esselunga: "/logo-esselunga.svg",
    coop: "https://www.coop.it/sites/default/files/2020-07/logo-coop.png",
    ekom: "/logo-ekom.png",
    ins: "https://www.insmercato.it/wp-content/uploads/2023/02/ins-logo.svg",
    conad: "https://www.conad.it/assets/icons/conad-logo.svg",
    md: "https://www.mdspa.it/wp-content/uploads/MD-logo.svg",
    pam: "https://www.pampanorama.it/favicon.ico",
    borello: "https://borellosupermercati.it/wp-content/uploads/2026/08/logo_borello_marchio_footer.svg",
    crai: "https://crai.it/_next/static/media/logo-2025.56672a8b.png",
    mercato: "https://static.mymercato.it/dam/jcr:9788305f-d722-43b0-8187-5664f5ba59a1/Logo=Mercat%C3%B2.svg",
  };
  const logo = logos[key];
  const logoSrc = logo?.startsWith("https://") ? `/api/product-image?url=${encodeURIComponent(logo)}` : logo;
  return `<span class="${large ? "store-logo-large" : "retailer-logo"} brand-${key}${logoSrc ? " official-logo" : ""}" title="${h(retailer)}" aria-label="${h(retailer)} logo"><span class="logo-fallback">${h(marks[key] ?? String(retailer).slice(0, 2).toUpperCase())}</span>${logoSrc ? `<img src="${h(logoSrc)}" alt="" />` : ""}</span>`;
}

function serviceNotices() {
  const unread = (state.serviceNotifications ?? []).filter((item) => !item.readAt).slice(0, 3);
  if (!unread.length) return "";
  return `<section class="service-notices" aria-label="Service updates">${unread.map((item) => `<article class="service-notice"><span>✓</span><div><b>${h(item.title)}</b><p>${h(item.message)}</p></div><button data-read-service-notification="${item.id}" aria-label="Dismiss notification">×</button></article>`).join("")}</section>`;
}

function folded(value = "") {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’`]/g, "'").toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();
}

function stripLeadingLabel(value, label) {
  let result = String(value ?? "").trim();
  const normalizedLabel = folded(label);
  if (!normalizedLabel) return result;
  while (folded(result).startsWith(`${normalizedLabel} `) || folded(result) === normalizedLabel) {
    const words = normalizedLabel.split(" ").length;
    result = result.split(/\s+/).slice(words).join(" ").trim();
  }
  return result;
}

function offerDisplayTitle(offer) {
  const retailerIsBrand = folded(offer.retailer) === folded(offer.brand);
  let productName = stripLeadingLabel(offer.productName, offer.retailer);
  productName = stripLeadingLabel(productName, offer.brand);
  const words = productName.split(/\s+/).filter((word, index, all) => index === 0 || folded(word) !== folded(all[index - 1]));
  productName = words.join(" ");
  const normalizedProduct = ` ${folded(productName)} `;
  const normalizedBrand = folded(offer.brand);
  const alreadyNamesBrand = normalizedBrand && normalizedProduct.includes(` ${normalizedBrand} `);
  return [retailerIsBrand || alreadyNamesBrand ? "" : offer.brand, productName].filter(Boolean).join(" ");
}

function productImage(imageUrl, brand, className = "") {
  const initials = String(brand || "Product").slice(0, 2).toUpperCase();
  const source = imageUrl ? `/api/product-image?url=${encodeURIComponent(imageUrl)}` : "";
  return `<span class="product-image ${h(className)}"><span aria-hidden="true">${h(initials)}</span>${source ? `<img src="${h(source)}" alt="${h(brand)} product" loading="lazy" />` : ""}</span>`;
}

function isCurrentPromotion(offer) {
  if (typeof offer.isCurrent === "boolean") return offer.isCurrent;
  return !offer.validUntil || new Date(`${String(offer.validUntil).slice(0, 10)}T23:59:59`) >= new Date();
}

function offerCard(offer, featured = false) {
  const hasFeedback = Boolean(offer.notificationId);
  const tracked = Boolean(offer.productId && state.watches.some((watch) => watch.productId === offer.productId));
  const current = isCurrentPromotion(offer);
  return `<article class="offer-card ${featured ? "featured" : ""} ${current ? "current-offer" : "past-offer"}" data-filter-text="${h(folded([offer.brand, offer.productName, offer.variant, offer.packSize, offer.retailer, offer.storeName].filter(Boolean).join(" ")))}">
    <div class="offer-top">
      <div class="retailer">${retailerLogo(offer.retailer)}<span><b>${h(offer.retailer)}</b><small>${h(offer.storeName ?? "Selected store")}</small></span></div>
      <span class="saving-badge ${current ? "" : "past-badge"}">${current ? `Live · Save ${euro(offer.saving)}` : "Past promotion"}</span>
    </div>
    <div class="offer-product">${productImage(offer.imageUrl, offer.brand)}<h3>${h(offerDisplayTitle(offer))}<span>${h([offer.variant, offer.packSize].filter(Boolean).join(" · "))}</span></h3></div>
    <div class="price-row"><span class="price-caption">${current ? "Current price" : "Last promo price"}</span><strong>${euro(offer.price)}</strong>${offer.listPrice ? `<s>${euro(offer.listPrice)}</s>` : ""}<small>${h(offer.unitPrice ?? "")}</small></div>
    <div class="offer-meta"><span>${current ? `Valid until ${date(offer.validUntil)}` : `Last promoted ${fullDate(offer.lastPromotionDate)}`}</span><span>${Math.round(Number(offer.confidence) * 100)}% source confidence</span></div>
    <footer><span class="condition">${h(offer.condition || "No loyalty condition published")}</span><div class="offer-actions">${offer.productId ? `<button class="track-offer-button ${tracked ? "tracked" : ""}" data-track-product="${h(offer.productId)}" ${tracked ? "disabled" : ""}>${tracked ? "✓ Tracking" : "+ Track item"}</button>` : ""}${hasFeedback ? `<div class="feedbacks" aria-label="Was this useful?"><button data-feedback="useful" data-id="${offer.notificationId}" class="${offer.feedback === "useful" ? "selected" : ""}" title="Useful">✓</button><button data-feedback="bought" data-id="${offer.notificationId}" class="${offer.feedback === "bought" ? "selected" : ""}" title="I bought it">🛒</button><button data-feedback="not_useful" data-id="${offer.notificationId}" class="${offer.feedback === "not_useful" ? "selected" : ""}" title="Not useful">×</button></div>` : ""}</div></footer>
  </article>`;
}

function pageHeading(kicker, title, subtitle, action = "") {
  return `<div class="page-heading"><div><span class="kicker">${h(kicker)}</span><h1>${h(title)}</h1><p>${h(subtitle)}</p></div>${action}</div>`;
}

function productDescriptor(product) {
  return [product.productName, product.variant, product.packSize].filter(Boolean).join(" · ");
}

function renderProductResults(products, query = "") {
  const results = document.querySelector("#product-results");
  const search = document.querySelector("#product-search");
  search.setAttribute("aria-expanded", String(products.length > 0));
  for (const product of products) catalogueProducts.set(product.id, product);
  if (!products.length) {
    results.innerHTML = `<div class="search-empty"><b>No catalogue match yet</b>Try the brand and pack size, or check the spelling.</div>`;
    return;
  }
  results.innerHTML = products.map((product, index) => `<button type="button" class="product-suggestion" role="option" data-select-product="${h(product.id)}">
    ${productImage(product.imageUrl, product.brand, "product-glyph")}
    <span class="suggestion-copy"><strong>${h(product.brand)}</strong><span>${h(productDescriptor(product))}</span>${index === 0 && query ? `<small class="match-pill">Best normalized match</small>` : ""}</span>
    <span class="suggestion-meta">${product.currentBestPrice !== null ? `<b>Live from ${euro(product.currentBestPrice)}</b><small>${product.storeCount} monitored ${product.storeCount === 1 ? "store" : "stores"}</small>` : product.lastPromotionDate ? `<b>Last promo ${fullDate(product.lastPromotionDate)}</b><small>Collected promotion history</small>` : `<b>Catalogue product</b><small>${h(product.category)}</small>`}</span>
  </button>`).join("");
}

async function searchCatalogue(query = "") {
  const results = document.querySelector("#product-results");
  results.innerHTML = `<div class="search-empty">Finding the cleanest catalogue match…</div>`;
  try {
    const data = await api(`/api/products/search?q=${encodeURIComponent(query)}`);
    renderProductResults(data.products, query);
  } catch (error) { results.innerHTML = `<div class="search-empty"><b>Search unavailable</b>${h(error.message)}</div>`; }
}

function selectCatalogueProduct(productId) {
  const product = catalogueProducts.get(productId);
  if (!product) return;
  document.querySelector("#selected-product-id").value = product.id;
  document.querySelector("#product-search").value = `${product.brand} — ${productDescriptor(product)}`;
  document.querySelector("#product-results").innerHTML = "";
  document.querySelector("#product-search").setAttribute("aria-expanded", "false");
  const selected = document.querySelector("#selected-product");
  selected.hidden = false;
  selected.innerHTML = `<div class="selected-product-inner"><span class="product-glyph">${h(product.brand.slice(0, 2).toUpperCase())}</span><span class="suggestion-copy"><strong>${h(product.brand)}</strong><span>${h(productDescriptor(product))}</span><small class="match-pill">Canonical product</small></span><button type="button" data-action="change-product">Change</button></div>`;
}

function resetProductPicker() {
  const form = document.querySelector("#watch-form");
  form.reset();
  document.querySelector("#selected-product-id").value = "";
  document.querySelector("#selected-product").hidden = true;
  document.querySelector("#selected-product").innerHTML = "";
  document.querySelector("#product-search").value = "";
  searchCatalogue("");
}

function renderHome() {
  const name = state.user.name || state.user.email.split("@")[0];
  const matches = state.notifications.slice(0, 3);
  return `${serviceNotices()}<section class="hero-grid">
    <article class="welcome-card"><span class="kicker">Good ${new Date().getHours() < 12 ? "morning" : "afternoon"}, ${h(name)}</span><h1>Your usual shop,<br /><em>smarter today.</em></h1><p>We found ${state.stats.matches} exact ${state.stats.matches === 1 ? "match" : "matches"} across your selected stores. No substitutes, no noise—just the products already on your list.</p><div class="welcome-actions"><button class="button accent" data-action="open-add">+ Track a product</button><button class="button ghost" data-route-button="stores">Review stores</button></div></article>
    <div class="stat-stack"><article class="stat-card orange"><small>Potential saving</small><strong>${euro(state.stats.potentialSavings)}</strong><span>Across current matched offers</span></article><article class="stat-card"><small>Products watched</small><strong>${state.stats.activeWatches}</strong><span>${state.stores.filter((item) => item.selected).length} selected nearby stores</span></article></div>
  </section>
  <section class="section"><div class="section-title"><div><h2>Worth checking nearby</h2><p>Exact matches that clear your saving threshold.</p></div><button class="text-link" data-route-button="offers">See all offers →</button></div>
  ${matches.length ? `<div class="offer-grid">${matches.map((offer, index) => offerCard(offer, index === 0)).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">◎</div><h3>No exact matches yet</h3><p>That’s a good thing: we only alert you when the brand, product, store and saving threshold all line up.</p><button class="button primary" data-action="open-add">Track a product</button></div>`}</section>
  <section class="section"><div class="notice"><span>⌁</span><div><b>Trust comes before volume</b>Prices and conditions come from retailer publications. Stock is never guaranteed, and uncertain flyer extractions wait for human review.</div></div></section>`;
}

function renderWatchlist() {
  const selectedStores = new Map(state.stores.filter((store) => store.selected).map((store) => [store.id, store]));
  const currentPromotions = state.notifications.filter(isCurrentPromotion);
  const watches = state.watches.map((watch) => {
    const promotion = currentPromotions.filter((offer) => offer.productId === watch.productId && Number(offer.saving) >= Number(watch.minSaving)).sort((left, right) => Number(right.saving) - Number(left.saving) || Number(left.price) - Number(right.price))[0];
    return { watch, promotion, store: promotion ? selectedStores.get(promotion.storeId) : null };
  });
  const liveWatches = watches.filter((item) => item.promotion);
  const quietWatches = watches.filter((item) => !item.promotion);
  const renderWatch = ({ watch, promotion, store }) => `<article class="watch-row ${promotion ? "has-promotion" : ""}" data-filter-text="${h(folded([watch.brand, watch.productName, watch.packSize].filter(Boolean).join(" ")))}">
    ${productImage(promotion?.imageUrl ?? watch.imageUrl, watch.brand, "watch-icon")}<div class="watch-copy">${promotion ? `<span class="promotion-pill">Live saving promotion</span>` : `<span class="history-pill">Waiting for a new offer</span>`}<h3>${h(watch.brand)} · ${h(watch.productName)}</h3><p>${watch.packSize ? `Only ${h(watch.packSize)}` : "Any pack size"}</p>${promotion ? `<small class="promotion-date">${promotion.validUntil ? `Promotion valid until ${fullDate(promotion.validUntil)}` : "Promotion currently active · check retailer dates"}</small>` : `<small class="last-promotion-date">${watch.lastPromotionDate ? `Last recorded promotion date ${fullDate(watch.lastPromotionDate)}` : "No previous promotion recorded"}</small>`}</div>
    ${promotion ? `<div class="watch-promotion"><div class="promotion-retailer">${retailerLogo(promotion.retailer)}<span><small>Buy it at</small><b>${h(promotion.storeName)}</b><em>${store ? `${Number(store.distanceKm).toFixed(1)} km away` : h(promotion.retailer)}</em></span></div><div class="promotion-price"><span><strong>${euro(promotion.price)}</strong>${promotion.listPrice ? `<s>${euro(promotion.listPrice)}</s>` : ""}</span><b>Save ${euro(promotion.saving)}</b></div><button class="text-link" data-route-button="offers">Open offer feed →</button></div>` : `<div class="watch-threshold"><small>No qualifying promotion now</small><b>Alert above ${euro(watch.minSaving)}</b></div>`}
    <div class="row-actions"><button class="toggle ${watch.active ? "on" : ""}" data-toggle-watch="${watch.id}" data-active="${watch.active}" aria-label="${watch.active ? "Pause" : "Resume"} ${h(watch.brand)}"></button><button class="mini-button danger" data-delete-watch="${watch.id}">Remove</button></div>
  </article>`;
  const renderGroup = (title, description, items, kind) => !items.length ? "" : `<section class="watch-group ${kind}" data-watch-group><div class="watch-group-heading"><span><b>${h(title)}</b><small>${h(description)}</small></span><strong>${items.length}</strong></div><div class="watch-list">${items.map(renderWatch).join("")}</div></section>`;
  return `${pageHeading("Your repeat buys", "My products", "Track the exact brands and product lines you really buy.", `<button class="button primary" data-action="open-add">+ Add product</button>`)}
  <div class="notice"><span>◎</span><div><b>Exact means exact</b>“Sant’Anna natural water” will not trigger for another water brand. Pack size is flexible unless you specify one.</div></div>
  ${state.watches.length ? `<div class="list-search"><span aria-hidden="true">⌕</span><input id="watchlist-filter" type="search" placeholder="Search tracked products…" aria-label="Search tracked products" autocomplete="off" /><button type="button" data-clear-filter="watchlist-filter" aria-label="Clear product search">×</button><small id="watchlist-filter-count" aria-live="polite">${state.watches.length} products</small></div>` : ""}
  ${state.watches.length ? `${renderGroup("On promotion now", "Current offers that meet your saving threshold", liveWatches, "live")}${renderGroup("Waiting for the next promotion", "Tracked products without a qualifying live offer", quietWatches, "quiet")}` : `<div class="empty-state"><div class="empty-icon">＋</div><h3>Your watchlist is empty</h3><p>Add a product and we’ll compare it against approved offers from your selected stores.</p><button class="button primary" data-action="open-add">Add your first product</button></div>`}
  <div class="filtered-empty" id="watchlist-filter-empty" hidden><b>No tracked products found</b><span>Try another brand, product name or pack size.</span></div>`;
}

function renderStores() {
  const pending = (state.analysisJobs ?? []).filter((job) => ["queued", "running"].includes(job.status));
  const locationLabel = state.user.geolocatedAt ? "Position updated" : "Use your position";
  return `${pageHeading("Around you", "Nearby stores", `Markets within ${Number(state.user.discoveryRadiusKm).toFixed(1)} km. Selected stores remain visible even outside this range.`, `<button class="button primary" data-action="geolocate">⌖ ${locationLabel}</button>`)}
  ${serviceNotices()}
  ${pending.length ? `<div class="analysis-progress"><span class="analysis-spinner"></span><div><b>Analysis running</b><small>${pending.length} ${pending.length === 1 ? "job is" : "jobs are"} checking nearby stores and retailer offers. You can leave this page—we’ll notify you when ready.</small></div></div>` : ""}
  <div class="map-card" aria-label="Stylised map of selected Turin stores"><div class="map-caption"><b>Centred on ${state.user.geolocatedAt ? "your current position" : "your saved address"}</b><small>${h(state.user.address)}</small></div><div class="map-river"></div><span class="map-pin home"><span>⌂</span></span><span class="map-pin carrefour"><span>C</span></span><span class="map-pin esselunga"><span>E</span></span></div>
  <p class="store-source">Nearby-store data: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></p>
  <div class="list-search"><span aria-hidden="true">⌕</span><input id="store-filter" type="search" placeholder="Search stores or addresses…" aria-label="Search nearby stores" autocomplete="off" /><button type="button" data-clear-filter="store-filter" aria-label="Clear store search">×</button><small id="store-filter-count" aria-live="polite">${state.stores.length} stores</small></div>
  <div class="store-list">${state.stores.map((item) => `<article class="store-row" data-filter-text="${h(folded([item.retailer, item.name, item.address].filter(Boolean).join(" ")))}">
    ${retailerLogo(item.retailer, true, item.logoKey)}<div class="store-copy"><h3>${h(item.name)}</h3><p>${h(item.address)}</p><div class="store-tags"><span>${item.sourceType === "online" ? "Online retailer" : `${item.distanceKm.toFixed(1)} km away`}</span><span class="analysis-${h(item.analysisStatus)}">${h({ not_started: "Not analysed yet", queued: "Analysis queued", running: "Analysing offers", ready: "Live offers ready", failed: "Analysis needs retry", unsupported: "Credentials required" }[item.analysisStatus] ?? "Nearby store")}</span></div></div>
    <div class="store-select"><b>${item.selected ? "Alerts enabled" : "Not selected"}</b><button class="toggle ${item.selected ? "on" : ""}" data-toggle-store="${h(item.id)}" data-selected="${item.selected}" aria-label="Toggle ${h(item.name)}"></button></div>
  </article>`).join("")}</div>
  <div class="filtered-empty" id="store-filter-empty" hidden><b>No nearby stores found</b><span>Try a retailer, branch name or street.</span></div>`;
}

function filterList(input, itemSelector, countId, emptyId, noun) {
  const query = folded(input.value);
  const items = [...document.querySelectorAll(itemSelector)];
  let visible = 0;
  for (const item of items) {
    const matches = !query || String(item.dataset.filterText ?? "").includes(query);
    item.hidden = !matches;
    if (matches) visible += 1;
  }
  const count = document.querySelector(`#${countId}`);
  if (count) count.textContent = query ? `${visible} of ${items.length} ${noun}` : `${items.length} ${noun}`;
  const empty = document.querySelector(`#${emptyId}`);
  if (empty) empty.hidden = !query || visible > 0;
  if (itemSelector === ".watch-row") document.querySelectorAll("[data-watch-group]").forEach((group) => {
    group.hidden = ![...group.querySelectorAll(".watch-row")].some((item) => !item.hidden);
  });
}

function renderOffers() {
  const visible = [...state.offers].sort((left, right) => Number(isCurrentPromotion(right)) - Number(isCurrentPromotion(left)) || String(right.lastPromotionDate ?? "").localeCompare(String(left.lastPromotionDate ?? "")));
  const currentCount = visible.filter(isCurrentPromotion).length;
  return `${pageHeading("Collected product catalogue", "Offer feed", "Every approved product we have collected, with live promotions first and past promotions kept for reference.")}
  <div class="notice"><span>!</span><div><b>Before you make the trip</b>Check the retailer source for stock, loyalty-card and multi-buy conditions. SpesaVicina does not promise shelf availability.</div></div>
  ${visible.length ? `<div class="list-search offer-search"><span aria-hidden="true">⌕</span><input id="offer-filter" type="search" placeholder="Search products, brands or stores…" aria-label="Search collected products" autocomplete="off" /><button type="button" data-clear-filter="offer-filter" aria-label="Clear offer search">×</button><small id="offer-filter-count" aria-live="polite">${visible.length} products</small></div><div class="catalogue-summary"><span><b>${currentCount}</b> live now</span><span><b>${visible.length - currentCount}</b> with promotion history</span></div>` : ""}
  <div class="offer-grid">${visible.length ? visible.map((offer) => offerCard(offer, state.notifications.some((item) => item.id === offer.id))).join("") : `<div class="empty-state"><div class="empty-icon">◇</div><h3>No collected products yet</h3><p>Products will appear after a retailer collector publishes an approved offer.</p></div>`}</div>
  <div class="filtered-empty" id="offer-filter-empty" hidden><b>No collected products found</b><span>Try another brand, product name, pack size or store.</span></div>`;
}

function renderSettings() {
  const user = state.user;
  return `${pageHeading("Your account", "Settings", "Manage your private shopping profile and alert threshold.")}
  <div class="settings-grid"><form class="panel" id="settings-form"><h2>Shopping profile</h2><p>We use your address or the position you explicitly share to rank nearby stores. The pilot does not track you continuously.</p><div class="form-grid">
    <label>Name<input name="name" value="${h(user.name)}" /></label><label>Postcode<input name="postcode" value="${h(user.postcode)}" inputmode="numeric" /></label>
    <label class="full">Shopping address<input name="address" value="${h(user.address)}" /></label><label>Default minimum saving (€)<input name="defaultMinSaving" type="number" min="0" step="0.10" value="${Number(user.defaultMinSaving).toFixed(2)}" /></label><label>Market discovery range (km)<input name="discoveryRadiusKm" type="number" min="0.5" max="25" step="0.5" value="${Number(user.discoveryRadiusKm).toFixed(1)}" /><small>Changing the range starts a fresh nearby-store scan.</small></label>
  </div><div class="form-actions"><button class="button primary" type="submit">Save changes</button></div></form>
  <aside class="panel"><h2>Account & privacy</h2><p>Signed in as <strong>${h(user.email)}</strong>. Your tracked products, selected stores, location, settings and notifications are isolated from every other account.</p><div class="preference-row"><span><b>In-app alerts</b><small>Created once for every new exact product match</small></span><span class="status">active</span></div><div class="privacy-actions"><a class="button ghost" href="/api/profile/export" download>Export my data</a><button class="button danger" type="button" data-action="logout">Sign out</button></div></aside></div>`;
}

async function renderAdmin() {
  if (!state.user.isAdmin) return `<div class="empty-state"><h3>Administrator access only</h3></div>`;
  content.innerHTML = `${pageHeading("Data operations", "Review queue", "Loading connector health and uncertain flyer records…")}<div class="skeleton"></div>`;
  try {
    const admin = await api("/api/admin");
    content.innerHTML = `${pageHeading("Data operations", "Review queue", "Approve uncertain Carrefour flyer records before they can alert anyone.", `<button class="button primary" data-action="ingest">Run ingestion now</button>`)}
      <div class="settings-grid"><section class="panel"><h2>${admin.reviews.length} offers need review</h2><p>Low-confidence extractions stay quarantined until an operator confirms the brand, product and price.</p><div class="review-list">${admin.reviews.length ? admin.reviews.map((item) => `<article class="review-row"><div><h3>${h(item.productName)} · ${euro(item.price)}</h3><p>${h(item.storeName)} · ${h(item.sourceUrl)}</p><span class="confidence">${Math.round(item.confidence * 100)}% confidence</span></div><div class="row-actions"><button class="mini-button" data-review="approved" data-id="${item.id}">Approve</button><button class="mini-button danger" data-review="rejected" data-id="${item.id}">Reject</button></div></article>`).join("") : `<div class="empty-state"><div class="empty-icon">✓</div><h3>Queue cleared</h3><p>No uncertain offers are waiting for review.</p></div>`}</div></section>
      <section class="panel"><h2>Ingestion runs</h2><p>The production schedule runs every twelve hours. Missing sources and zero-result runs are called out explicitly.</p><div class="run-wrap"><table class="run-table"><thead><tr><th>Source</th><th>Status</th><th>Offers</th><th>Detail</th><th>Started</th></tr></thead><tbody>${admin.runs.map((run) => { const diagnostics = Array.isArray(run.diagnostics) ? run.diagnostics : []; const missing = diagnostics.some((item) => item.status === "source_not_discovered" || item.status === "not_configured"); const label = missing ? "source missing" : run.status === "success" && Number(run.offers_found) === 0 ? "no offers" : run.status; const detail = missing ? "No official retailer URL was available" : diagnostics.map((item) => item.parser || item.status).filter(Boolean).join(", ") || run.message || "—"; return `<tr><td>${h(run.source)}</td><td><span class="status ${run.status}">${h(label)}</span></td><td>${run.offers_found}</td><td>${h(detail)}</td><td>${date(run.started_at?.slice(0,10))}</td></tr>`; }).join("")}</tbody></table></div></section></div>`;
  } catch (error) { content.innerHTML = `<div class="empty-state"><h3>Could not load admin data</h3><p>${h(error.message)}</p></div>`; }
}

function syncChrome() {
  const current = route();
  document.querySelectorAll("[data-route]").forEach((item) => item.classList.toggle("active", item.dataset.route === current));
  document.querySelector("#profile-name").textContent = state.user.name || state.user.email.split("@")[0];
  document.querySelector("#profile-email").textContent = state.user.email;
  document.querySelector("#profile-initials").textContent = (state.user.name || state.user.email).slice(0, 1).toUpperCase();
  document.querySelector("#location-label").textContent = state.user.address || "Choose your shopping location";
  document.querySelector("#alert-count").textContent = state.notifications.length + (state.serviceNotifications ?? []).filter((item) => !item.readAt).length;
  document.querySelector("#admin-nav").hidden = !state.user.isAdmin;
}

function render() {
  if (!state) return;
  syncChrome();
  const current = route();
  if (current === "admin") { renderAdmin(); return; }
  const views = { home: renderHome, watchlist: renderWatchlist, stores: renderStores, offers: renderOffers, settings: renderSettings };
  content.innerHTML = (views[current] ?? renderHome)();
  content.focus({ preventScroll: true });
}

async function refresh(message) {
  state = await api("/api/bootstrap");
  render();
  if (message) toast(message);
}

function useCurrentLocation() {
  if (!navigator.geolocation) { toast("Geolocation is not supported by this browser.", "error"); return; }
  if (!window.isSecureContext) { toast("Location access requires the HTTPS Tailscale address.", "error"); return; }
  toast("Requesting your position…");
  navigator.geolocation.getCurrentPosition(async (position) => {
    try {
      await api("/api/location", { method: "POST", body: { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy } });
      await refresh("Position saved. Nearby-store analysis is now running in the cluster.");
    } catch (error) { toast(error.message, "error"); }
  }, (error) => toast(error.code === 1 ? "Location permission was not granted." : "We could not determine your position.", "error"), { enableHighAccuracy: true, timeout: 12_000, maximumAge: 300_000 });
}

function scheduleAnalysisPolling() {
  clearInterval(analysisPollTimer);
  analysisPollTimer = setInterval(async () => {
    if (!state || !(state.analysisJobs ?? []).some((job) => ["queued", "running"].includes(job.status))) return;
    const known = new Set((state.serviceNotifications ?? []).map((item) => item.id));
    try {
      const next = await api("/api/bootstrap");
      const arrived = (next.serviceNotifications ?? []).find((item) => !known.has(item.id));
      state = next; render();
      if (arrived) toast(arrived.title);
    } catch { /* regular navigation will retry */ }
  }, 4000);
}

async function boot() {
  try {
    const status = await api("/api/auth/status");
    authCapabilities = status;
    const authError = new URLSearchParams(location.search).get("auth");
    if (!status.authenticated) { showAuth(status, authError ? "Google sign-in was not completed." : ""); return; }
    content.innerHTML = `<div class="skeleton"></div>`;
    await enterApp();
  } catch (error) {
    showAuth(authCapabilities, error.message);
  }
}

async function submitAuth(form, path, successMessage) {
  const button = form.querySelector("button[type=submit]");
  const original = button.textContent;
  button.disabled = true; button.textContent = "Please wait…";
  try {
    await api(path, { method: "POST", body: Object.fromEntries(new FormData(form)) });
    form.reset(); await enterApp(successMessage);
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; button.textContent = original; }
}

document.querySelector("#login-form").addEventListener("submit", (event) => { event.preventDefault(); submitAuth(event.currentTarget, "/api/auth/login", "Welcome back."); });
document.querySelector("#register-form").addEventListener("submit", (event) => { event.preventDefault(); submitAuth(event.currentTarget, "/api/auth/register", "Your private account is ready."); });

document.querySelector("#watch-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  if (!data.productId) { toast("Choose one of the suggested catalogue products.", "error"); return; }
  try { await api("/api/watch-items", { method: "POST", body: data }); dialog.close(); form.reset(); await refresh("Product added. We checked it against active offers."); }
  catch (error) { toast(error.message, "error"); }
});

document.querySelector("#product-search").addEventListener("input", (event) => {
  clearTimeout(productSearchTimer);
  document.querySelector("#selected-product-id").value = "";
  document.querySelector("#selected-product").hidden = true;
  const query = event.currentTarget.value.trim();
  productSearchTimer = setTimeout(() => searchCatalogue(query), 180);
});

document.addEventListener("input", (event) => {
  if (event.target.id === "watchlist-filter") filterList(event.target, ".watch-row", "watchlist-filter-count", "watchlist-filter-empty", "products");
  if (event.target.id === "store-filter") filterList(event.target, ".store-row", "store-filter-count", "store-filter-empty", "stores");
  if (event.target.id === "offer-filter") filterList(event.target, ".offer-card", "offer-filter-count", "offer-filter-empty", "products");
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button, a");
  if (!target) return;
  if (target.dataset.authMode) { setAuthMode(target.dataset.authMode); return; }
  if (target.dataset.routeButton) { location.hash = target.dataset.routeButton; return; }
  if (target.dataset.clearFilter) { const input = document.querySelector(`#${target.dataset.clearFilter}`); if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); } return; }
  if (target.dataset.action === "open-add") { resetProductPicker(); dialog.showModal(); setTimeout(() => document.querySelector("#product-search").focus(), 0); return; }
  if (target.dataset.action === "close-dialog") { dialog.close(); return; }
  if (target.dataset.action === "geolocate") { useCurrentLocation(); return; }
  if (target.dataset.action === "logout") { try { await api("/api/auth/logout", { method: "POST" }); showAuth(authCapabilities); setAuthMode("login"); toast("Signed out."); } catch (error) { toast(error.message, "error"); } return; }
  if (target.dataset.action === "change-product") { document.querySelector("#selected-product-id").value = ""; document.querySelector("#selected-product").hidden = true; document.querySelector("#product-search").value = ""; searchCatalogue(""); document.querySelector("#product-search").focus(); return; }
  if (target.dataset.selectProduct) { selectCatalogueProduct(target.dataset.selectProduct); return; }
  if (target.dataset.action === "ingest") { target.disabled = true; target.textContent = "Running…"; try { const result = await api("/api/admin/ingest", { method: "POST" }); const succeeded = result.results.filter((item) => item.ok).length; toast(`Triggered ${succeeded} of ${result.results.length} retailer sources.`); await renderAdmin(); } catch (error) { toast(error.message, "error"); target.disabled = false; } return; }
  if (target.dataset.toggleWatch) { try { await api(`/api/watch-items/${target.dataset.toggleWatch}`, { method: "PATCH", body: { active: target.dataset.active !== "true" } }); await refresh("Watchlist updated."); } catch (error) { toast(error.message, "error"); } return; }
  if (target.dataset.deleteWatch) { if (!confirm("Stop tracking this product?")) return; try { await api(`/api/watch-items/${target.dataset.deleteWatch}`, { method: "DELETE" }); await refresh("Product removed."); } catch (error) { toast(error.message, "error"); } return; }
  if (target.dataset.toggleStore) { try { const result = await api(`/api/stores/${target.dataset.toggleStore}`, { method: "PATCH", body: { selected: target.dataset.selected !== "true" } }); await refresh(result.analysisStarted ? "Store selected. Live-offer analysis is running in the cluster." : "Store preference updated."); } catch (error) { toast(error.message, "error"); } return; }
  if (target.dataset.readServiceNotification) { try { await api(`/api/service-notifications/${target.dataset.readServiceNotification}/read`, { method: "POST" }); await refresh(); } catch (error) { toast(error.message, "error"); } return; }
  if (target.dataset.trackProduct) { target.disabled = true; try { await api("/api/watch-items", { method: "POST", body: { productId: target.dataset.trackProduct, minSaving: state.user.defaultMinSaving } }); await refresh("Product added to your tracked items."); } catch (error) { if (error.status === 409) await refresh("You already track this product."); else { target.disabled = false; toast(error.message, "error"); } } return; }
  if (target.dataset.feedback) { try { await api(`/api/notifications/${target.dataset.id}/feedback`, { method: "POST", body: { value: target.dataset.feedback } }); await refresh("Thanks — this helps us measure usefulness."); } catch (error) { toast(error.message, "error"); } return; }
  if (target.dataset.review) { try { await api(`/api/admin/offers/${target.dataset.id}`, { method: "PATCH", body: { status: target.dataset.review } }); toast(`Offer ${target.dataset.review}.`); await renderAdmin(); } catch (error) { toast(error.message, "error"); } }
});

document.addEventListener("error", (event) => {
  if (event.target.matches?.(".product-image img, .official-logo img")) event.target.hidden = true;
}, true);

document.addEventListener("submit", async (event) => {
  if (event.target.id !== "settings-form") return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  try { const result = await api("/api/settings", { method: "PATCH", body: data }); await refresh(result.discoveryStarted ? "Settings saved. A fresh nearby-store scan is running." : "Settings saved."); } catch (error) { toast(error.message, "error"); }
});

window.addEventListener("hashchange", render);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot();
