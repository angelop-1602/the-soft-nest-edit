# Local commerce development

The newer [Product Atelier guide](ADMIN-PRODUCTS.md) documents protected product
administration, migrations 0006/0007, Cloudflare Access and `python dev.py --admin`.
Its review and exception workflow extends the foundations described below.

This stage adds CJ freight estimates, approval-aware retail pricing, a persistent
planning cart, and a **separate, local-only product PayPal Sandbox exercise**.
Customer checkout, real PayPal charges, CJ order creation and CJ payment remain
disabled. No production migration, catalog synchronization or deployment was run.
The fixed USD 1.00 Sandbox test and its database constraint remain intact.

## Run locally

Python 3.10+ and Node 22.17+ are supported. The new SQL integration tests use
Node's built-in `node:sqlite` (Node 22 prints an experimental-feature warning).
There is no frontend build tool or package.json.

```powershell
python -m pip install -r requirements.txt
npx wrangler d1 migrations apply softnest-orders-sandbox --local --persist-to .local/worker-state
python dev.py
```

Visit `http://127.0.0.1:8787/shop/catalog-preview/` and
`http://127.0.0.1:8787/shop/cart-preview/`. `python dev.py --port 8791` selects
another port when your existing preview uses 8787. The watcher rebuilds changes
under `templates/`, `static/`, `content/`, `data/`, plus `build.py` and `.pages.yml`.
Refresh the browser to see static changes. Wrangler reloads backend changes.
The watcher runs `build.py` in a temporary source copy and synchronizes finished
files into `dist/`, keeping watched directories stable. Stop the dev server before
running a manual full build or the Python integration scripts, since the original
generator deletes and recreates `dist/`.

Equivalent two-terminal setup:

```powershell
python dev.py --watch-only
npx wrangler dev --local --ip 127.0.0.1 --persist-to .local/worker-state
```

These commands deliberately use `.local/worker-state`. They do not replace the
existing `.wrangler/state` database or affect remote D1. Always use the same
`--persist-to` path for migration, SQL inspection and `wrangler dev`.

The added migration is `migrations/0005_product_commerce_foundations.sql`.
It adds approval provenance, shared CJ throttling, private shipping quotes,
product Sandbox orders/events, and disabled future fulfillment records.
It contains no approvals and deletes no records. For a database already managed
by Wrangler migrations, the `migrations apply` command above applies only pending
files. If an older local database was initialized by manually executing SQL
instead, do not replay all old ALTER statements: after confirming 0001–0004 are
already present and 0005 is absent, apply only the new file:

```powershell
npx wrangler d1 execute softnest-orders-sandbox --local --file migrations/0005_product_commerce_foundations.sql
```

The last command uses Wrangler's original default `.wrangler/state`, so it is
only for intentionally upgrading that existing local database. Do not run both
migration methods against the same already-upgraded database. Remote migration
and deployment require separate approval and a review of the remote migration
history; neither is part of this update.

## Credentials and pricing policy

Keep credentials in `.dev.vars` beside `wrangler.jsonc`. Leave any existing
credentials alone; copy only missing settings from `examples/dev.vars.example`.
`.dev.vars*`, `.env*`, `.local/` and `.wrangler/` are ignored. Some historical
Wrangler files remain tracked; an ignore rule does not untrack them.

Supported server-only settings:

| Setting | Purpose |
| --- | --- |
| `CJDROPSHIPPING_API` | Existing CJ API key; cached/refresh tokens remain in D1 |
| `PAYPAL_MODE` | Must be `sandbox` |
| `PAYPAL_SANDBOX_CHECKOUT_ENABLED` | Existing fixed $1 test gate |
| `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET` | Sandbox credentials only |
| `PRODUCT_SANDBOX_CHECKOUT_ENABLED` | Defaults to `false`; `true` still requires a local request hostname |
| `RETAIL_PRICING_POLICY` | Explicit JSON policy; absent/invalid policy blocks verified pricing |

