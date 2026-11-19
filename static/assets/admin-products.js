/** Private management UI. Authorization and every business rule are enforced by the Worker. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    money = (n) =>
      Number.isSafeInteger(n)
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100)
        : 'Not verified';
  const label = (s) => String(s || '').replace(/_/g, ' '),
    date = (s) =>
      s
        ? new Date(
            typeof s === 'number' ? s : /^\d{4}-\d\d-\d\d /.test(s) ? s.replace(' ', 'T') + 'Z' : s
          ).toLocaleString()
        : 'Not verified';
  const e = (tag, cls, value) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  let page = 1,
    pages = 0,
    selected = null,
    data = null,
    session = null,
    busy = false,
    readGeneration = 0,
    listGeneration = 0,
    id = 0;
  const notice = (message, error = false) => {
    const n = $('admin-notice');
    n.className = 'notice' + (error ? ' error' : '');
    n.textContent = message;
  };
  function locked() {
    data = null;
    selected = null;
    $('product-list').replaceChildren();
    $('product-detail').replaceChildren(
      e('p', 'notice error', 'Administrator access has expired. Sign in again.')
    );
    $('policy-editor').replaceChildren();
    const link = e('a', 'button secondary', 'Sign in again');
    link.href =
      session?.actor?.source === 'local_development' ? '/admin/products/login' : '/admin/products/';
    $('product-detail').append(link);
  }
  async function api(path, body) {
    const response = await fetch('/api/admin/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'X-Softnest-Admin': '1' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!(response.headers.get('Content-Type') || '').includes('application/json')) {
      locked();
      throw new Error('The administrator session could not be verified. Sign in again.');
    }
    let value;
    try {
      value = await response.json();
    } catch {
      locked();
      throw new Error('Administrator verification is unavailable. Sign in again.');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) locked();
      throw new Error(value.error || 'The request could not be completed.');
    }
    return value;
  }
  function button(text, fn, kind = 'secondary') {
    const b = e('button', 'button ' + kind, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  function field(form, key, title, value = '', type = 'text', options = {}) {
    const wrap = e('div', options.full ? 'full-width' : ''),
      input = e(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input');
    const ident = 'admin-field-' + ++id;
    input.id = ident;
    input.name = key;
    if (type === 'select') {
      for (const [v, t] of options.choices) {
        const o = e('option', '', t);
        o.value = v;
        input.append(o);
      }
    } else if (type !== 'textarea') input.type = type;
    if (options.required) input.required = true;
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.min !== undefined) input.min = options.min;
    if (options.max !== undefined) input.max = options.max;
    if (options.step) input.step = options.step;
    input.value = value ?? '';
    const l = e('label', 'field-label', title);
    l.htmlFor = ident;
    wrap.append(l, input);
    form.append(wrap);
    return input;
  }
  function check(root, key, title, value = false) {
    const l = e('label', 'check-label'),
      input = e('input');
    input.type = 'checkbox';
    input.name = key;
    input.checked = value === true;
    l.append(input, e('span', '', title));
    root.append(l);
    return input;
  }
  function image(src, title, large = false) {
    try {
      const u = new URL(src);
      if (u.protocol !== 'https:' || u.username || u.password) throw 0;
      const img = e('img');
      img.src = u.href;
      img.alt = title;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      return img;
    } catch {
      return e('div', 'thumb-placeholder', large ? 'Image not verified' : '');
    }
  }
  const status = (s) => e('span', 'status ' + s, label(s));
  function details(title, cls = 'detail-section', open = false) {
    const box = e('details', cls);
    box.open = open;
    box.append(e('summary', '', title));
    const body = e('div', 'section-body');
    box.append(body);
    return { box, body };
  }
  function errorIn(form, error) {
    let n = form.querySelector('.inline-message');
    if (!n) {
      n = e('p', 'inline-message');
      n.setAttribute('role', 'alert');
      form.append(n);
    }
    n.textContent = error.message;
    notice(error.message, true);
  }
  async function mutate(path, payload, form) {
    if (busy) return;
    busy = true;
    const productId = selected;
    $('product-detail').setAttribute('aria-busy', 'true');
    const buttons = Array.from(document.querySelectorAll('button[data-write]')).map((button) => ({
      button,
      disabled: button.disabled
    }));
    for (const { button } of buttons) button.disabled = true;
    try {
      const result = await api(path, payload);
      if (selected === productId) {
        data = result;
        renderDetail();
      }
      notice(result.verification?.message || 'Changes saved. The server revalidated this review.');
      loadList();
      return result;
    } catch (error) {
      errorIn(form, error);
    } finally {
      busy = false;
      $('product-detail').removeAttribute('aria-busy');
      for (const { button, disabled } of buttons)
        if (button.isConnected) button.disabled = disabled;
    }
  }
  function submit(form, text, handler, kind = '') {
    const actions = e('div', 'form-actions'),
      b = e('button', 'button ' + kind, text);
    b.type = 'submit';
    b.dataset.write = '1';
    actions.append(b);
    form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      handler().catch((error) => errorIn(form, error));
    });
    return actions;
  }
  async function loadList() {
    const current = ++listGeneration;
    try {
      const result = await api(
        'products?' +
          new URLSearchParams({
            q: $('product-query').value,
            filter: $('product-filter').value,
            page
          })
      );
      if (current !== listGeneration) return;
      pages = result.pages;
      $('catalog-count').textContent =
        result.total + ' product' + (result.total === 1 ? '' : 's') + ' in this view';
      $('page-label').textContent = page + ' / ' + Math.max(1, pages);
      $('page-prev').disabled = page <= 1;
      $('page-next').disabled = page >= pages;
      const items = result.products.map((p) => {
        const b = e('button', 'product-picker');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(selected === p.id));
        b.append(image(p.image, p.title));
        const info = e('span');
        info.append(
          e('strong', '', p.title),
          e('span', 'small', p.variantCount + ' variants · ' + p.approvedVariants + ' approved'),
          status(p.fixtureOnly ? 'disabled' : p.status)
        );
        if (p.fixtureOnly) info.append(e('span', 'small', 'ISOLATED QA · NEVER FOR SALE'));
        b.append(info);
        b.addEventListener('click', () => select(p.id));
        return b;
      });
      $('product-list').replaceChildren(...items);
      if (!items.length) $('product-list').append(e('p', 'small', 'No products match this view.'));
    } catch (error) {
      notice(error.message, true);
    }
  }
  async function select(productId) {
    const generation = ++readGeneration;
    selected = productId;
    notice('Loading product review…');
    try {
      const result = await api('products/' + encodeURIComponent(productId));
      if (generation !== readGeneration) return;
      data = result;
      renderDetail();
      loadList();
      notice(
        'Review the product, verify supplier stock and shipping, then save pricing and approve specific variants.'
      );
      $('product-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (error) {
      notice(error.message, true);
    }
  }
  function metric(root, title, value, foot = '') {
    const item = e('div', 'metric');
    item.append(e('dt', '', title), e('dd', '', value));
    if (foot) item.append(e('small', '', foot));
    root.append(item);
  }
  function profit(root, p) {
    if (!p) {
      root.append(
        e('p', 'small', 'Verify supplier cost and configure a pricing policy to calculate profit.')
      );
      return;
    }
    const box = e('div', 'breakdown'),
      dl = e('dl');
    for (const [title, n, cls] of [
      ['Policy minimum retail', p.minimumRetailCents],
      ['Proposed product retail', p.retailPriceCents],
      ['Supplier shipping estimate', p.freightCents],
      ['Retail shipping & handling', p.shippingRetailCents],
      ['Estimated processing fees', p.processingFeeCents],
      ['Cost buffers', p.bufferCents],
      ['Estimated net profit', p.estimatedProfitCents, 'profit-total']
    ]) {
      const row = e('div', cls);
      row.append(e('dt', '', title), e('dd', '', money(n)));
      dl.append(row);
    }
    box.append(
      dl,
      e(
        'p',
        'small',
        p.netMarginBps === null
          ? 'A fresh one-unit shipping check is required for a complete profit estimate.'
          : 'Estimated net margin: ' +
              (p.netMarginBps / 100).toFixed(2) +
              '%. Includes shipping, fees and buffers; taxes and returns are not calculated.'
      )
    );
    root.append(box);
  }
  const productChecks = {
    photosAccurate: 'Product photos accurately show the item',
    descriptionAccurate: 'Description is accurate and complete',
    sizeMaterialsVerified: 'Size and materials have been verified',
    returnsReviewed: 'Return eligibility and restrictions reviewed',
    restrictionsReviewed: 'Prohibited / restricted product review complete',
    supplierReviewed: 'Supplier reliability reviewed',
    complaintsReviewed: 'Defects and complaints reviewed'
  };
  const variantChecks = {
    mappingReviewed: 'Exact CJ product-to-variant mapping reviewed',
    optionsReviewed: 'Variant options, size and materials reviewed',
    restrictionsReviewed: 'Variant restrictions and return suitability reviewed'
  };
  function productReview(root, p) {
    const section = details('01 / Product quality & restrictions');
    const form = e('form'),
      grid = e('div', 'form-grid');
    const description = field(
      grid,
      'description',
      'Accurate product description',
      p.description,
      'textarea',
      { full: true, maxLength: 6000 }
    );
    const returns = field(
      grid,
      'returnEligibility',
      'Return eligibility',
      p.review.returnEligibility || 'unknown',
      'select',
      {
        choices: [
          ['unknown', 'Not verified'],
          ['eligible', 'Eligible under reviewed terms'],
          ['ineligible', 'Ineligible — block approval']
        ]
      }
    );
    const restricted = field(
      grid,
      'restrictionStatus',
      'Restricted / prohibited goods',
      p.review.restrictionStatus || 'unknown',
      'select',
      {
        choices: [
          ['unknown', 'Not verified'],
          ['clear', 'Reviewed — clear'],
          ['restricted', 'Restricted — block approval']
        ]
      }
    );
    const notes = {};
    for (const [key, title] of [
      ['returnNotes', 'Return terms & restrictions (20+ characters)'],
      ['sizeMaterialNotes', 'Verified sizes & materials (10+ characters)'],
      ['supplierNotes', 'Supplier reliability notes'],
      ['complaintsNotes', 'Defects or complaints'],
      ['restrictionNotes', 'Restriction review notes']
    ])
      notes[key] = field(grid, key, title, p.review[key] || '', 'textarea', {
        full: true,
        maxLength: 2000
      });
    const checks = e('div', 'check-grid'),
      inputs = {};
    for (const [key, title] of Object.entries(productChecks))
      inputs[key] = check(checks, key, title, p.review[key]);
    form.append(grid, checks);
    submit(form, 'Save quality review', async () => {
      const review = { returnEligibility: returns.value, restrictionStatus: restricted.value };
      for (const [k, n] of Object.entries(notes)) review[k] = n.value;
      for (const [k, n] of Object.entries(inputs)) review[k] = n.checked;
      await mutate(
        'products/' + p.id + '/review',
        { expectedVersion: p.version, description: description.value, review },
        form
      );
    });
    section.body.append(form);
    root.append(section.box);
  }
  function variantReview(root, p, v) {
    const form = e('form', 'step-box');
    form.append(e('h4', '', 'VARIANT QUALITY REVIEW'));
    const checks = e('div', 'check-grid'),
      inputs = {};
    for (const [key, title] of Object.entries(variantChecks))
      inputs[key] = check(checks, key, title, v.review[key]);
    form.append(checks);
    const notes = field(form, 'notes', 'Variant review notes', v.review.notes || '', 'textarea', {
      maxLength: 2000
    });
    submit(form, 'Save variant review', async () => {
      const review = { notes: notes.value };
      for (const [k, n] of Object.entries(inputs)) review[k] = n.checked;
      await mutate(
        'products/' + p.id + '/variants/' + v.id + '/review',
        { expectedProductVersion: p.version, expectedVersion: v.version, review },
        form
      );
    });
    root.append(form);
  }
  function supplierForm(root, p, v) {
    const form = e('form', 'step-box');
    form.append(e('h4', '', 'VERIFY SUPPLIER & WAREHOUSE'));
    const grid = e('div', 'form-grid');
    const origin = field(grid, 'origin', 'Check warehouse country', v.origin || 'US', 'select', {
      choices: [
        ['US', 'United States'],
        ['CN', 'China']
      ]
    });
    grid.append(
      e(
        'p',
        'small',
        'The server verifies the exact CJ variant, current USD cost and CJ-managed warehouse stock. Factory/unverified inventory cannot qualify.'
      )
    );
    form.append(grid);
    submit(form, 'Refresh supplier cost & stock', async () =>
      mutate(
        'products/' + p.id + '/variants/' + v.id + '/verify',
        { expectedProductVersion: p.version, expectedVersion: v.version, origin: origin.value },
        form
      )
    );
    root.append(form);
  }
  function shippingForm(root, p, v) {
    const form = e('form', 'step-box');
    form.append(e('h4', '', 'CHECK US SHIPPING'));
    const grid = e('div', 'form-grid');
    const zip = field(grid, 'zip', 'US ZIP code', v.shippingChecks[0]?.zip || '', 'text', {
      required: true,
      maxLength: 10
    });
    zip.inputMode = 'numeric';
    zip.placeholder = 'e.g. 10001';
    zip.pattern = '[0-9]{5}(-[0-9]{4})?';
    const quantity = field(
      grid,
      'quantity',
      'Quantity (approval requires a one-unit check)',
      1,
      'number',
      { min: 1, max: 5, step: 1, required: true }
    );
    form.append(grid);
    submit(form, 'Get real CJ shipping estimates', async () =>
      mutate(
        'products/' + p.id + '/variants/' + v.id + '/shipping',
        {
          expectedProductVersion: p.version,
          expectedVersion: v.version,
          zip: zip.value,
          quantity: Number(quantity.value)
        },
        form
      )
    );
    form.append(
      e(
        'p',
        'small',
        'Checks apply only to the displayed ZIP, origin and quantity. They expire after ten minutes. Checkout always obtains a new destination-specific quote. Supplier transit ranges are estimates, not guarantees.'
      )
    );
    const history = e('div', 'quote-history');
    for (const c of v.shippingChecks) {
      const box = e('div', 'quote-check');
      box.append(
        e(
          'strong',
          '',
          c.origin +
            ' → US ' +
            c.zip +
            ' · ' +
            c.quantity +
            ' unit(s) · ' +
            label(c.status) +
            (c.current ? '' : ' · stale / changed')
        ),
        e('p', 'small', 'Checked ' + date(c.checkedMs) + ' · Expires ' + date(c.expiresMs))
      );
      if (c.methods.length) {
        const rates = e('ul');
        for (const m of c.methods)
          rates.append(
            e(
              'li',
              '',
              m.carrier +
                ' · ' +
                money(m.freightCents) +
                (m.supplierDeliveryEstimate
                  ? ' · Supplier transit estimate: ' + m.supplierDeliveryEstimate
                  : '')
            )
          );
        box.append(rates);
      } else box.append(e('p', '', 'No verified shipping methods for this check.'));
      history.append(box);
    }
    if (!v.shippingChecks.length) history.append(e('p', 'small', 'Shipping: Not verified.'));
    form.append(history);
    root.append(form);
  }
  function priceForm(root, p, v) {
    const form = e('form', 'step-box');
    form.append(e('h4', '', 'RETAIL PRICING & ESTIMATED PROFIT'));
    const grid = e('div', 'form-grid');
    const price = field(
      grid,
      'retail',
      'Retail price, USD',
      Number.isSafeInteger(v.retailPriceCents) ? (v.retailPriceCents / 100).toFixed(2) : '',
      'text',
      { required: true, maxLength: 12 }
    );
    price.inputMode = 'decimal';
    const use = button('Use policy minimum', () => {
      if (v.profit?.minimumRetailCents)
        price.value = (v.profit.minimumRetailCents / 100).toFixed(2);
    });
    grid.append(use);
    form.append(grid);
    let exception;
    if (session.policy.policy?.allowMarginExceptions) {
      const box = details('Acknowledge a lower-margin exception', 'step-box');
      const acknowledged = check(
        box.body,
        'exceptionAck',
        'I explicitly accept a lower margin for this exact price and verified supplier cost.'
      );
      const fields = e('div', 'form-grid');
      const margin = field(
        fields,
        'minimumMarginBps',
        'Exception minimum margin, basis points',
        session.policy.policy.exceptionMinimumMarginBps,
        'number',
        {
          min: session.policy.policy.exceptionMinimumMarginBps,
          max: session.policy.policy.targetMarginBps,
          step: 1
        }
      );
      const hours = field(fields, 'hours', 'Valid for hours', 1, 'number', {
        min: 1,
        max: session.policy.policy.exceptionMaxHours,
        step: 1
      });
      const reason = field(
        fields,
        'reason',
        'Why is this exception appropriate? (20+ characters)',
        '',
        'textarea',
        { full: true, maxLength: 1000 }
      );
      box.body.append(fields);
      form.append(box.box);
      exception = () => ({
        acknowledged: acknowledged.checked,
        minimumMarginBps: Number(margin.value),
        hours: Number(hours.value),
        reason: reason.value
      });
    }
    const payload = () => ({
      expectedProductVersion: p.version,
      expectedVersion: v.version,
      retailPriceUsd: price.value,
      ...(exception ? { exception: exception() } : {})
    });
    const output = e('div');
    profit(output, v.profit);
    form.append(output);
    const actions = submit(form, 'Save reviewed retail price', async () =>
      mutate('products/' + p.id + '/variants/' + v.id + '/price', payload(), form)
    );
    actions.prepend(
      button('Preview profit', async () => {
        try {
          const result = await api(
            'products/' + p.id + '/variants/' + v.id + '/price-preview',
            payload()
          );
          output.replaceChildren();
          profit(output, result.profit);
          if (result.warning) output.append(e('p', 'inline-message', result.warning));
        } catch (error) {
          errorIn(form, error);
        }
      })
    );
    if (v.pricingException.id)
      form.append(
        e(
          'p',
          'small',
          'Audited exception: ' +
            v.pricingException.reason +
            ' · Expires ' +
            date(v.pricingException.expiresMs)
        )
      );
    root.append(form);
  }
  function decisionForm(root, p, variants, scope) {
    const form = e('form', 'step-box');
    form.append(
      e(
        'h4',
        '',
        scope === 'product' ? 'PRODUCT DECISION · ALL VARIANTS' : 'THIS VARIANT’S DECISION'
      )
    );
    const reason = field(
      form,
      'reason',
      'Rejection / suspension reason (10+ characters)',
      '',
      'textarea',
      { maxLength: 1000 }
    );
    const actions = e('div', 'form-actions');
    for (const [action, title, kind] of [
      [
        'approve',
        scope === 'product' ? 'Approve product & all variants' : 'Approve this variant',
        ''
      ],
      ['disable', 'Disable immediately', 'secondary'],
      ['reject', 'Reject', 'danger']
    ]) {
      const b = button(
        title,
        async () => {
          if (busy) return;
          await mutate(
            'products/' + p.id + '/decision',
            {
              action,
              scope,
              expectedVersion: p.version,
              reason: reason.value,
              variants: variants.map((v) => ({ variantId: v.id, expectedVersion: v.version }))
            },
            form
          );
        },
        kind
      );
      b.dataset.write = '1';
      if (action === 'approve')
        b.disabled =
          !variants.length ||
          (scope === 'product' && data.hasMoreVariants) ||
          p.fixtureOnly ||
          variants.some((v) => v.fixtureOnly || v.approvalIssues.length > 0);
      actions.append(b);
    }
    form.append(actions);
    form.addEventListener('submit', (event) => event.preventDefault());
    root.append(form);
  }
  function renderDetail() {
    if (!data) return;
    const p = data.product,
      root = e('div', 'detail-inner'),
      heading = e('div', 'detail-heading');
    heading.append(image(p.image, p.title, true));
    const info = e('div');
    info.append(
      e('p', 'eyebrow', 'PRODUCT REVIEW'),
      e('h2', '', p.title),
      status(p.status),
      e('p', 'id-label', 'CJ product ' + p.id),
      e('p', 'small', 'Last sync ' + date(p.syncedAt) + ' · Review version ' + p.version)
    );
    heading.append(info);
    root.append(heading);
    if (p.fixtureOnly)
      root.append(
        e(
          'p',
          'fixture-warning',
          'ISOLATED QA FIXTURE · Permanently ineligible for customer sales. Administrator approval cannot override this restriction.'
        )
      );
    if (p.reason) root.append(e('p', 'notice', 'Review reason: ' + p.reason));
    productReview(root, p);
    const section = e('section', 'detail-section');
    section.append(
      e('p', 'eyebrow', '02 / EXACT VARIANT REVIEW'),
      e('h3', '', data.variants.length + ' variants, considered individually.')
    );
    for (const v of data.variants) {
      const card = details(
        v.options.label || 'Default variant',
        'variant-card',
        data.variants.length === 1
      );
      card.box.querySelector('summary').append(status(v.status));
      card.body.append(
        e('p', 'id-label', 'CJ variant ' + v.id + ' · SKU ' + (v.sku || 'Not verified'))
      );
      const metrics = e('dl', 'metrics');
      metric(
        metrics,
        'Supplier cost',
        money(v.supplierCostCents),
        v.costVerified
          ? 'Verified ' + date(v.costVerifiedAt)
          : 'Not verified — last known value only'
      );
      metric(
        metrics,
        'Retail price',
        money(v.retailPriceCents),
        'Pricing review ' + date(v.retailVerifiedAt)
      );
      metric(
        metrics,
        'CJ warehouse stock',
        v.stockVerified && Number.isSafeInteger(v.inventoryQuantity)
          ? String(v.inventoryQuantity)
          : 'Not verified',
        v.stockVerified ? 'Verified ' + date(v.stockVerifiedAt) : 'No current stock confirmation'
      );
      metric(
        metrics,
        'Warehouse origin',
        v.stockVerified ? v.origin || 'Not verified' : 'Not verified',
        'Supplier country of stock; not a delivery promise'
      );
      card.body.append(metrics);
      if (v.reason) card.body.append(e('p', 'notice', 'Reason: ' + v.reason));
      if (v.approvalIssues.length) {
        const ul = e('ul', 'checks-list');
        for (const issue of v.approvalIssues) ul.append(e('li', '', issue));
        card.body.append(ul);
      } else
        card.body.append(
          e(
            'p',
            'verified-note',
            'Required checks passed for review. Customer checkout and supplier purchases remain disabled.'
          )
        );
      if (!v.fixtureOnly) {
        variantReview(card.body, p, v);
        supplierForm(card.body, p, v);
        shippingForm(card.body, p, v);
        priceForm(card.body, p, v);
        decisionForm(card.body, p, [v], 'variants');
      }
      section.append(card.box);
    }
    root.append(section);
    if (!p.fixtureOnly) decisionForm(root, p, data.variants, 'product');
    if (data.hasMoreVariants)
      root.append(
        e(
          'p',
          'notice',
          'More than 100 variants exist. Full-product approval is blocked; inspect the catalog import limit before continuing.'
        )
      );
    const history = details('03 / Approval & change history', 'detail-section');
    const entries = e('div', 'history-list');
    for (const entry of data.history) {
      const row = e('article', 'history-entry');
      row.append(
        e('strong', '', label(entry.action)),
        e('p', '', entry.actor_email + ' · ' + entry.auth_source + ' · ' + date(entry.created_ms))
      );
      if (entry.reason) row.append(e('p', '', entry.reason));
      const changes = details('View recorded changes', '', false);
      changes.body.append(
        e('pre', '', JSON.stringify({ before: entry.before, after: entry.after }, null, 2))
      );
      row.append(changes.box);
      entries.append(row);
    }
    if (!data.history.length) entries.append(e('p', 'small', 'No decisions recorded yet.'));
    history.body.append(entries);
    root.append(history.box);
    $('product-detail').replaceChildren(root);
  }
  function renderPolicy() {
    const state = session.policy,
      p = state.policy || {},
      root = $('policy-editor'),
      form = e('form'),
      grid = e('div', 'form-grid'),
      inputs = {};
    root.replaceChildren(
      e(
        'p',
        'small',
        'Basis points: 100 = 1%. Saving creates an audited policy version and invalidates all product approvals and pricing reviews. Current version: ' +
          (p.version || 'Not configured') +
          ' · Revision ' +
          state.revision
      )
    );
    for (const [key, title] of [
      ['targetMarginBps', 'Target net margin, basis points'],
      ['markupBps', 'Minimum cost markup, basis points'],
      ['processingVariableBps', 'Payment processing rate, basis points'],
      ['processingFixedCents', 'Fixed payment fee, cents'],
      ['perItemBufferCents', 'Product cost buffer per unit, cents'],
      ['shippingBufferCents', 'Shipping cost buffer, cents'],
      ['maxTotalCents', 'Maximum Sandbox total, cents']
    ])
      inputs[key] = field(grid, key, title, p[key] ?? (key === 'markupBps' ? 0 : ''), 'number', {
        min: 0,
        step: 1,
        required: true
      });
    form.append(grid);
    const allow = check(
      form,
      'allowExceptions',
      'Permit explicitly acknowledged, time-limited margin exceptions',
      p.allowMarginExceptions
    );
    const exgrid = e('div', 'form-grid'),
      min = field(
        exgrid,
        'exceptionMinimumMarginBps',
        'Lowest allowed exception margin, basis points',
        p.exceptionMinimumMarginBps ?? 1000,
        'number',
        { min: 0, step: 1 }
      ),
      hours = field(
        exgrid,
        'exceptionMaxHours',
        'Maximum exception duration, hours',
        p.exceptionMaxHours ?? 24,
        'number',
        { min: 1, max: 168, step: 1 }
      );
    form.append(exgrid);
    const reason = field(
      form,
      'reason',
      'Reason for changing pricing policy (20+ characters)',
      '',
      'textarea',
      { required: true, maxLength: 1000 }
    );
    submit(form, 'Save policy & invalidate existing approvals', async () => {
      if (busy) return;
      const policy = { allowMarginExceptions: allow.checked };
      for (const [k, n] of Object.entries(inputs)) policy[k] = Number(n.value);
      if (allow.checked) {
        policy.exceptionMinimumMarginBps = Number(min.value);
        policy.exceptionMaxHours = Number(hours.value);
      }
      try {
        busy = true;
        const result = await api('policy', {
          expectedRevision: state.revision,
          policy,
          reason: reason.value
        });
        session.policy = result.policy;
        renderPolicy();
        if (selected) await select(selected);
        loadList();
        notice('Pricing policy saved. Existing approvals now require review.');
      } catch (error) {
        errorIn(form, error);
      } finally {
        busy = false;
      }
    });
    root.append(form);
  }
  $('catalog-search').addEventListener('submit', (event) => {
    event.preventDefault();
    page = 1;
    loadList();
  });
  $('product-filter').addEventListener('change', () => {
    page = 1;
    loadList();
  });
  $('catalog-refresh').addEventListener('click', () => {
    loadList();
    if (selected) select(selected);
  });
  $('page-prev').addEventListener('click', () => {
    if (page > 1) {
      page--;
      loadList();
    }
  });
  $('page-next').addEventListener('click', () => {
    if (page < pages) {
      page++;
      loadList();
    }
  });
  async function initialize() {
    try {
      session = await api('session');
      $('admin-identity').textContent = session.actor.email + ' · ' + label(session.actor.source);
      if (session.actor.source === 'local_development')
        $('admin-signout').addEventListener('click', async (event) => {
          event.preventDefault();
          await fetch('/admin/products/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            credentials: 'same-origin'
          });
          locked();
          location.assign('/admin/products/login');
        });
      renderPolicy();
      await loadList();
      notice('Your private catalog is ready. Select a product to begin its review.');
      setInterval(async () => {
        try {
          await api('session');
        } catch (error) {
          notice(error.message, true);
        }
      }, 240000);
    } catch (error) {
      notice(error.message, true);
    }
  }
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  initialize();
})();
