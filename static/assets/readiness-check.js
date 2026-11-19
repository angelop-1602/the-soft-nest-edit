/** Read-only checkout prerequisites card; no purchase, PayPal or supplier actions. */
(() => {
  'use strict';
  const root = document.getElementById('cj-readiness-output');
  if (!root) return;
  const key = 'softnest-cj-planning-cart-v1';
  const labels = {
    not_found: 'This variant is no longer in the supplier catalog',
    not_approved: 'Product review is pending',
    retail_price_unverified: 'Selling price has not been approved',
    inventory_unverified: 'Inventory has not been verified',
    insufficient_inventory: 'Requested quantity is not available',
    inventory_not_recently_verified: 'Recent inventory confirmation is missing',
    shipping_not_quoted: 'Product and price checks passed; US shipping still needs verification'
  };
  function cart() {
    try {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(list) ? list.map(i => ({ variantId: i.variantId, quantity: i.quantity })) : [];
    } catch { return []; }
  }
  const make = (tag, value) => { const e = document.createElement(tag); e.textContent = value; return e; };
  async function refresh() {
    const items = cart();
    root.replaceChildren(make('p', items.length ? 'Checking product readiness…' : 'Add products to your planning cart to review checkout requirements.'));
    if (!items.length) return;
    try {
      const response = await fetch('/api/checkout/readiness', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items }), credentials: 'same-origin', cache: 'no-store'
      });
      if (!response.ok) throw new Error('Pricing checks are temporarily unavailable.');
      const data = await response.json();
      if (data.customerCheckoutEnabled !== false || data.cjOrderSubmissionEnabled !== false)
        throw new Error('Checkout status cannot be verified.');
      const list = make('ul', '');
      for (const line of data.lines || []) {
        const text = labels[line.reason] || 'Verification required';
        const amount = line.unitPriceUsd ? ` · Verified retail price: $${line.unitPriceUsd} USD each` : '';
        list.append(make('li', `${text}${amount}`));
      }
      const shipping = make('p', 'Shipping: awaiting a destination-specific supplier quote.');
      const total = make('p', 'Order total: not available; payment disabled.');
      root.replaceChildren(list, shipping, total);
    } catch (error) { root.replaceChildren(make('p', error.message)); }
  }
  window.addEventListener('storage', e => { if (e.key === key) refresh(); });
  window.addEventListener('softnest:cart-change', refresh);
  refresh();
})();
