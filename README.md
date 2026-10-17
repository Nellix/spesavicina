# SpesaVicina

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An open-source, location-aware framework that helps people buy the groceries they already use at the lowest worthwhile nearby price.

SpesaVicina watches the exact grocery products a person already buys and creates an alert only when an approved nearby offer clears their saving threshold.

> Tell us the products you really buy. We notify you only when a nearby offer is genuinely worth the trip.

The included configuration currently uses Turin as its reference pilot. Each person signs in with an email/password account or Google and receives an isolated shopping profile. Email delivery remains out of scope; alerts are delivered in the app.

## Architecture

Image-only PDF flyers are handled by the internal `ocr-worker`. Collectors first use embedded PDF text and call OCR only when that path finds no usable products. The worker runs Tesseract (`ita+eng`) one job at a time, caches results by SHA-256 checksum, and returns OCR-derived offers as `review` rather than publishing them automatically.

The Kubernetes deployment contains independently operated services in the single `grocery-offers` namespace:

- `spesavicina`: web frontend and public/internal HTTP API;
- `matching-worker`: consumes catalogue/watch/offer events and creates idempotent exact-product matches;
- `notification-worker`: turns new matches into in-app alerts;
- `store-analysis-worker`: discovers nearby stores and runs selected-store analysis asynchronously;
- `carrefour-ingestor`: isolated Carrefour source adapter;
- `esselunga-ingestor`: isolated Esselunga source adapter;
- `ekom-ingestor`: isolated Ekom leaflet API adapter;
- `coop-ingestor`: isolated store-specific Coop digital-flyer adapter;
- `lidl-ingestor`: Lidl Italy product-grid adapter with Piemonte regional prices and Lidl Plus conditions;
- `ins`, `conad`, `md`, `pam`, `borello`, `crai`, and `mercato` ingestors: isolated official-flyer adapters used for selected nearby stores;
- `spesavicina-postgres`: PostgreSQL 16 managed by the cluster's Zalando operator;
- retailer CronJobs plus the store-analysis worker's six-hour selected-store refresh.

PostgreSQL is also the durable queue. API mutations and ingestions write transactional outbox events; workers claim them with locking and retry failed events with backoff. This avoids running another queue cluster before pilot traffic justifies it while preserving clear event boundaries.

## Accounts and data isolation

- Email/password credentials use salted scrypt hashes; plaintext passwords are never stored.
- Google uses the OpenID Connect authorization-code flow with PKCE, state, nonce, verified issuer/audience, and verified email checks.
- The browser receives only a random, HTTP-only, SameSite session cookie. PostgreSQL stores a SHA-256 hash of that token, and logout revokes the server-side session.
- Watch items, selected stores, location, settings, analysis jobs, service notifications, matches, notifications, and feedback are always read and mutated through the authenticated profile ID.
- The canonical product catalogue, retailer stores, and published offer evidence are shared reference data. One user's private intent is never copied into another account.
- The bootstrap profile is retained as administrator profile `1`; new registrations start with empty private data.

Set the initial administrator credentials in the Kubernetes Secret before deploying the authentication build:

```bash
kubectl -n grocery-offers patch secret spesavicina-service-secrets --type merge \
  -p '{"stringData":{"BOOTSTRAP_ADMIN_EMAIL":"you@example.com","BOOTSTRAP_ADMIN_PASSWORD":"use-a-long-unique-password"}}'
```

Changing `BOOTSTRAP_ADMIN_PASSWORD` and restarting the API also rotates the administrator password.

To enable Google sign-in, create an OAuth 2.0 Web application in Google Cloud, add `https://spesavicina.example.com/api/auth/google/callback` (using your real public domain) as an authorized redirect URI, and add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to the same Secret. If those keys are absent, email/password authentication remains available and the Google button stays hidden.

See [Architecture](docs/ARCHITECTURE.md) for the data model, event flow, and operational decisions. Contributions are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Product identity

Users never create free-text watch records. Search tolerates accents, punctuation, apostrophes, abbreviations, pack notation, and small spelling mistakes, but the saved watch always points to a canonical `products.id`.

Identity priority is:

1. GTIN/EAN;
2. retailer SKU;
3. reviewed canonical product fields;
4. normalized search candidate;
5. manual review if confidence is insufficient.

For example, `Sant'Anna Naturale 6x1.5`, `Sant Anna nat 6 x 1,5 l`, and `santana nat 6x1.5l` all resolve to `santanna-acqua-naturale-6x1-5l`.

## Build and test

Node.js 22 or newer is required.

```bash
npm ci
npm run lint
npm test
npm run build
```

The build produces self-contained service bundles in `dist/`. The checked-in Dockerfile builds one multi-role image and includes Poppler for flyer extraction. The current private-cluster deployment mounts a compressed ingestor bundle into the official Node.js image; its JavaScript PDF fallback avoids requiring Poppler in that runtime.

