# Contributing to SpesaVicina

Thank you for helping make grocery savings more accessible.

## Getting started

1. Fork the repository and create a focused branch.
2. Install Node.js 22 or newer and run `npm ci`.
3. Make the smallest coherent change and add tests for new behaviour.
4. Run `npm run lint`, `npm test`, and `npm run build`.
5. Open a pull request explaining the user benefit, evidence source, and verification performed.

## Retailer connectors

Use retailer-owned, publicly accessible sources. Do not commit credentials, bypass access controls, or collect personal customer data. A connector must preserve its source URL and evidence, report parser drift clearly, and quarantine uncertain prices or product identities for review.

Prefer structured retailer APIs or embedded product data. Use PDF text extraction next and OCR only as a fallback. New OCR-derived offers must remain in review until their identity and price are trustworthy.

## Product identity

Do not create user-specific aliases as independent products. Prefer GTIN/EAN, then retailer SKU, then reviewed canonical fields. Tests should cover casing, punctuation, apostrophes, pack notation, and common misspellings.

## Privacy and security

Keep all private profile data scoped by the authenticated profile ID. Never add secrets, production database dumps, exact user locations, or session data to fixtures or diagnostics. Report security problems privately as described in `SECURITY.md`.
