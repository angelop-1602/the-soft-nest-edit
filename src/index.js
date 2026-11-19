import { handleCartPreview } from './cart-preview.js';
import { handleCheckoutReadiness } from './cart-readiness.js';
import { catalogStatus, syncCjCatalog } from './cj-sync.js';
import { handleSandboxPaypal } from './paypal-sandbox.js';
import { getCatalogPreview, parsePreviewPage } from './catalog-preview.js';
import { handleCommerce } from './commerce-api.js';
import { handleProductSandbox } from './product-sandbox.js';
import { handleAuthenticatedAdmin, isAdminPath } from './admin-products-api.js';

/** The Soft Nest Edit Worker — static storefront plus server-only APIs. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isAdminPath(url.pathname)) return handleAuthenticatedAdmin(request, env);
    if (url.pathname.startsWith('/api/commerce/')) {
      return handleCommerce(request, env, url.pathname.slice('/api/commerce/'.length));
    }
    if (url.pathname.startsWith('/api/paypal/product-sandbox/')) {
      return handleProductSandbox(request, env, url.pathname.slice('/api/paypal/product-sandbox/'.length));
    }
    if (url.pathname.startsWith('/api/paypal/sandbox/')) {
      const route = url.pathname.slice('/api/paypal/sandbox/'.length);
      return handleSandboxPaypal(request, env, route);
    }
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
      }
      try {
        if (!env.DB) throw new Error('Missing D1 binding');
        const row = await env.DB.prepare('SELECT 1 AS connected').first();
        return Response.json(
          { ok: row?.connected === 1, database: 'connected' },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      } catch {
        return Response.json(
          { ok: false, database: 'unavailable' },
          { status: 503, headers: { 'Cache-Control': 'no-store' } }
        );
      }
    }
    if (url.pathname === '/api/catalog/status') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
      }
      try {
        if (!env.DB) throw new Error('Missing D1 binding');
        return Response.json(await catalogStatus(env.DB), {
          headers: { 'Cache-Control': 'no-store' }
        });
      } catch {
        return Response.json({ error: 'Catalog sync database not initialized' }, {
          status: 503, headers: { 'Cache-Control': 'no-store' }
        });
      }
    }
    // Server-owned verification check. Never triggers payment or fulfillment.
    if (url.pathname === '/api/checkout/readiness') {
      return handleCheckoutReadiness(request, env);
    }
    // Public, read-only CJ planning-cart API. No prices or purchase actions.
    if (url.pathname === '/api/catalog/variants') {
      return handleCartPreview(request, env, 'variants');
    }
    if (url.pathname === '/api/catalog/cart') {
      return handleCartPreview(request, env, 'cart');
    }
    if (url.pathname === '/api/catalog/preview') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', {
          status: 405, headers: { 'Allow': 'GET', 'Cache-Control': 'no-store' }
        });
      }
      const page = parsePreviewPage(url.searchParams.get('page'));
      if (page === null) {
        return Response.json({ error: 'Invalid page number' }, {
          status: 400, headers: { 'Cache-Control': 'no-store' }
        });
      }
      try {
        if (!env.DB) throw new Error('D1 missing');
        return Response.json(await getCatalogPreview(env.DB, page), {
          headers: {
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
            'Referrer-Policy': 'no-referrer'
          }
        });
      } catch {
        return Response.json({ error: 'Catalog preview unavailable' }, {
          status: 503, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
        });
      }
    }
    // Do NOT expose API keys, token storage, supplier cost, or an order API.
    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },

  // Runs every six hours, as configured in wrangler.jsonc. No orders are placed.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(syncCjCatalog(env));
  }
};
