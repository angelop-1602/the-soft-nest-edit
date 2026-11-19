# Product Atelier: secure product administration

The dashboard is served by the Worker at `/admin/products/`. It is deliberately
absent from generated public HTML and the sitemap. `/admin/` remains the Pages
CMS shortcut. Public home, Journal and storefront layouts are unchanged.

The dashboard provides catalog search and pagination, review-state filters,
private supplier costs, individual variant reviews, manual retail pricing,
profit estimates, supplier checks, destination-specific US freight checks,
approve/reject/disable decisions and immutable history. Customer checkout and
supplier purchases remain disabled. Approval permits verified retail display
and the existing local product Sandbox exercise; it does not enable live sales.

## Local administrator development

Apply pending migrations to the local store, then start the dedicated local entry:

```powershell
npx wrangler d1 migrations apply softnest-orders-sandbox --local --persist-to .local/worker-state
python dev.py --admin --port 8791
```

If that port already serves your current preview, use `--port 8792` instead.
Open `http://127.0.0.1:8791/admin/products/login`, copy the temporary code from
`.local/admin/login-code.txt` into the sign-in form, then open `/admin/products/`.
The code and signing key rotate each time `--admin` starts. The code is not
printed to logs or embedded in public HTML. The signed HttpOnly, SameSite=Strict
cookie expires after an hour. Sign out clears it.

`python dev.py --port 8791` still uses the normal production entry, which requires
Cloudflare Access. There is **no development-authentication flag in that entry**.
Local authentication exists only in `src/local-admin-worker.js`, selected by a
generated `.local/admin/wrangler.jsonc`. It requires the exact configured HTTP
`127.0.0.1` origin plus fresh generated secrets and rejects every other origin.
Production never imports that local entry. Do not deploy the generated config.
Run one local administrator instance at a time. Restart `--admin` after changing
the original `.dev.vars`, so its private configuration copy refreshes.

The local configuration copies your existing `.dev.vars` into an ignored private
directory and adds temporary local authentication settings there. It never edits
the original credentials. All local configurations share `.local/worker-state`;
remote D1 and the original `.wrangler/state` are separate. Only the local database
was migrated during implementation. No real product was automatically approved.
`/admin/products/login` is a development-only route and is unavailable in production.

## Cloudflare Access configuration

Access is **not assumed to be configured**. Until these settings are provided,
the production entry rejects dashboard and administrator API requests.

1. In Cloudflare Zero Trust, create a self-hosted application with public
   hostname/path destinations for `thesoftnestedit.online/admin/products` and
   `thesoftnestedit.online/api/admin`. Include their subpaths. Keep these
   destinations in the **same Access application**, so both receive its AUD.
   The current Access public-destination model covers subpaths; verify the
   exact path, trailing slash and `/index.html` cases as part of staging checks.
   Do not place the whole `/admin/` Pages CMS shortcut behind a new path rule.
2. Add an **Allow** policy for your small list of explicit administrator email
   identities. Configure the intended identity provider and MFA. Do not use an
   Everyone rule, a Bypass rule or a rule admitting all OTP users. Use a one-hour
   application/policy session. This Worker rejects tokens lasting over 24 hours.
3. Copy your team origin (for example `https://your-team.cloudflareaccess.com`)
   and the application's Audience tag. Configure these Worker bindings:

   ```text
   CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
   CF_ACCESS_AUD=<the application's AUD tag>
   ADMIN_EMAIL_ALLOWLIST=["the-actual-authorized-identity@example.com"]
   ```

   Replace the example identity. The allowlist must be a JSON array of 1–20
   exact email addresses. The Worker independently enforces it using the signed
   application's email claim. A user passing some other Access policy cannot
   bypass this allowlist. Use separate applications/AUDs for staging and production.
4. Ensure the custom domain is routed through Cloudflare and that the Access
   application protects both destination paths. Retain Worker-first routing for
   `/admin/products`, `/admin/products/*`, and `/api/*` in Wrangler. No private
   dashboard file is placed under `dist/`; there is no static alternate URL.
5. Verify a signed-in allowlisted administrator can load both the page and API.
   Verify a signed-out browser and an unlisted identity are denied. Check that
   ordinary `/admin/` and public pages still behave as before.

