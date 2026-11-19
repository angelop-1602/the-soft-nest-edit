import { catalogStatus, syncCjCatalog } from './cj-sync.js';

/** The Soft Nest Edit Worker — static storefront plus server-only APIs. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
