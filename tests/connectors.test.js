import test from "node:test";
import assert from "node:assert/strict";
import { discoverOfficialFlyer, parseCarrefourHtml, parseCarrefourText, parseCoopProductDetails, parseEkomLeaflet, parseEsselungaApi, parseEsselungaHtml, parseLidlHtml, parseOfficialFlyerText } from "../server/connectors.js";

test("Esselunga connector extracts structured product offers", () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"Yogurt intero Brimi","brand":{"name":"Brimi"},"size":"2 x 125 g","offers":{"price":"1.19","highPrice":"1.79","priceValidUntil":"2026-10-01","eligibleCustomerType":"Fidaty"}}</script>`;
  const result = parseEsselungaHtml(html, "esselunga-porta-nuova", "https://example.test/esselunga");
  assert.equal(result.length, 1);
  assert.equal(result[0].brand, "Brimi");
  assert.equal(result[0].price, 1.19);
  assert.equal(result[0].status, "approved");
});

test("Carrefour PDF text is quarantined for review", () => {
  const result = parseCarrefourText("ACQUA SANT'ANNA NATURALE\n2,49 €\nPASTA BARILLA\n0,89 €", "carrefour-corso-belgio", "https://example.test/flyer.pdf");
  assert.equal(result.length, 2);
  assert.equal(result[0].price, 2.49);
  assert.equal(result[0].status, "review");
  assert.ok(result[0].confidence < 0.8);
});

test("Carrefour live flyer HTML extracts branded price evidence", () => {
  const html = `<p>Validità promozioni dal <strong>10/09</strong> al <strong>22/09</strong></p>
    <div class="product tile flyer-tile" data-pid="volantino-800123-42"
      data-product-json="{&quot;name&quot;:&quot;Acqua Sant&#39;Anna Naturale 6 x 1,5 L&quot;,&quot;id&quot;:&quot;volantino-800123-42&quot;,&quot;brand&quot;:&quot;Sant&#39;Anna&quot;}">
      <img class="tile-image lazyload" data-src="https://images.example.test/santanna.jpg" />
      <div class="discounts-flyer"><div class="d-prices"><p class="d-prices__original"><span>&euro;3,99</span></p></div>
      <p class="d-prices__final"><strong>&euro;2,49</strong></p><span class="d-prices__partial">&euro;0,28 al L</span></div></div>`;
  const offers = parseCarrefourHtml(html, "store-42", "https://www.carrefour.it/volantino/store/42", new Date("2026-09-15T00:00:00Z"));
  assert.equal(offers.length, 1);
  assert.equal(offers[0].sourceId, "volantino-800123-42");
  assert.equal(offers[0].brand, "Sant'Anna");
  assert.equal(offers[0].price, 2.49);
  assert.equal(offers[0].listPrice, 3.99);
  assert.equal(offers[0].packSize, "6 x 1,5 L");
  assert.equal(offers[0].validUntil, "2026-09-22");
  assert.equal(offers[0].status, "approved");
  assert.equal(offers[0].sourceEvidence.imageUrl, "https://images.example.test/santanna.jpg");
});

test("Esselunga digital-grid API extracts official promotional prices", () => {
  const offers = parseEsselungaApi({ items: [{ code: "123", title: "Brimi Mozzarella 4 x 100 g", prezzo: 4.99, promozioni_prezzoPromo: [2.49], promozioni_prezzoPromoAl: [6.23], promozioni_misuraPrezzoPromoAl: ["KG"], promozioni_dataInizioPromoArticolo: ["2026-09-18T00:00:00Z"], promozioni_dataFinePromoArticolo: ["2026-09-28T00:00:00Z"], promozioni_desMeccanica: ["Sconto %"], imgUrl: "https://images.example.test/brimi.jpg" }, { code: "regular", title: "Prodotto solo evidenziato 200 g", prezzo: 1, promozioni_prezzoPromo: [1], promozioni_desMeccanica: ["EVIDENZIAZIONE SENZA OFFERTA"] }, { code: "x", title: "Parent_placeholder", prezzo: 1 }] }, "store-es", "https://www.esselunga.it/flyer");
  assert.equal(offers.length, 1);
  assert.equal(offers[0].brand, "Brimi");
  assert.equal(offers[0].price, 2.49);
  assert.equal(offers[0].listPrice, 4.99);
  assert.equal(offers[0].packSize, "4 x 100 g");
  assert.equal(offers[0].validUntil, "2026-09-28");
  assert.equal(offers[0].unitPrice, "€6,23/KG");
  assert.equal(offers[0].status, "approved");
  assert.equal(offers[0].sourceEvidence.imageUrl, "https://images.example.test/brimi.jpg");
});

test("Esselunga digital-grid expands grouped related products", () => {
  const offers = parseEsselungaApi({ items: [{
    title: "Parent_group", related_items: [
      { code: "a", title: "Bonduelle Insalata 200 g", prezzo: 2, promozioni_prezzoPromo: [1.4], promozioni_desMeccanica: ["Sconto %"] },
      { code: "b", title: "Cirio Passata 700 g", prezzo: 1.5, promozioni_prezzoPromo: [0.99], promozioni_desMeccanica: ["Sconto %"] },
    ],
  }] }, "store-es", "https://www.esselunga.it/flyer");
  assert.equal(offers.length, 2);
  assert.deepEqual(offers.map((offer) => offer.sourceId), ["esselunga-a", "esselunga-b"]);
  assert.ok(offers.every((offer) => offer.status === "approved"));
  assert.deepEqual(offers[0].identifiers[0], { scheme: "retailer_sku", retailer: "Esselunga", value: "a" });
});

test("structured title fallback does not mistake an embedded short brand", () => {
  const offers = parseEsselungaApi({ items: [{ code: "cot-1", title: "Cotonella slip donna 2 paia", prezzo: 12.9, promozioni_prezzoPromo: [10.32], promozioni_desMeccanica: ["Sc % Fidaty"] }] });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].brand, "Cotonella");
  assert.equal(offers[0].status, "approved");
});

test("Ekom official leaflet API extracts products and quarantines unknown brands", () => {
  const payload = { data: { leaflet: { leafletId: 71, leafletPage: [{ leafletArea: [{ leafletAreaId: 9, metadata: { leafletareatype_ekomproduct: { TITLE: "BIRRA ICHNUSA", PIECES: "500 ml", PRICE: "1.29", START_DATE: "2026-09-08", END_DATE: "2026-09-21", IMAGE: { location: "https://images.example.test/ichnusa.jpg" } } } }, { leafletAreaId: 10, metadata: { leafletareatype_ekomproduct: { TITLE: "PRODOTTO LOCALE", PRICE: "2,50" } } }] }] } } };
  const offers = parseEkomLeaflet(payload, "store-ek", "https://www.ekomdiscount.it/leaflet/11-2");
  assert.equal(offers.length, 2);
  assert.equal(offers[0].brand, "Ichnusa");
  assert.equal(offers[0].price, 1.29);
  assert.equal(offers[0].status, "approved");
  assert.equal(offers[0].sourceEvidence.imageUrl, "https://images.example.test/ichnusa.jpg");
  assert.equal(offers[1].status, "review");
});

test("Coop flyer product details extract structured first-party-linked evidence", () => {
  const payload = { result: { body: `<div><h4> LATTE MICROFILTRATO </h4><div class='pb-0 clearfix d-flex'>parzialmente scremato Origine Coop<br /> 1 litro</div><img src='https://resources.volantinopiu.it/promo/item.webp'><div class='product-price text-right'>&euro;&nbsp;1,19</div></div>` } };
  const offer = parseCoopProductDetails(payload, "287440003002", "store-coop", "https://coop.volantinopiu.com/volantino2874400pv175.html");
  assert.equal(offer.retailer, "Coop");
  assert.equal(offer.brand, "Coop");
  assert.equal(offer.price, 1.19);
  assert.equal(offer.packSize, "1 litro");
  assert.equal(offer.status, "approved");
});

test("Lidl official product grid selects the configured regional price and validity", () => {
  const card = {
    productType: "RETAIL", havingPrice: true, productId: 11030073, fullTitle: "Limoni Interdonato di Messina IGP",
    image: "https://www.lidl.it/assets/limoni.png", canonicalUrl: "/p/limoni/p11030073", timezoneId: "Europe/Rome",
    storeStartDate: 1790805600, storeEndDate: 1791410399,
    regionsV2: { 41000: { regionPriceId: "piemonte", regionName: "Biandrate - Piemonte" } },
    regionsPrices: { piemonte: { currentPrice: { price: 1.39, oldPrice: 1.99, packaging: { text: "750 g confezione" }, basePrice: { text: "1 kg = 1.85 €" } } } },
  };
  const encoded = JSON.stringify(card).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const offers = parseLidlHtml(`<li data-grid-data="${encoded}"></li>`, "store-lidl", "https://www.lidl.it/c/c1150", "41000");
  assert.equal(offers.length, 1);
  assert.equal(offers[0].retailer, "Lidl");
  assert.equal(offers[0].price, 1.39);
  assert.equal(offers[0].listPrice, 1.99);
  assert.equal(offers[0].validFrom, "2026-10-01");
  assert.equal(offers[0].validUntil, "2026-10-07");
  assert.equal(offers[0].sourceEvidence.regionName, "Biandrate - Piemonte");
});

test("Conad official store page resolves its current flyer and validity", () => {
  const flyers = JSON.stringify([{ title: "BIS CITY PIEMONTE", valid: true, mainFlyer: true, validFrom: Date.parse("2026-10-07T00:00:00+02:00"), validTo: Date.parse("2026-10-20T23:59:59+02:00"), pdfUrl: "https://www.conad.it/assets/current.pdf" }]).replace(/"/g, "&#34;");
  const flyer = discoverOfficialFlyer(`<div data-flyers="${flyers}"></div>`, "conad", "https://www.conad.it/store");
  assert.equal(flyer.pdfUrl, "https://www.conad.it/assets/current.pdf");
  assert.equal(flyer.validFrom, "2026-10-07");
  assert.equal(flyer.validUntil, "2026-10-20");
});

test("Mercatò structured store data resolves flyer and product text", () => {
  const page = `<script>{"store":{"flyers":[{"title":"OFFERTE ESAGERATE","startDate":"20261012000000","endDate":"20261021000000","linkFlyer":"https://cdn.dimar.it/volantini/current.pdf"}]}}</script>`;
  const flyer = discoverOfficialFlyer(page, "mercato", "https://www.mymercato.it/store");
  assert.equal(flyer.pdfUrl, "https://cdn.dimar.it/volantini/current.pdf");
  assert.equal(flyer.validUntil, "2026-10-21");
  const offers = parseOfficialFlyerText("€3,49\nDETERSIVO LAVATRICE LIQUIDO SOLE\n41 LAVAGGI\nlt.1,845\nCAFFÈ LAVAZZA QUALITÀ ROSSA 2 x 250 g 5,49 €\nPRODOTTO SENZA MARCA 2,00 €", "mercato", "store-mercato", flyer.pdfUrl, flyer);
  assert.equal(offers.some((offer) => offer.price === 1.84), false);
  assert.equal(offers.length, 2);
  const lavazza = offers.find((offer) => offer.brand === "Lavazza");
  assert.equal(lavazza.retailer, "Mercatò");
  assert.equal(lavazza.price, 5.49);
  assert.equal(lavazza.validUntil, "2026-10-21");
});
