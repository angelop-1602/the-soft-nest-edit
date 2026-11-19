/** Authenticated Worker-only shell. It is intentionally absent from public dist/. */
export const dashboardPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="color-scheme" content="light">
<title>Product Atelier | The Soft Nest Edit</title>
<link rel="icon" href="/assets/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display:ital@0;1&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/admin-products.css"><script src="/assets/admin-products.js" defer></script></head>
<body><a class="skip-link" href="#catalog">Skip to products</a>
<header class="admin-header"><a href="/" class="admin-brand"><span class="brand-mark" aria-hidden="true">✳</span><span>THE SOFT NEST<small>E D I T / PRODUCT ATELIER</small></span></a>
<nav aria-label="Administrator"><a href="/admin/">Pages CMS ↗</a><a href="/shop/cart-preview/">Planning cart ↗</a><a id="admin-signout" href="/cdn-cgi/access/logout">Sign out</a></nav></header>
<main class="admin-shell"><div class="admin-intro"><div><p class="eyebrow">A CONSIDERED COLLECTION</p><h1>The product <em>atelier.</em></h1>
<p>Review every detail. Approve with confidence.</p></div><div class="admin-identity"><span class="private-badge">PRIVATE WORKSPACE</span><p id="admin-identity">Verifying your administrator session…</p><p class="small">Live payments & supplier purchases disabled</p></div></div>
<p id="admin-notice" class="notice" role="status" aria-live="polite">Loading your catalog…</p>
<div class="admin-workspace"><section id="catalog" class="catalog-panel" aria-labelledby="catalog-title">
<div class="panel-heading"><div><p class="eyebrow">YOUR COLLECTION</p><h2 id="catalog-title">Imported products</h2></div><button id="catalog-refresh" class="button secondary" type="button">Refresh</button></div>
<form id="catalog-search" class="search-form"><label for="product-query">Search product, SKU or CJ ID</label><div class="search-row"><input id="product-query" type="search" maxlength="100" placeholder="Find a considered piece…"><button class="button" type="submit">Search</button></div>
<label for="product-filter">Review status</label><select id="product-filter"><option value="all">All products</option><option value="pending_review">Pending review</option><option value="needs_verification">Needs verification</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="disabled">Disabled</option><option value="out_of_stock">Out of stock</option><option value="missing_pricing">Missing pricing</option><option value="shipping_unavailable">Shipping unavailable / not verified</option></select></form>
<p id="catalog-count" class="small" role="status"></p><div id="product-list" class="product-list"></div>
<div class="pagination"><button id="page-prev" class="button secondary" type="button">Previous</button><span id="page-label"></span><button id="page-next" class="button secondary" type="button">Next</button></div></section>
<section id="product-detail" class="detail-panel" aria-label="Product review"><div class="empty-detail"><span aria-hidden="true">✳</span><h2>A place for every detail.</h2><p>Select a product to review its variants, pricing and supplier verification.</p></div></section></div>
<details class="policy-panel" id="pricing-policy"><summary>Pricing policy <span>Margin, markup, fees & exceptions</span></summary><div id="policy-editor"></div></details>
<footer class="admin-footer">THE SOFT NEST EDIT <span>Thoughtful review. Safer commerce.</span></footer></main></body></html>`;