The Worker reads `Cf-Access-Jwt-Assertion`, pins RS256, and verifies its RSA
signature against the configured team's `/cdn-cgi/access/certs` keys. It checks
issuer, audience, expiration, issued-at, not-before, application token type,
subject and the exact email allowlist. It ignores email-only authentication
headers, token-supplied signing URLs and local development cookies. Unknown or
invalid configuration fails closed. Public keys cache for five minutes; an
unknown key can refresh after a one-minute cooldown. Key lookup/network failure
denies authentication, without returning private diagnostics.

POST actions also require exact same-origin JSON and `X-Softnest-Admin: 1`.
Bodies are bounded to 24 KB. Private pages/APIs use no-store, noindex/nofollow,
frame denial, a restrictive CSP and no-referrer. Admin JSON contains supplier
costs intentionally; public APIs do not. No API key, JWT, CJ token or payment
profile is returned or recorded in history.

Official references checked for this implementation:

- [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Access application setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Public destinations and path coverage](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/)
- [Worker-first static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [CJ variant and inventory fields](https://developers.cjdropshipping.com/en/api/api2/api/product.html)
- [CJ freight trial fields](https://developers.cjdropshipping.com/en/api/api2/api/logistic.html)

Protected routes:

| Route | Purpose |
| --- | --- |
| `GET /api/admin/session` | Verified identity and effective policy/revision |
| `GET /api/admin/products?q=&filter=&page=` | Search, status filters and 12-product pages |
| `GET /api/admin/products/{pid}` | Product, variants, verification metadata and history |
| `POST /api/admin/products/{pid}/review` | Product description, quality and restrictions |
| `POST /api/admin/products/{pid}/variants/{vid}/review` | Exact variant review |
| `POST /api/admin/products/{pid}/variants/{vid}/verify` | Current supplier cost/stock/origin check |
| `POST /api/admin/products/{pid}/variants/{vid}/shipping` | ZIP/quantity-specific freight trial |
| `POST /api/admin/products/{pid}/variants/{vid}/price-preview` | Server-calculated profit preview |
| `POST /api/admin/products/{pid}/variants/{vid}/price` | Audited price/exception save |
| `POST /api/admin/products/{pid}/decision` | Product/variant approve, reject or disable |
| `POST /api/admin/policy` | Policy revision and approval invalidation |

## Review a product

1. Select the product. Review its photo and write an accurate plain-text
   description of at least 30 characters. Complete the quality checklist,
   document dimensions/materials and return restrictions, and mark return
   eligibility and restricted-product review. Supplier notes and defects/
   complaints stay private. Save the quality review.
2. For the exact variant, select US or CN and refresh the supplier check. The
   server queries the existing CJ client with `features=enable_inventory` and
   verifies `vid`, `pid`, USD `variantSellPrice`, origin, `verifiedWarehouse=1`
   and integer `cjInventory`. Factory/unverified stock does not qualify. A
   verified zero is shown as zero and cannot be approved. Missing fields show
   Not verified; errors clear freshness and block selling. The existing shared
   request queue, D1 reservations, token recovery and quota handling apply.
3. Review the exact variant mapping and options. If refresh changed the SKU or
   options, redo this checklist. Supplier changes do not silently retain an old
   specifications approval. Size/material and return review are explicitly human
   reviews, not invented supplier certifications.
4. Check a real US ZIP. A one-unit check is required for baseline approval.
   Quotes store variant, origin, ZIP, quantity, methods, cost/specification
   fingerprint, checked time and expiry. All returned methods and actual USD
   charges are visible privately. Ranges are supplier estimates, not guarantees.
   A newer failed check supersedes an older success for that same destination.
   A failure for one ZIP does not claim that every US destination is unsupported.
5. Preview profit, select a retail price and save it. Pricing uses the current
   verified supplier cost and the current policy; browser-supplied costs and
   internal active/timestamp fields cannot be written. Pricing alone does not
   activate the variant. Complete any remaining checks, then approve that variant
   or all variants in the product. Every selected variant must pass.

Approvals require a valid image, title, description, quality/returns/restriction
reviews, supplier SKU/mapping, positive recent cost, current sufficient warehouse
stock, reviewed pricing, origin and a fresh matching one-unit shipping check.
Cost and inventory freshness last 24 hours; shipping checks last ten minutes.
The retail review lasts at most a year. Checkout repeats current approval and
pricing checks and obtains its own ZIP/quantity-specific quote. A sample ZIP
check is never treated as universally verified US shipping.

Reject or disable with a reason of at least ten characters. These actions work
without pricing/shipping approval and block new attempts immediately. Review
states are `pending_review`, `needs_verification`, `approved`, `rejected` and
`disabled`. Product scope affects every variant; variant scope affects only the
selected variants. Product activation follows explicitly approved variants.

Edits use product and variant versions plus a policy revision. A D1 batch first
claims an atomic version guard, conditionally applies every write, and records
the authenticated identity, before/after changes, reason and server time. A stale
or concurrent edit returns 409 and requires a reload. Bulk actions support up to
the importer's 100 variants, with JSON-backed guards and set-based audit inserts
to stay within D1 binding/query limits. History displays the latest 50 events.

## Pricing policy and explicit exceptions

The protected policy editor supports target net margin, minimum markup, fixed
and variable payment fees, per-item and shipping buffers, and a total ceiling.
All amounts are integer USD cents; rates use basis points (100 = 1%). Markup
applies to supplier cost plus the per-item buffer. The minimum retail is the
larger of the markup floor and the existing margin/fee floor. Fixed processing
and shipping buffers are allocated to the separately displayed retail shipping
charge, preserving the prior commerce math.

Profit estimates show supplier freight, retail shipping, payment fees, buffers,
net profit and net margin separately. They require current cost and a fresh
shipping check. They exclude taxes, refunds, duties beyond the returned freight
charges, and unmodeled returns costs. Configure actual fees and adequate buffers.

Prices below policy are rejected by default. An administrator can first enable
an audited exception policy specifying the lowest allowed net margin and a
maximum duration of 1–168 hours. The price form then requires a separate explicit
acknowledgment, a reason of at least 20 characters, a margin at or above that
exception floor and an expiration. Even an exception must cover the effective
fees and cost buffers. It binds to the exact cost, price and complete base policy.
The actor and before/after exception are audited. Expiry, cost, price or policy
changes invalidate it. Mixed baskets retain per-item exception floors while
shipping keeps the standard policy. Exceptions never enable live checkout.

The D1 policy overrides `RETAIL_PRICING_POLICY` after the first protected save;
the environment value remains the initial policy fallback. Saving a new policy
generates a version and invalidates all existing catalog approval/pricing reviews.
It cannot silently reinterpret old approvals under a cheaper policy.

## Migrations and fixture isolation

New additive migrations:

- `0006_product_administration.sql`: review metadata, immutable fixture flags,
  shipping/supplier checks, policy settings, mutation guards, immutable audit
  history and supplier/content invalidation triggers.
- `0007_catalog_review_guards.sql`: product version changes on newly imported
  variants, review/destination indexes and safe fixture marking guards.

No checkout/order/payment records are deleted or relaxed. Existing active flags
are reset for the new explicit review workflow; existing pricing stays recorded
but does not count as a completed quality/shipping approval. The known local QA
product is identified during migration and permanently flagged. Runtime checks
and database guards use that immutable flag, not its display name. An admin
cannot approve it, unflag it or enable a child variant for sale. New isolated
fixtures must be inserted with `fixture_only=1` and active=0; no admin UI can
remove fixture isolation. Database owner access is still an administrative trust
boundary and should remain restricted.

For the current migration-managed local database:

```powershell
npx wrangler d1 migrations apply softnest-orders-sandbox --local --persist-to .local/worker-state
```

For an older database initialized by manually executing SQL rather than Wrangler
migration history, inspect its schema/history first. If 0001–0005 are present and
0006/0007 are absent, apply only these new files to that intended local state:

```powershell
npx wrangler d1 execute softnest-orders-sandbox --local --file migrations/0006_product_administration.sql
npx wrangler d1 execute softnest-orders-sandbox --local --file migrations/0007_catalog_review_guards.sql
```

Those last commands use the older `.wrangler/state` default; add the intended
`--persist-to` if different. Do not replay ALTER migrations already applied.

## Tests and verification

Stop active dev servers before the manual full build/integration suite, because
the original generator recreates `dist/`. The watcher itself stages builds safely.

```powershell
node --test tests/*.test.mjs
python build.py
python test_site_seo.py
python test_affiliate_manager.py
python test_storefront.py
python test_independent_shop.py
```

Authentication tests create isolated RSA keys and signed application tokens.
Business tests use fresh SQLite databases, explicit synthetic review records,
and mocked CJ responses; no runtime fixture bypass is shipped. They cover denied
page/API aliases, token validation, allowlists, CSRF, local/production isolation,
approval preconditions, permanent fixture restrictions, private/public projection,
auditing, concurrent edits, 100-variant approvals, margin exceptions, source-data
invalidation, destination-specific shipping supersession, and the existing
Sandbox/CJ importer suites. The development sign-in and private catalog reads
were also exercised against real local Wrangler/D1.

Desktop/tablet/mobile visual review was blocked: browser access was unavailable
and Computer Use reported that Microsoft Edge access was not approved. Responsive
CSS and accessible native form controls are implemented; visual QA remains to be
done in an approved browser. Production Access/IdP configuration and live Access
tokens remain untested. No real product approval or payment was performed.

Final verification: all **80 Node tests** passed, along with the build and all
four Python integration scripts in an isolated source copy. Migrations 0006/0007
applied to local D1; migration tests preserved existing order/payment records.
Actual local HTTP checks verified sign-in, unauthorized denial, private catalog
reads and the fixture flag. One protected real-CJ mirror refresh succeeded and
its one-unit US ZIP trial returned three available methods, while the product
remained inactive. The production dry-run bundle built successfully and excluded
local authentication code. No remote migration or deployment was executed.

## Staging commands — only after approval

These commands are provided for the requested future staging deployment. They
have **not** been executed. The example config uses a separate Worker/database,
no cron, disabled payment flags, and the production entry with Access validation.

```powershell
Copy-Item examples/wrangler.staging.jsonc.example wrangler.staging.jsonc
npx wrangler d1 create softnest-orders-staging
```

Set `database_id` in `wrangler.staging.jsonc` to the newly returned staging ID
(never the production ID). Confirm ownership/routing for
`staging.thesoftnestedit.online`. Create its Access application with the two
private path destinations and the intended identity allowlist. Then configure:

```powershell
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN --config wrangler.staging.jsonc
npx wrangler secret put CF_ACCESS_AUD --config wrangler.staging.jsonc
npx wrangler secret put ADMIN_EMAIL_ALLOWLIST --config wrangler.staging.jsonc
npx wrangler secret put CJDROPSHIPPING_API --config wrangler.staging.jsonc
npx wrangler secret put RETAIL_PRICING_POLICY --config wrangler.staging.jsonc
npx wrangler d1 migrations apply softnest-orders-staging --remote --config wrangler.staging.jsonc
node --test tests/*.test.mjs
python build.py
npx wrangler deploy --config wrangler.staging.jsonc --dry-run --outdir .local/staging-build
npx wrangler deploy --config wrangler.staging.jsonc
```

Secret commands prompt securely; do not paste secrets into command arguments or
documentation. Do not configure local session keys on staging. The staging
database is intentionally empty until a separately authorized import; the sample
has no sync cron. It does not inherit the production DB or real payment settings.
If scheduled staging imports are added later, coordinate CJ account rate/points
limits across environments. Production rollout remains a separate approval.

## Changed files

Created: `src/admin-auth.js`, `src/admin-products-api.js`,
`src/admin-products-data.js`, `src/admin-products-actions.js`,
`src/admin-cj-verification.js`, `src/admin-products-page.js`,
`src/local-admin-worker.js`, `static/assets/admin-products.js`,
`static/assets/admin-products.css`, `static/assets/admin-local-login.js`,
the two migrations above, `tests/helpers/admin.mjs`,
`tests/admin-auth.test.mjs`, `tests/admin-products.test.mjs`,
`tests/admin-migrations.test.mjs`,
`examples/wrangler.staging.jsonc.example`, and this document.

Modified: `src/index.js`, `src/retail-pricing.js`, `src/cj-shipping.js`,
`src/cart-readiness.js`, `src/product-sandbox.js`, `wrangler.jsonc`, `dev.py`,
`tests/helpers/d1.mjs`, `tests/cart-readiness.test.mjs`,
`tests/retail-pricing.test.mjs`, `tests/cj-shipping.test.mjs`,
`examples/dev.vars.example`, `README.md`, and `COMMERCE-DEVELOPMENT.md`.
The three temporary-copy Python integration scripts also exclude local keys,
environment files and Worker databases from their test copies.

Remaining operational work: configure and test real Access identities on staging;
perform approved browser/device QA; complete human review and reliable supplier
checks for actual products. Audit export/retention, role separation, monitoring,
inventory reservations, taxes/refunds and real order/fulfillment operations remain
future work. Existing disabled live-payment and CJ purchase boundaries remain.
