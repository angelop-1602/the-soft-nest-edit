/** Future live fulfillment data contract. No network calls or enabled execution path. */
import { validateCartPayload } from './cart-preview.js';
import { validZip } from './commerce-security.js';

export function validateShippingAddress(address) {
  if (!address || address.countryCode !== 'US' || !validZip(address.zip)) return null;
  const limits = { name: 150, line1: 200, line2: 200, city: 100, state: 2 };
  const result = { countryCode: 'US', zip: address.zip };
  const states = new Set(
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(
      ' '
    )
  );
  for (const [key, max] of Object.entries(limits)) {
    const value = address[key] ?? (key === 'line2' ? '' : null);
    if (
      typeof value !== 'string' ||
      value.length > max ||
      /[\x00-\x1f\x7f]/.test(value) ||
      (key !== 'line2' && !value.trim())
    )
      return null;
    result[key] = value.trim();
  }
  return states.has(result.state) ? result : null;
}
export function prepareFulfillmentDraft(order) {
  const address = validateShippingAddress(order?.shippingAddress);
  const items = validateCartPayload({ items: order?.items });
  if (
    order?.environment !== 'live' ||
    order?.status !== 'paid' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(order?.id || '') ||
    !address ||
    !items?.length ||
    !order.shippingMethod
  )
    return null;
  return {
    orderId: order.id,
    idempotencyKey: 'cj-order-' + order.id,
    status: 'disabled',
    shippingAddress: address,
    items,
    shippingMethod: order.shippingMethod,
    cjOrderId: null,
    tracking: [],
    retryCount: 0,
    requiresReconciliation: false
  };
}
export async function submitSupplierOrder() {
  // Deliberately unconditional. Configuration flags cannot activate purchases.
  throw new Error('CJ_FULFILLMENT_DISABLED');
}
export async function paySupplierOrder() {
  throw new Error('CJ_SUPPLIER_PAYMENT_DISABLED');
}
