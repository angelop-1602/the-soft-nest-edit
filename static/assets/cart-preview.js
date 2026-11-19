/** CJ catalog planning cart. Local-only selections, never an order or payment. */
(() => {
  'use strict';
  const KEY = 'softnest-cj-planning-cart-v1';
  const ID = /^[A-Za-z0-9_-]{1,128}$/;
  const MAX_LINES = 15;
  const MAX_QTY = 5;

  function readCart() {
    try {
      const records = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(records)) return [];
      const result = []; const seen = new Set();
      for (const item of records) {
        if (!item || typeof item.variantId !== 'string' || !ID.test(item.variantId)
          || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QTY
          || seen.has(item.variantId)) continue;
        seen.add(item.variantId);
        result.push({ variantId: item.variantId, quantity: item.quantity });
        if (result.length >= MAX_LINES) break;
      }
      return result;
    } catch { return []; }
  }
  function writeCart(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); return true; }
    catch { return false; }
  }
  function el(name, klass, label) {
    const node = document.createElement(name);
    if (klass) node.className = klass;
    if (label !== undefined) node.textContent = String(label);
    return node;
  }
  function updateCartCount() {
    const link = document.getElementById('cj-planning-cart-link');
    if (link) link.textContent = `View planning cart (${readCart().reduce((s,i) => s + i.quantity, 0)})`;
  }
  async function requestJson(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store',
      headers: { 'Accept': 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      ...opts
    });
    if (!res.ok) throw new Error('Catalog is unavailable. Try again later.');
    return res.json();
  }
  function setupCatalogSelectors() {
    const grid = document.getElementById('cj-preview-grid');
    if (!grid) return;
    // Catalog is loaded asynchronously. A MutationObserver attaches to fresh product cards.
    const observer = new MutationObserver(() => {
      for (const card of grid.querySelectorAll('.cj-preview-card:not([data-cart-ready])')) {
        const pid = card.dataset.cjProductId;
        if (!pid || !ID.test(pid)) continue;
        card.dataset.cartReady = '1';
        const info = card.querySelector('.store-product-info');
        if (!info) continue;
        const panel = el('div', 'cj-preview-selector');
        const reveal = el('button', 'cj-preview-cart-button', 'Select variant');
        reveal.type = 'button';
        const notice = el('p', 'cj-preview-selector-msg', 'Planning cart only — purchases disabled.');
        info.append(panel, notice);
        panel.append(reveal);
        reveal.addEventListener('click', async () => {
          reveal.disabled = true; reveal.textContent = 'Loading variants…';
          try {
            const data = await requestJson('/api/catalog/variants?productId=' + encodeURIComponent(pid));
            if (!Array.isArray(data.variants) || data.checkoutEnabled !== false || !data.variants.length)
              throw new Error('No variants available for this product.');
            const select = el('select');
            select.setAttribute('aria-label', 'Choose product variant');
            for (const v of data.variants) {
              if (!ID.test(v.id)) continue;
              const option = el('option', '', v.label || 'Variant');
              option.value = v.id;
              select.append(option);
            }
            if (!select.options.length) throw new Error('No valid variants available.');
            const add = el('button', 'cj-preview-cart-button', 'Add to planning cart');
            add.type = 'button';
            panel.replaceChildren(select, add);
            add.addEventListener('click', () => {
              const id = select.value;
              if (!ID.test(id)) return;
              const cart = readCart(); const previous = cart.find(i => i.variantId === id);
              if (previous) previous.quantity = Math.min(MAX_QTY, previous.quantity + 1);
              else if (cart.length < MAX_LINES) cart.push({ variantId: id, quantity: 1 });
              else { notice.textContent = 'Cart limit reached (15 variants).'; return; }
              if (!writeCart(cart)) { notice.textContent = 'Browser storage is unavailable.'; return; }
              notice.textContent = 'Saved to your planning cart. No order was placed.';
              updateCartCount();
            });
          } catch (error) {
            reveal.disabled = false; reveal.textContent = 'Retry variant selection';
            notice.textContent = error.message;
          }
        });
      }
    });
    observer.observe(grid, { childList: true });
    updateCartCount();
  }
  async function setupCartPage() {
    const list = document.getElementById('cj-cart-lines');
    if (!list) return;
    const status = document.getElementById('cj-cart-status');
    const clear = document.getElementById('cj-cart-clear');
    let busy = false;
    const show = async () => {
      if (busy) return;
      busy = true; list.replaceChildren();
      const items = readCart();
      if (!items.length) {
        status.textContent = 'Your planning cart is empty. Browse the CJ preview to choose products.';
        clear.disabled = true; busy = false; return;
      }
      status.textContent = 'Refreshing your selections from the CJ catalog…';
      clear.disabled = false;
      try {
        const data = await requestJson('/api/catalog/cart', {
          method: 'POST', body: JSON.stringify({ items })
        });
        if (data.checkoutEnabled !== false || !Array.isArray(data.lines))
          throw new Error('Unexpected cart response.');
        const validIds = new Set(data.lines.map(x => x.variantId));
        if (data.unavailable) {
          writeCart(items.filter(x => validIds.has(x.variantId)));
        }
        for (const item of data.lines) {
          const article = el('article', 'cj-cart-line');
          if (typeof item.image === 'string' && item.image.startsWith('https://')) {
            const img = el('img'); img.src = item.image; img.alt = item.title || 'Supplier product';
            img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; article.append(img);
          } else article.append(el('div', 'cj-cart-image-empty'));
          const info = el('div');
          info.append(el('h2', 'cj-cart-line-title', item.title || 'CJ product'));
          info.append(el('p', 'cj-cart-line-info', (item.variantLabel || 'Variant') + (item.sku ? ` · SKU ${item.sku}` : '')));
          info.append(el('p', 'cj-cart-line-info', 'Retail price, stock and shipping not verified'));
          article.append(info);
          const controls = el('div', 'cj-cart-line-controls');
          const decrease = el('button', 'cj-cart-btn', '−'); decrease.type = 'button'; decrease.setAttribute('aria-label', 'Reduce quantity');
          const qty = el('span', 'cj-cart-quantity', item.quantity);
          const increase = el('button', 'cj-cart-btn', '+'); increase.type = 'button'; increase.setAttribute('aria-label', 'Increase quantity');
          const remove = el('button', 'cj-cart-btn', 'Remove'); remove.type = 'button';
          decrease.disabled = item.quantity <= 1;
          increase.disabled = item.quantity >= MAX_QTY;
          const change = newQuantity => {
            const current = readCart();
            const updated = current.filter(v => v.variantId !== item.variantId);
            if (newQuantity > 0) updated.push({ variantId: item.variantId, quantity: newQuantity });
            if (writeCart(updated)) show();
          };
          decrease.addEventListener('click', () => change(item.quantity - 1));
          increase.addEventListener('click', () => change(item.quantity + 1));
          remove.addEventListener('click', () => change(0));
          controls.append(decrease, qty, increase, remove);
          article.append(controls); list.append(article);
        }
        status.textContent = `${data.lines.length} distinct variant${data.lines.length === 1 ? '' : 's'} in your planning cart.${data.unavailable ? ` ${data.unavailable} unavailable selection(s) removed.` : ''} No orders or payments are created.`;
      } catch (error) { status.textContent = error.message; }
      busy = false;
    };
    clear.addEventListener('click', () => { if (writeCart([])) show(); });
    window.addEventListener('storage', event => { if (event.key === KEY) show(); });
    show();
  }
  setupCatalogSelectors();
  setupCartPage();
})();
