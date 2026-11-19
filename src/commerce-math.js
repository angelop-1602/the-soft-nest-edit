/**
 * Pure, server-side commerce calculations for The Soft Nest Edit.
 * No PayPal, CJ requests, payments or order creation.
 * Retail policy arguments MUST be set explicitly after merchant approval;
 * test examples are not live prices or policy defaults.
 */
export function moneyCents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/**
 * Target net margin of the final sale: (selling price - supplier - shipping -
 * fixed fees - variable fees - buffer) / selling price.
 * All inputs are integer cents or basis points. No tax is estimated.
 */
export function suggestedRetailCents({
  supplierCostCents, freightCents, processingFixedCents,
  processingVariableBps, targetMarginBps, riskBufferCents
}) {
  const cents = [supplierCostCents, freightCents, processingFixedCents, riskBufferCents];
  const bps = [processingVariableBps, targetMarginBps];
  if (!cents.every(v => Number.isSafeInteger(v) && v >= 0)
    || !bps.every(v => Number.isSafeInteger(v) && v >= 0 && v < 10000)
    || processingVariableBps + targetMarginBps >= 9500) return null;
  const fixed = cents.reduce((a, b) => a + b, 0);
  const denominator = 10000 - processingVariableBps - targetMarginBps;
  const result = Math.ceil(fixed * 10000 / denominator);
  return Number.isSafeInteger(result) && result > 0 && result <= 999999999 ? result : null;
}

const VID = /^[A-Za-z0-9_-]{1,128}$/;
/** CJ freight trial request builder. Origin must be verified from supplier/warehouse data. */
export function buildCjFreightTrial({ originCountryCode, destinationZip, items }) {
  if (!['CN', 'US'].includes(originCountryCode)
    || typeof destinationZip !== 'string' || !/^\d{5}(?:-\d{4})?$/.test(destinationZip)
    || !Array.isArray(items) || items.length < 1 || items.length > 15) return null;
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.vid !== 'string' || !VID.test(item.vid)
      || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 5
      || seen.has(item.vid)) return null;
    seen.add(item.vid);
  }
  return {
    startCountryCode: originCountryCode,
    endCountryCode: 'US',
    zip: destinationZip,
    products: items.map(item => ({ vid: item.vid, quantity: item.quantity }))
  };
}

/** CJ /logistic/freightCalculate returns trial rates, NOT final checkout offers. */
export function parseCjFreightTrial(payload) {
  if (payload?.result !== true || Number(payload.code) !== 200 || !Array.isArray(payload.data)) return [];
  return payload.data.slice(0, 30).flatMap(item => {
    if (!item || typeof item.logisticName !== 'string') return [];
    const charge = moneyCents(item.totalPostageFee ?? item.logisticPrice);
    if (charge === null || charge > 200000000) return [];
    return [{ carrier: item.logisticName.slice(0, 80), estimatedFreightCents: charge,
      deliveryEstimate: typeof item.logisticAging === 'string' ? item.logisticAging.slice(0, 60) : null,
      preliminary: true }];
  });
}