The example policy is illustrative and is not an assertion of your actual
PayPal fees or a merchant-approved selling policy. It configures a version,
target net margin and variable fees in basis points, fixed processing fees,
per-item and shipping cost buffers in integer USD cents, and a maximum total.

The engine computes each minimum product retail price from supplier cost,
per-item buffer, margin and variable fees. The separately displayed retail
shipping charge covers the verified freight estimate, shipping buffer, fixed
processing fee, margin and variable fees. It checks the complete basket against
the same net-margin policy. It never accepts a price from the browser. BigInt
intermediates round up to integer cents; no tax amount is invented.

An imported product remains inactive until a merchant explicitly approves it.
Every product and variant must be active, and each variant needs:

- A positive supplier cost with recent verification (24 hours).
- A positive approved retail price, a valid `retail_verified_at`, the current
  `retail_policy_version`, and `approved_supplier_cost_cents` matching the cost
  actually reviewed. Pricing approval expires after one year.
- Verified inventory quantity sufficient for the request, checked within 24
  hours, and an approved `origin_country_code` (`US` or `CN`).

There is no public approval API. The protected Product Atelier sets these fields
after review; the importer never approves them. Importing a changed supplier
cost invalidates the retail approval through a database trigger. A changed cost
also requires a fresh cost verification. At quote, create and capture time,
the service rechecks the exact CJ variant ID and product ID, supplier cost and
CJ-verified warehouse stock at the approved origin. Factory/unverified inventory
cannot qualify. A live mismatch blocks the operation even when cached data is
still recent. Inventory is not reserved in this phase.

## Shipping and cart contracts

Verified against official documentation on 2026-11-19:

