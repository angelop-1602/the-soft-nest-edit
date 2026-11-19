/** Persistent selections; all product data, prices and shipping come from the Worker. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    list = $('cj-cart-lines');
  if (!list) return;
  const KEY = 'softnest-cj-planning-cart-v1',
    ID = /^[A-Za-z0-9_-]{1,128}$/;
  const money = (value) =>
    Number.isSafeInteger(value)
      ? new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD'
        }).format(value)
      : 'Awaiting verification';
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  let revision = 0,
    cartRevision = 0,
    ready = false,
    quote = null,
    expiryTimer,
    sandbox = false,
    sessionReady;
  function read() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]'),
        seen = new Set();
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((i) => {
          if (
            !i ||
            typeof i.variantId !== 'string' ||
            !ID.test(i.variantId) ||
            !Number.isInteger(i.quantity) ||
            i.quantity < 1 ||
            i.quantity > 5 ||
            seen.has(i.variantId)
          )
            return false;
          seen.add(i.variantId);
          return true;
        })
        .slice(0, 15)
        .map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
    } catch {
      return [];
    }
  }
  function save(items) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
      window.dispatchEvent(new Event('softnest:cart-change'));
      return true;
    } catch {
      $('cj-cart-status').textContent =
        'Browser storage is unavailable. Your selections could not be saved.';
      return false;
    }
  }
  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        data.error || 'This service is temporarily unavailable. Please try again later.'
      );
    return data;
  }
  function invalidate() {
    quote = null;
    clearTimeout(expiryTimer);
    $('cj-sandbox-start').disabled = true;
    $('cj-shipping').textContent = 'Enter a ZIP code';
    $('cj-total').textContent = '—';
    $('cj-shipping-status').textContent = '';
  }
  function renderLine(line) {
    const article = el('article', 'cj-cart-line');
    let image;
    try {
      const url = new URL(line.image);
      if (url.protocol === 'https:' && !url.username && !url.password) image = url.href;
    } catch {}
    if (image) {
      const img = el('img');
      img.src = image;
      img.alt = line.title;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      article.append(img);
    } else article.append(el('div', 'cj-cart-image-empty'));
    const info = el('div');
    info.append(
      el('h2', 'cj-cart-line-title', line.title),
      el('p', 'cj-cart-line-info', line.variantLabel)
    );
    info.append(
      el(
        'p',
        'cj-cart-price',
        line.unitPriceCents === null
          ? 'Price awaiting approval'
          : money(line.unitPriceCents) + ' each'
      )
    );
    info.append(el('p', 'cj-cart-line-info', line.message));
    article.append(info);
    const controls = el('div', 'cj-cart-line-controls');
    const change = (qty) => {
      const current = read().filter((i) => i.variantId !== line.variantId);
      if (qty > 0) current.push({ variantId: line.variantId, quantity: qty });
      if (save(current)) refresh();
    };
    const minus = el('button', 'cj-cart-btn', '−'),
      plus = el('button', 'cj-cart-btn', '+'),
      remove = el('button', 'cj-cart-btn', 'Remove');
    for (const button of [minus, plus, remove]) button.type = 'button';
    minus.setAttribute('aria-label', 'Reduce quantity of ' + line.title);
    plus.setAttribute('aria-label', 'Increase quantity of ' + line.title);
    remove.setAttribute('aria-label', 'Remove ' + line.title);
    minus.disabled = line.quantity <= 1;
    plus.disabled = line.quantity >= 5;
    minus.addEventListener('click', () => change(line.quantity - 1));
    plus.addEventListener('click', () => change(line.quantity + 1));
    remove.addEventListener('click', () => change(0));
    controls.append(minus, el('span', 'cj-cart-quantity', String(line.quantity)), plus, remove);
    article.append(controls);
    return article;
  }
  async function refresh() {
    const current = ++cartRevision;
    ++revision;
    invalidate();
    ready = false;
    $('cj-quote-button').disabled = true;
    const items = read();
    $('cj-cart-clear').disabled = !items.length;
    if (!items.length) {
      list.replaceChildren();
      $('cj-cart-status').textContent =
        'Your planning cart is empty. Browse CJ previews to choose a product.';
      $('cj-subtotal').textContent = '—';
      $('cj-readiness-output').textContent = 'Add selections to review product readiness.';
      return;
    }
    $('cj-cart-status').textContent = 'Refreshing product details and verification…';
    try {
      const data = await api('/api/commerce/cart', { items });
      if (current !== cartRevision) return;
      if (
        data.customerCheckoutEnabled !== false ||
        data.cjFulfillmentEnabled !== false ||
        !Array.isArray(data.lines)
      )
        throw new Error('Cart verification is unavailable.');
      list.replaceChildren(...data.lines.map(renderLine));
      ready = data.readyForShipping === true;
      $('cj-subtotal').textContent = money(data.subtotalCents);
      $('cj-quote-button').disabled = !ready;
      $('cj-cart-status').textContent =
        `${items.reduce((sum, i) => sum + i.quantity, 0)} items saved in your planning cart. Purchases remain disabled.`;
      const checks = el('ul');
      for (const line of data.lines) checks.append(el('li', '', line.title + ': ' + line.message));
      $('cj-readiness-output').replaceChildren(checks);
      if (!ready)
        $('cj-shipping-status').textContent =
          'Shipping cannot be quoted until every selection passes verification.';
    } catch (error) {
      if (current === cartRevision) {
        $('cj-cart-status').textContent = error.message;
        $('cj-subtotal').textContent = 'Awaiting verification';
        $('cj-readiness-output').textContent = 'Product checks are temporarily unavailable.';
      }
    }
  }
  $('cj-cart-clear').addEventListener('click', () => {
    if (save([])) refresh();
  });
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) refresh();
  });
  $('cj-destination-zip').addEventListener('input', () => {
    ++revision;
    invalidate();
    $('cj-quote-button').disabled = !ready;
  });
  $('cj-shipping-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ready) return;
    const current = revision;
    invalidate();
    $('cj-quote-button').disabled = true;
    $('cj-shipping-status').textContent = 'Checking warehouse availability and shipping methods…';
    try {
      await sessionReady;
      const data = await api('/api/commerce/shipping', {
        items: read(),
        zip: $('cj-destination-zip').value.trim()
      });
      if (current !== revision) return;
      if (
        data.customerCheckoutEnabled !== false ||
        data.preliminary !== true ||
        !Number.isSafeInteger(data.totalCents)
      )
        throw new Error('The estimate could not be verified.');
      quote = data;
      $('cj-subtotal').textContent = money(data.subtotalCents);
      $('cj-shipping').textContent = money(data.shippingCents);
      $('cj-total').textContent = money(data.totalCents);
      $('cj-shipping-status').textContent =
        data.notice +
        ' Methods: ' +
        data.shipments
          .map(
            (s) =>
              s.carrier +
              (s.supplierDeliveryEstimate
                ? ' (supplier estimate: ' + s.supplierDeliveryEstimate + ')'
                : '')
          )
          .join('; ');
      $('cj-sandbox-start').disabled = !sandbox;
      expiryTimer = setTimeout(
        () => {
          invalidate();
          $('cj-shipping-status').textContent =
            'This estimate has expired. Request another estimate.';
        },
        Math.max(0, data.expiresMs - Date.now())
      );
    } catch (error) {
      if (current === revision) $('cj-shipping-status').textContent = error.message;
    } finally {
      if (current === revision) $('cj-quote-button').disabled = !ready;
    }
  });
  const sandboxApi = (route, body) => api('/api/paypal/product-sandbox/' + route, body);
  $('cj-sandbox-start').addEventListener('click', async () => {
    if (!quote || !sandbox) return;
    const selected = quote;
    $('cj-sandbox-start').disabled = true;
    try {
      const key = 'softnest-sandbox-request-' + selected.quoteId;
      let requestKey = sessionStorage.getItem(key);
      if (!requestKey) {
        requestKey = crypto.randomUUID();
        sessionStorage.setItem(key, requestKey);
      }
      const data = await sandboxApi('create', {
        quoteId: selected.quoteId,
        requestKey
      });
      if (data.status === 'paid') {
        $('cj-sandbox-status').textContent =
          'This Sandbox order is already paid. No supplier order was placed.';
        return;
      }
      const target = new URL(data.approvalUrl);
      if (
        target.protocol !== 'https:' ||
        !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(target.hostname) ||
        target.username ||
        target.password ||
        target.port
      )
        throw new Error('Sandbox redirect could not be verified.');
      location.assign(target.href);
    } catch (error) {
      $('cj-sandbox-status').textContent = error.message;
      $('cj-sandbox-start').disabled = !quote;
    }
  });
  const callback = new URL(location.href),
    checkoutId = callback.searchParams.get('productCheckoutId');
  $('cj-sandbox-capture').addEventListener('click', async () => {
    const button = $('cj-sandbox-capture');
    button.disabled = true;
    try {
      const data = await sandboxApi('capture', { checkoutId });
      if (data.status !== 'paid') throw new Error('Sandbox verification is pending.');
      $('cj-sandbox-status').textContent =
        'PayPal Sandbox payment verified. No merchandise will ship and no CJ order was placed.';
      button.hidden = true;
    } catch (error) {
      $('cj-sandbox-status').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  async function initialize() {
    sessionReady = api('/api/commerce/session');
    try {
      await sessionReady;
      const config = await sandboxApi('config');
      sandbox = config.enabled === true && config.environment === 'sandbox';
      $('cj-product-sandbox').hidden = !sandbox;
      if (sandbox && checkoutId) {
        const data = await sandboxApi('status?checkoutId=' + encodeURIComponent(checkoutId));
        $('cj-sandbox-status').textContent =
          data.status === 'paid'
            ? 'Sandbox payment verified. No supplier order was placed.'
            : callback.searchParams.get('result') === 'canceled'
              ? 'Sandbox checkout canceled.'
              : 'Returned from PayPal Sandbox. Verify the test payment below.';
        $('cj-sandbox-capture').hidden = !['created', 'capturing', 'capture_retry'].includes(
          data.status
        );
      }
    } catch (error) {
      if (checkoutId) $('cj-sandbox-status').textContent = error.message;
    }
    refresh();
  }
  initialize();
})();
