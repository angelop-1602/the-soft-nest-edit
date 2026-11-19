import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';

const path = 'https://thesoftnestedit.online/api/paypal/sandbox/diagnostic';
const good = {
  PAYPAL_MODE: 'sandbox', PAYPAL_SANDBOX_CHECKOUT_ENABLED: 'true',
  PAYPAL_SANDBOX_CLIENT_ID: 'SANDBOX-ID-FOR-TEST',
  PAYPAL_SANDBOX_CLIENT_SECRET: 'PRIVATE-SECRET-FOR-TEST',
  DB: { prepare() { return {}; } }
};

test('diagnostic confirms ready without disclosing any credential value', async () => {
  const res = await worker.fetch(new Request(path), good);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  const body = await res.text();
  const data = JSON.parse(body);
  assert.equal(data.configured, true);
  assert.equal(data.checks.sandboxClientSecretAvailable, true);
  assert.equal(body.includes('PRIVATE-SECRET-FOR-TEST'), false);
  assert.equal(body.includes('SANDBOX-ID-FOR-TEST'), false);
});

test('diagnostic identifies a missing runtime Secret without exposing it', async () => {
  const env = { ...good };
  delete env.PAYPAL_SANDBOX_CLIENT_SECRET;
  const res = await worker.fetch(new Request(path), env);
  const data = await res.json();
  assert.equal(data.configured, false);
  assert.equal(data.checks.sandboxClientSecretAvailable, false);
  assert.equal(data.checks.d1BindingAvailable, true);
});

test('diagnostic rejects state-changing methods', async () => {
  const res = await worker.fetch(new Request(path, { method: 'POST' }), good);
  assert.equal(res.status, 405);
});
