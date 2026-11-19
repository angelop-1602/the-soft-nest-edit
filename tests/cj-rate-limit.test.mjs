import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCjRateLimit } from '../src/cj-sync.js';

test('CJ HTTP 429 without points data is a temporary rate-limit error', () => {
  assert.equal(classifyCjRateLimit(429, null), 'CJ_RATE_LIMITED');
  assert.equal(classifyCjRateLimit(429, { code: 1600200, message: 'Too many requests' }), 'CJ_RATE_LIMITED');
  assert.equal(classifyCjRateLimit(200, { code: 406, message: 'Too frequent' }), 'CJ_RATE_LIMITED');
});

test('429 due to exhausted points is not retried', () => {
  assert.equal(classifyCjRateLimit(429, { code: 429, pointsInfo: {remaining: 0} }), 'CJ_POINTS_EXHAUSTED');
  assert.equal(classifyCjRateLimit(429, { code: 429, message: 'Insufficient API points' }), 'CJ_POINTS_EXHAUSTED');
  assert.equal(classifyCjRateLimit(200, { code: 1600201 }), 'CJ_POINTS_EXHAUSTED');
  assert.equal(classifyCjRateLimit(200, { code: 16900500 }), 'CJ_POINTS_EXHAUSTED');
});

test('normal and unrelated errors are not misclassified', () => {
  assert.equal(classifyCjRateLimit(200, { code: 200, result: true }), null);
  assert.equal(classifyCjRateLimit(401, { code: 1600001, result: false }), null);
  assert.equal(classifyCjRateLimit(500, null), null);
});