## Deploy to Kubernetes

The cluster must have the Zalando PostgreSQL operator and a `local-path` storage class.
Before deployment, replace the example public URL and retailer/store defaults in `k8s/spesavicina.yaml` with values appropriate for your installation.

For an existing installation, the repeatable deployment script refreshes all bundles, applies the manifest, explicitly removes the retired Amazon workload, and waits for every deployment:

```bash
./scripts/deploy-k8s.sh
```

The equivalent manual steps are shown below.

```bash
npm run build

kubectl create namespace grocery-offers --dry-run=client -o yaml | kubectl apply -f -

kubectl -n grocery-offers create configmap spesavicina-api-bundle \
  --from-file=api.mjs=dist/api.mjs --dry-run=client -o yaml | kubectl apply -f -
kubectl -n grocery-offers create configmap spesavicina-matcher-bundle \
  --from-file=matcher.mjs=dist/matcher.mjs --dry-run=client -o yaml | kubectl apply -f -
kubectl -n grocery-offers create configmap spesavicina-notifier-bundle \
  --from-file=notifier.mjs=dist/notifier.mjs --dry-run=client -o yaml | kubectl apply -f -
kubectl -n grocery-offers create configmap spesavicina-store-analysis-bundle \
  --from-file=store-analysis.mjs=dist/store-analysis.mjs --dry-run=client -o yaml | kubectl apply -f -
kubectl -n grocery-offers create configmap spesavicina-ingestor-bundle \
  --from-file=ingestor.mjs.gz=dist/ingestor.mjs.gz --dry-run=client -o yaml | kubectl apply -f -
kubectl -n grocery-offers create configmap spesavicina-public \
  --from-file=dist/public --dry-run=client -o yaml | kubectl apply -f -

SERVICE_TOKEN="$(openssl rand -hex 32)"
kubectl -n grocery-offers create secret generic spesavicina-service-secrets \
  --from-literal=SERVICE_TOKEN="$SERVICE_TOKEN" \
  --from-literal=BOOTSTRAP_ADMIN_EMAIL="you@example.com" \
  --from-literal=BOOTSTRAP_ADMIN_PASSWORD="use-a-long-unique-password" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f k8s/spesavicina.yaml
kubectl -n grocery-offers rollout status deployment/spesavicina --timeout=5m
```

Example exposure options are:

- HTTPS through your own ingress, tunnel, or reverse proxy;
- LAN NodePort: port `30389`

Origin validation accepts the configured public origin or an origin whose host matches the actual request/forwarded host, so direct NodePort mutations work without allowing arbitrary cross-origin writes.

## Retailer sources

Carrefour store pages discovered through OpenStreetMap are converted to their official store-specific flyer URLs. The connector reads current HTML offer tiles directly and sends high-confidence branded records to matching; ambiguous records are quarantined for review. Esselunga uses its digital-grid feed, Ekom uses its official leaflet API, Coop resolves the selected store's current digital flyer and structured product details, and Lidl reads the official structured product grid using the configured regional price. IN'S, Conad, MD, Pam, Borello, CRAI, and Mercatò resolve retailer-owned store/flyer pages and extract recognizable branded products from the current official PDF. An unavailable store-specific source is reported to the user and retried later.

Every successful non-empty source run is treated as a complete snapshot for that retailer/store. Records not seen again are marked expired while remaining searchable as promotion history. This prevents undated flyer products from remaining current indefinitely.

Nearby-store discovery uses Overpass and Nominatim after the user explicitly shares a position. The browser requires a secure context for geolocation, so use the Tailscale HTTPS endpoint; the HTTP LAN NodePort remains suitable for development but cannot request location permission in standards-compliant browsers. Store data is attributed to OpenStreetMap contributors in the UI.

Retailer terms, robots directives, source stability, and offer accuracy must be validated before a public launch. The UI never claims stock availability.

## Current limitations

- one API replica and in-process login rate limiting; use a shared rate limiter before horizontally scaling the API;
- account recovery, email verification for password accounts, password changes, MFA, and session management UI are not implemented yet;
- one PostgreSQL instance, not high availability;
- the canonical catalogue is seeded and can expand through approved offers, but operator merge/split tools remain basic;
- MD and Pam expose store-specific application data rather than a stable global flyer URL, so collection may report `no_current_flyer` until the selected store exposes a resolvable source;
- discovered stores depend on the completeness and freshness of OpenStreetMap metadata.

The previous SQLite PVC is not deleted during migration, so the prototype data remains recoverable until it is explicitly retired.

## License

SpesaVicina is released under the [MIT License](LICENSE). Retailer names and logos remain the property of their respective owners, and deployments are responsible for complying with retailer terms and applicable data-protection law.
