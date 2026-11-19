/** Client-only rendering of the public, non-purchasable supplier catalog staging page. */
(() => {
  'use strict';
  const grid = document.getElementById('cj-preview-grid');
  if (!grid) return;
  const msg = document.getElementById('cj-preview-message');
  const count = document.getElementById('cj-preview-count');
  const prev = document.getElementById('cj-preview-previous');
  const next = document.getElementById('cj-preview-next');
  const pageLabel = document.getElementById('cj-preview-page-label');
  const input = document.getElementById('cj-preview-search');
  let currentPage = 1;
  let products = [];
  let totalPages = 0;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function productCard(item) {
    const article = element('article', 'store-product-card cj-preview-card');
    const media = element('div', 'store-product-image cj-preview-image');
    if (item.image && /^https:\/\//i.test(item.image)) {
      const image = element('img');
      image.src = item.image;
      image.alt = item.title || 'Supplier catalog product';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      media.append(image);
    } else media.append(element('span', 'cj-preview-no-image', 'Supplier image unavailable'));
    media.append(element('span', 'store-preview-tag', 'Under review'));
    article.append(media);

    const info = element('div', 'store-product-info');
    info.append(element('span', 'store-product-category', 'CJ supplier catalog · preview'));
    info.append(element('h3', '', item.title || 'Untitled product'));
    info.append(element('p', 'cj-preview-identity', `CJ product ID: ${item.id}`));
    const details = element('div', 'cj-preview-variants');
    details.append(element('strong', '', `${item.variantCount} supplier variant${item.variantCount === 1 ? '' : 's'}`));
    const list = element('ul');
    for (const variant of item.variants || []) {
      list.append(element('li', '', `${variant.label}${variant.sku ? ` · ${variant.sku}` : ''}`));
    }
    if (item.hasMoreVariants) list.append(element('li', '', 'Other variants not shown…'));
    if (!list.children.length) list.append(element('li', '', 'Variant details not yet available'));
    details.append(list);
    info.append(details);
    const footer = element('div', 'store-product-footer');
    footer.append(element('small', '', 'Price & shipping not verified'));
    info.append(footer);
    article.append(info);
    return article;
  }

  function filterProducts() {
    const term = input.value.toLocaleLowerCase().trim();
    const filtered = products.filter(p => `${p.title} ${p.id} ${(p.variants || []).map(v => `${v.label} ${v.sku}`).join(' ')}`.toLocaleLowerCase().includes(term));
    grid.replaceChildren(...filtered.map(productCard));
    count.textContent = `${filtered.length} shown on this page`;
    if (products.length && !filtered.length) msg.textContent = 'No products match your search on this page.';
    else if (products.length) msg.textContent = '';
  }

  async function load(page) {
    msg.textContent = 'Loading supplier records…';
    prev.disabled = true;
    next.disabled = true;
    let data;
    try {
      const response = await fetch(`/api/catalog/preview?page=${page}`, {
        headers: { 'Accept': 'application/json' }, cache: 'no-store', credentials: 'same-origin'
      });
      if (!response.ok) throw new Error('Catalog request failed');
      data = await response.json();
      if (!Array.isArray(data.products) || data.checkoutEnabled !== false) throw new Error('Invalid preview response');
    } catch {
      products = [];
      grid.replaceChildren();
      count.textContent = 'Catalog unavailable';
      msg.textContent = 'The preview cannot load yet. Check that the CJ sync patch and D1 migrations are deployed, then try again.';
      pageLabel.textContent = '';
      return;
    }
    currentPage = page;
    totalPages = data.pages;
    products = data.products;
    input.value = '';
    if (!products.length) {
      grid.replaceChildren();
      msg.textContent = data.supplierSyncStatus === 'never'
        ? 'CJ has not completed its first scheduled import. The catalog will appear here after the first successful sync.'
        : data.supplierSyncStatus === 'error'
          ? 'The latest CJ import reported an error. Check /api/catalog/status for the error code.'
          : 'No supplier records are available on this page yet.';
      count.textContent = `0 records shown · ${data.total} total imported`;
    } else {
      msg.textContent = '';
      filterProducts();
      count.textContent = `${products.length} shown · ${data.total} total imported`;
    }
    pageLabel.textContent = totalPages ? `Page ${page} of ${totalPages}` : 'No pages yet';
    prev.disabled = page <= 1;
    next.disabled = page >= totalPages;
  }
  prev.addEventListener('click', () => { if (currentPage > 1) load(currentPage - 1); });
  next.addEventListener('click', () => { if (currentPage < totalPages) load(currentPage + 1); });
  input.addEventListener('input', filterProducts);
  load(1);
})();