- [CJ Freight Calculation 1.1](https://developers.cjdropshipping.com/en/api/api2/api/logistic.html):
  `POST /api2.0/v1/logistic/freightCalculate`, `startCountryCode`,
  `endCountryCode: US`, `zip`, `products: [{vid, quantity}]`; response USD
  `logisticPrice`, optional taxes/clearance/total postage, method and transit estimate.
- [CJ Variant Id Inquiry 2.2](https://developers.cjdropshipping.com/en/api/api2/api/product.html):
  `GET /product/variant/queryByVid?vid=...&features=enable_inventory`, exact
  `vid`, `pid`, `variantSellPrice`, `inventories[].countryCode`,
  `verifiedWarehouse`, and `cjInventory`.
- [CJ error codes](https://developers.cjdropshipping.com/en/api/api2/standard/ps-code.html)
  and [frequency restrictions](https://developers.cjdropshipping.com/en/api/start/limit.html).

Shipping groups variants of the same product and origin together. Different
products/origins form separate shipments, avoiding assumptions about combining
supplier items into one parcel. For each shipment it selects the cheapest valid
returned method; all shipments must quote successfully. No methods means no
total. Transit information is a supplier estimate with no delivery guarantee.
This is a ZIP-based trial estimate, not a final live shipping offer.

Importer and freight requests share the existing conservative 1.35-second queue
plus a D1 reservation across Worker isolates. Temporary CJ throttling has bounded
retries and persists Retry-After cooldowns. Exhausted API points stop retries and
pause calls for one hour. Expired/revoked access tokens refresh once; auth refresh
uses a D1 lease. Raw CJ errors and freight/supplier costs stay private. Outbound
CJ endpoints are allowlisted; supplier create/pay endpoints are absent.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/commerce/session` | HttpOnly, SameSite=Strict random cookie; only its hash is stored with records |
| `POST /api/commerce/cart` | Current title/image/variant, quantity, verified retail price or blocking reason |
| `POST /api/commerce/shipping` | `{items:[{variantId,quantity}],zip}`; returns retail estimates and opaque quote ID |
| `GET /api/paypal/product-sandbox/config` | Whether the local Sandbox exercise is configured |
| `POST /api/paypal/product-sandbox/create` | `{quoteId,requestKey}`; requestKey is a UUID reused on retry |
| `GET /api/paypal/product-sandbox/status?checkoutId=...` | Session-owned status and retail total only |
| `POST /api/paypal/product-sandbox/capture` | `{checkoutId}`; verifies/reconciles the stored order |

POST APIs require exact same-origin JSON and bounded request bodies. Carts allow
1–15 distinct variant IDs and quantities 1–5; duplicate IDs are rejected.
Unknown selections remain removable in the cart. Only identifiers and quantities
persist in localStorage, using the original planning-cart storage key. ZIP input
and quote amounts are not persisted by the browser.

Quotes last ten minutes, are cached per owner/basket/ZIP/policy and are bound to
approval and price fingerprints. A changed price, policy, origin, quantity or
approval requires another quote. No public response includes supplier costs,
raw shipping charges, access tokens, customer records or internal error bodies.

## Product Sandbox verification and fulfillment boundary

The new flow uses only `https://api-m.sandbox.paypal.com`, only Sandbox-named
credentials and only allowlisted Sandbox approval URLs. Public hostnames always
reject product create/capture/status, even if the configuration flag is true.
Open the site with the same local hostname throughout the test so its private
session cookie remains available after the PayPal return.

The amount and breakdown come exclusively from a current private quote, with
live CJ checks repeated before creating an order and before a fresh capture.
PayPal redirects the test buyer back to the planning cart. This simulation uses
`NO_SHIPPING`: only the destination ZIP is stored, no street address or payer
profile is collected. It never creates merchandise orders in the real `orders`
table or submits supplier work.

The original `/shop/checkout-test/` and `/api/paypal/sandbox/*` continue to use
their fixed USD 1.00 table. Product tests use `product_sandbox_orders` and
`product_sandbox_events`, with unique quote, request, PayPal order and capture
identities. The private snapshot stores exact variants, quantities and shipping
methods. Captures verify the PayPal order ID, custom/reference IDs, single
completed capture, USD currency and exact amount. Only minimal capture evidence
is stored; raw PayPal payer responses are discarded.

Durable leases and operation tokens protect concurrent actions. Stable PayPal
Request IDs protect retries. Capture always queries the existing PayPal order
first; a completed payment is reconciled without another POST, including after
quote expiry. Ambiguous responses wait at least 20 seconds before retry;
unverified identities/amounts require manual review. New capture POSTs stop after
the conservative six-hour Orders idempotency window. Never start a replacement
payment for an ambiguous result.

See [PayPal Orders](https://developer.paypal.com/api/orders/v2) and
[Orders capture idempotency](https://developer.paypal.com/serversdk/php/api-endpoints/orders/capture-order/).

`fulfillment.js` validates a future US shipping address and prepares a disabled
draft only for a paid live customer order. The existing `orders`, `order_items`
and `fulfillment_attempts` are retained. The new fulfillment job/history/tracking
tables add a unique per-order idempotency key, exact variant snapshots, shipping
address/method, CJ reference, status, retry history and tracking. Sandbox orders
cannot become fulfillment drafts. The supplier create/pay functions always
throw; no flag can activate them.

## Verification commands

Run build-dependent Python checks sequentially:

```powershell
node --test tests/*.test.mjs
python build.py
python test_site_seo.py
python test_affiliate_manager.py
python test_storefront.py
python test_independent_shop.py
```

The new tests apply every migration to independent in-memory SQLite databases.
Their synthetic approved products, shipping rates and mocked CJ/PayPal calls
exist only in `tests/`; production code has no fixture switch or approval bypass.
They cover pricing/rounding, stock/approval gates, multi-product shipping,
token refresh, shared throttling, malformed/unavailable freight, hostile input,
session isolation, changed/expired quotes, exact captures, concurrent and repeated
payments, lost create/capture responses, preserved $1 constraints, inactive
imports and disabled supplier operations.

For static-only preview, `python -m http.server 8000 --directory dist` still works,
but commerce APIs require Wrangler. Historical generated output and Wrangler
state should not be included in a source commit. The local QA database used in
this update contains a clearly named inactive QA fixture; it is not an import
or product approval.

## Required before live selling

Independently verify production catalog synchronization and migration state;
configure Access for the Product Atelier and complete real product/warehouse reviews;
validate freight on real approved products and full addresses; implement final
tax/landed-cost rules, inventory reservations and quote revalidation; review
actual processing fees, margin, delivery/returns terms and product compliance.

Then implement a separately reviewed live PayPal flow with verified webhooks,
reconciliation/refunds and private order ownership; customer address validation,
encryption/access controls and retention/deletion rules; authenticated order
operations; supplier-side idempotency/reconciliation and reconciliation before
any ambiguous retry; CJ creation/payment, tracking/webhooks, notifications,
monitoring and support. Live payment and supplier enablement require explicit
approval and a separate deployment.

## Source file inventory

Created:

- `src/cj-client.js`: shared CJ authentication, allowlisted requests and throttling.
- `src/cj-shipping.js`: approved cart projections, live variant checks and private freight quotes.
- `src/retail-pricing.js`: configurable integer-cent retail policy and complete basket pricing.
- `src/commerce-security.js`, `src/commerce-api.js`: private session ownership, input bounds and routing.
- `src/product-sandbox.js`: separate product Sandbox create, capture, status and reconciliation.
- `src/fulfillment.js`: validated disabled fulfillment drafts and unconditional supplier action guards.
- `migrations/0005_product_commerce_foundations.sql`: additive commerce/fulfillment data model.
- `static/assets/commerce-cart.js`: current product information, quantities, estimates and local test controls.
- `dev.py`, `examples/dev.vars.example`: source watcher/local Worker command and configuration example.
- `tests/helpers/d1.mjs`: isolated SQLite databases and synthetic fixtures.
- `tests/retail-pricing.test.mjs`, `tests/cj-shipping.test.mjs`,
  `tests/product-sandbox.test.mjs`, `tests/fulfillment.test.mjs`,
  `tests/cj-import.integration.test.mjs`: pricing, freight, payment and importer coverage.
- `COMMERCE-DEVELOPMENT.md`: setup, contracts, verification and remaining work.

Modified:

- `src/index.js`: routes to the new modules.
- `src/cj-sync.js`: shared CJ client and cost-verification provenance; imported records stay inactive.
- `src/commerce-math.js`: exact BigInt intermediate retail arithmetic.
- `src/cart-readiness.js`: applies the same supplier/retail/inventory approval checks.
- `src/paypal-sandbox.js`: exports its Sandbox-only request helper and supports order reconciliation GETs;
  the existing $1 flow, amount and constraints are preserved.
- `templates/store_cart_preview.html`, `templates/base.html`: cart summary, ZIP form and asset loading.
- `static/assets/cart-preview.js`, `static/assets/cart-preview.css`: retain catalog selectors, move cart
  rendering into the new script and add responsive neutral styling.
- `tests/cart-readiness.test.mjs`: verifies the strengthened approval contract.
- `wrangler.jsonc`: new product Sandbox flag defaults to false.
- `.gitignore`, `README.md`: local secrets/state exclusions and current development documentation.

## Foundation-stage verification (before Product Atelier)

See [ADMIN-PRODUCTS.md](ADMIN-PRODUCTS.md) for the newer 80-test dashboard results.

- All 64 Node tests passed, including the original fixed-$1 Sandbox suite.
- Python build and all four existing Python integration scripts passed.
- Final migration files applied successfully to a fresh isolated Wrangler D1 store;
  SQLite tests also verified constraints, existing $1 records and cost approval invalidation.
- Real local Wrangler HTTP checks passed for health, catalog, static cart assets,
  disabled product Sandbox configuration and an inactive QA cart selection.
- The watcher rebuilt after both adding and removing a temporary source asset.
- Frontend JavaScript syntax, Python syntax and `git diff --check` passed.
- Desktop/mobile visual review could not run: browser access was unavailable and
  Computer Use reported that Microsoft Edge access was not approved.
- Production catalog status could not be retrieved. Production synchronization
  remains unverified. No remote migration, sync, credential change or deployment ran.
- New CJ freight and product PayPal flows use mocked integrations in automated
  tests. No real product was approved, no fresh PayPal buyer transaction was made,
  and no supplier order was submitted or paid.
