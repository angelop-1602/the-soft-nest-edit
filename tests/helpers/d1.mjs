import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

/** Real SQLite constraint/transaction coverage with the small D1 API we use. */
export function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  function statement(sql, params = []) {
    return {
      sql,
      params,
      bind(...values) {
        if (values.length > 100) throw new Error('D1 bound parameter limit exceeded');
        return statement(sql, values);
      },
      async first() {
        return sqlite.prepare(sql).get(...params) || null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...params) };
      },
      async run() {
        const r = sqlite.prepare(sql).run(...params);
        return { meta: { changes: Number(r.changes) } };
      }
    };
  }
  let transaction = Promise.resolve();
  return {
    sqlite,
    prepare: statement,
    async batch(statements) {
      const previous = transaction;
      let release;
      transaction = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      } finally {
        release();
      }
    }
  };
}
export const policy = {
  version: 'test-v1',
  processingFixedCents: 49,
  processingVariableBps: 349,
  targetMarginBps: 3000,
  perItemBufferCents: 200,
  shippingBufferCents: 200,
  maxTotalCents: 50000
};
export function fixtureEnv() {
  return {
    DB: database(),
    RETAIL_PRICING_POLICY: JSON.stringify(policy),
    CJDROPSHIPPING_API: 'MOCK-CJ-KEY',
    PAYPAL_MODE: 'sandbox',
    PAYPAL_SANDBOX_CHECKOUT_ENABLED: 'true',
    PRODUCT_SANDBOX_CHECKOUT_ENABLED: 'true',
    PAYPAL_SANDBOX_CLIENT_ID: 'MOCK-SANDBOX-ID',
    PAYPAL_SANDBOX_CLIENT_SECRET: 'MOCK-SANDBOX-SECRET'
  };
}
export async function seed(
  env,
  { vid = 'TEST-V1', pid = 'TEST-P1', origin = 'US', active = 1, cost = 1000, retail = 2500 } = {}
) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO cj_products(id,cj_product_id,title,image_url,active,review_state) VALUES(?,?,?,?,?,?)`
  )
    .bind(
      'cj:' + pid,
      pid,
      'Fixture cushion - automated tests only',
      'https://example.test/cushion.jpg',
      active,
      active ? 'approved' : 'pending_review'
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO cj_variants(id,product_id,cj_variant_id,options_json,supplier_cost_cents,
    approved_supplier_cost_cents,supplier_cost_verified_at,retail_price_cents,retail_verified_at,retail_policy_version,
    inventory_quantity,inventory_verified_at,origin_country_code,active,review_state,approved_review_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      'cj-variant:' + vid,
      'cj:' + pid,
      vid,
      '{"label":"Natural linen"}',
      cost,
      cost,
      now,
      retail,
      now,
      policy.version,
      20,
      now,
      origin,
      active,
      active ? 'approved' : 'pending_review',
      active ? 0 : null
    )
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO cj_api_session(id,access_token,access_expires_ms) VALUES(1,?,?)`
  )
    .bind('MOCK-CJ-TOKEN', Date.now() + 86400000)
    .run();
  return { variantId: vid, quantity: 1 };
}
export const cookie = 'softnest-commerce=' + 'a'.repeat(64);
export const origin = 'http://localhost:8787';
export function request(
  path,
  body,
  { cookieValue = cookie, source = origin, method, headers = {} } = {}
) {
  return new Request(source + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      Cookie: cookieValue,
      ...(body === undefined ? {} : { Origin: source, 'Content-Type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}
export function cjMock(overrides = {}) {
  return async (raw, init) => {
    const url = new URL(raw);
    if (url.hostname !== 'developers.cjdropshipping.com')
      throw new Error('Unexpected external host');
    if (url.pathname.endsWith('/product/variant/queryByVid')) {
      const vid = url.searchParams.get('vid');
      if (url.searchParams.get('features') !== 'enable_inventory')
        throw new Error('Inventory feature required');
      return Response.json({
        code: 200,
        result: true,
        data: {
          vid,
          pid: 'TEST-P1',
          variantSellPrice: '10.00',
          inventories: [{ countryCode: 'US', verifiedWarehouse: 1, cjInventory: 20 }],
          ...overrides
        }
      });
    }
    if (url.pathname.endsWith('/logistic/freightCalculate'))
      return Response.json({
        code: 200,
        result: true,
        data: [
          {
            logisticName: 'Mock USPS',
            logisticPrice: '4.71',
            logisticAging: '2-5'
          }
        ]
      });
    throw new Error('Unexpected CJ endpoint');
  };
}
