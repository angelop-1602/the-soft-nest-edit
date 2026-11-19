import { catalogStatus, syncCjCatalog } from './cj-sync.js';
import { handleSandboxPaypal } from './paypal-sandbox.js';
import { getCatalogPreview, parsePreviewPage } from './catalog-preview.js';

/** The Soft Nest Edit Worker — static storefront plus server-only APIs. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // TEMPORARY: PayPal runtime binding diagnostic. No credentials or values leave the Worker.
    // Remove this route after verifying the environment, before enabling live checkout.
    if (url.pathname === '/api/paypal/sandbox/diagnostic') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: { 'Allow': 'GET' } });
      }
      const checks = {
        paypalModeIsSandbox: env.PAYPAL_MODE === 'sandbox',
        checkoutSwitchIsTrue: env.PAYPAL_SANDBOX_CHECKOUT_ENABLED === 'true',
        sandboxClientIdAvailable: typeof env.PAYPAL_SANDBOX_CLIENT_ID === 'string' && env.PAYPAL_SANDBOX_CLIENT_ID.trim().length > 0,
        sandboxClientSecretAvailable: typeof env.PAYPAL_SANDBOX_CLIENT_SECRET === 'string' && env.PAYPAL_SANDBOX_CLIENT_SECRET.trim().length > 0,
        d1BindingAvailable: Boolean(env.DB && typeof env.DB.prepare === 'function')
      };
      return Response.json({
        diagnostic: 'temporary_paypal_sandbox_runtime_check',
        configured: Object.values(checks).every(Boolean), checks
      }, { headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer'
      } });
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
