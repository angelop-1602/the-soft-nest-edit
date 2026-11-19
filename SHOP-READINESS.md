# From storefront to online shop

Reviewed against the local repository on 2026-11-19. This is a code review of
capabilities, not a verification of production accounts, inventory, or operations.

## What exists

- Static shop, collection pages, product detail pages, saved pieces, and a
  GitHub-authenticated Pages CMS content editor.
- Collection icon filters, product search, featured/name/price sorting, and an
  available-to-order filter on the shop landing page.
- Separate affiliate recommendations, shop listings, and staged CJ supplier data.
- Scheduled CJ catalog importing, a planning cart, and a read-only price/stock
  readiness check.
- A PayPal sandbox demonstration for a fixed USD 1.00 amount.
- D1 tables for orders, payment-event deduplication, and fulfillment attempts.
  These tables are a foundation; the live workflow is not implemented.

The 10 Markdown shop listings are currently drafts. No approved store products
are published. The available-to-order filter uses the existing validated
price/checkout/shipping/returns gate; it is not a new live inventory guarantee.
The current readiness API always disables customer checkout, PayPal capture,
and CJ order submission.

## Launch priorities

| Priority | Missing capability | Customer outcome / completion criterion |
| --- | --- | --- |
| 1 | A small approved catalog | Real photos, useful dimensions/materials, variant choices, verified prices, stock, shipping destinations, delivery estimates, and return terms for each published piece. |
| 2 | One authoritative catalog | Map storefront items and variants to approved D1/CJ records so display, cart, stock checks, pricing, and fulfillment refer to the same products. Keep supplier cost and sourcing data private. |
| 3 | A customer cart and checkout | Customers can select variants, change quantity, remove items, enter a delivery address, and see a server-calculated total. Recheck current price and stock before taking payment. The existing planning cart does not complete a purchase. |
| 4 | Shipping and complete totals | Quote the actual destination and verified origin, show the shipping method and delivery estimate, and include applicable tax handling and all charges before payment. Existing freight math helpers are not a connected checkout quote. |
| 5 | Production payments and order records | Use a separate live payment flow, server-owned amounts, verified payment webhooks, duplicate protection, durable order state, and reconciliation for interrupted or uncertain payment outcomes. A browser return page alone must not mark an order paid. |
| 6 | Fulfillment and delivery tracking | Create the correct supplier order after verified payment, handle supplier payment and failures, reconcile retries without duplicate orders, and send tracking updates. Start with an explicit manual fulfillment process if needed. |
| 7 | Customer service and store operations | Order confirmation and shipping emails, an order-status page, a private order-management screen, cancellation/refund tools, support contact, and clear delivery/return/refund policies. Guest checkout can be the first release. |
| 8 | Operational verification | Test declined/canceled payments, stock changes, duplicate or late callbacks, shipping failures, refunds, and supplier outages. Monitor failed payments/orders, restrict staff access, and establish customer-data retention and recovery procedures. |

## Improvements after the first complete purchase flow

Genuine product reviews, related items, useful material/color/size filters,
back-in-stock messages, and optional customer accounts can follow the initial
launch. Add a "Most popular" order only after there is real sales or engagement
data and a defined ranking period. Until then, use editorial "Featured" ordering.

The next milestone should be a small approved collection plus a complete test
order: product selection, shipping quote, payment verification, order creation,
fulfillment, customer confirmation, and a tested refund path.

## Primary integration references

- [PayPal production setup](https://developer.paypal.com/api/rest/production/)
  distinguishes production credentials/hosts from sandbox setup.
- [PayPal webhooks](https://developer.paypal.com/api/rest/webhooks/) describes
  event receipt and verification, including delivery retries.
- [CJ API interface list](https://developers.cjdropshipping.com/en/api/api2/)
  lists stock, warehouse, freight calculation, order creation/payment, and tracking
  capabilities. These still need to be connected to the store's order lifecycle.

This UI change does not enable payments, publish draft products, deploy the site,
or run remote migrations or supplier operations.
