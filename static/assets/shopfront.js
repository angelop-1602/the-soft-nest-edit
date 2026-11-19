/* The Soft Nest Edit — independent storefront (no external cart or payment processor). */
(function () {
  'use strict';
  const SAVE_KEY = 'softnest-saved-products-v1';
  const productSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function savedIds() {
    try {
      const data = JSON.parse(localStorage.getItem(SAVE_KEY) || '[]');
      return Array.isArray(data) ? [...new Set(data.filter(value => typeof value === 'string' && productSlug.test(value)))].slice(0, 200) : [];
    } catch (error) { return []; }
  }
  function writeSaved(ids) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(ids)); return true; }
    catch (error) { return false; }
  }
  function refreshSaveControls() {
    const ids = new Set(savedIds());
    document.querySelectorAll('[data-save-product]').forEach(button => {
      const active = ids.has(button.dataset.saveProduct);
      button.setAttribute('aria-pressed', String(active));
      button.textContent = active ? '♥ Saved — remove' : '♡ Save for later';
    });
    const counter = document.getElementById('saved-count');
    if (counter) counter.textContent = String(ids.size);
  }

  function makeSavedCard(item) {
    const article = document.createElement('article'); article.className = 'store-product-card store-saved-card';
    const imageLink = document.createElement('a'); imageLink.className = 'store-product-image'; imageLink.href = item.url;
    const img = document.createElement('img'); img.src = item.image; img.alt = item.image_alt; img.loading = 'lazy';
    imageLink.append(img); article.append(imageLink);
    const info = document.createElement('div'); info.className = 'store-product-info';
    const category = document.createElement('span'); category.className = 'store-product-category'; category.textContent = item.category;
    const title = document.createElement('h3'); const titleLink = document.createElement('a');
    titleLink.href = item.url; titleLink.textContent = item.title; title.append(titleLink);
    const detail = document.createElement('p'); detail.textContent = item.summary;
    const footer = document.createElement('div'); footer.className = 'store-product-footer';
    const amount = document.createElement('strong'); amount.textContent = item.price_display ? '$' + item.price_display + ' USD' : 'Price coming soon';
    const link = document.createElement('a'); link.href = item.url; link.textContent = 'View details ↗';
    footer.append(amount, link);
    const saveButton = document.createElement('button'); saveButton.type = 'button';
    saveButton.className = 'store-save-button'; saveButton.dataset.saveProduct = item.slug;
    info.append(category, title, detail, footer, saveButton); article.append(info);
    return article;
  }

  function refreshSavedPage() {
    const grid = document.getElementById('saved-product-grid');
    const jsonEl = document.getElementById('saved-catalog-data');
    if (!grid || !jsonEl) return;
    let catalog;
    try { catalog = JSON.parse(jsonEl.textContent); } catch (error) { catalog = []; }
    const available = new Map(catalog.filter(p => productSlug.test(p.slug)).map(p => [p.slug, p]));
    const originalIds = savedIds();
    const ids = originalIds.filter(id => available.has(id));
    if (ids.length !== originalIds.length) writeSaved(ids);
    grid.replaceChildren(...ids.map(id => makeSavedCard(available.get(id))));
    const empty = document.getElementById('saved-empty'); if (empty) empty.hidden = ids.length > 0;
    const count = document.getElementById('store-saved-total');
    if (count) count.textContent = ids.length ? `${ids.length} saved ${ids.length === 1 ? 'piece' : 'pieces'}` : '';
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-save-product]');
    if (!button) return;
    const slug = button.dataset.saveProduct;
    if (!productSlug.test(slug)) return;
    const saved = savedIds(); const idx = saved.indexOf(slug);
    if (idx >= 0) saved.splice(idx, 1);
    else saved.push(slug);
    if (!writeSaved(saved)) {
      const message = document.getElementById('store-save-status');
      if (message) message.textContent = 'Your browser is blocking saved products. Enable local storage to save items.';
      return;
    }
    refreshSavedPage(); refreshSaveControls();
  });
  window.addEventListener('storage', event => {
    if (event.key === SAVE_KEY) { refreshSavedPage(); refreshSaveControls(); }
  });

  const search = document.getElementById('decor-search');
  if (search) {
    const tiles = Array.from(document.querySelectorAll('[data-decor-search]'));
    const count = document.getElementById('decor-count');
    const empty = document.getElementById('decor-empty');
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase(); let visible = 0;
      for (const tile of tiles) {
        const matches = !query || (tile.dataset.decorSearch || '').includes(query);
        tile.hidden = !matches; if (matches) visible += 1;
      }
      if (count) count.textContent = visible + (visible === 1 ? ' collection' : ' collections');
      if (empty) empty.hidden = visible !== 0;
    };
    search.addEventListener('input', filter);
  }

  const container = document.getElementById('filtered-products');
  if (container) {
    const cards = Array.from(container.querySelectorAll('.store-product-card'));
    const input = document.getElementById('store-product-search');
    const sort = document.getElementById('store-product-sort');
    const counter = document.getElementById('store-filter-count');
    const empty = document.getElementById('store-filter-empty');
    const chips = Array.from(document.querySelectorAll('[data-store-filter]'));
    let subcategory = 'all';
    const sortCards = () => {
      const mode = sort ? sort.value : 'featured';
      const price = card => card.dataset.price ? Number(card.dataset.price) : null;
      const ordered = cards.map((card, i) => ({card, i})).sort((a,b) => {
        if (mode === 'az') return a.card.dataset.title.localeCompare(b.card.dataset.title) || a.i - b.i;
        if (mode === 'low' || mode === 'high') {
          const x = price(a.card), y = price(b.card);
          if (x === null && y === null) return a.i - b.i;
          if (x === null) return 1;
          if (y === null) return -1;
          return (mode === 'low' ? x-y : y-x) || a.i-b.i;
        }
        return a.i-b.i;
      });
      ordered.forEach(entry => container.append(entry.card));
    };
    const filterCards = () => {
      const term = input ? input.value.trim().toLocaleLowerCase() : '';
      let visible = 0;
      for (const card of cards) {
        const matches = (subcategory === 'all' || card.dataset.subcategory === subcategory)
          && (!term || (card.dataset.productSearch || '').includes(term));
        card.hidden = !matches; if (matches) visible += 1;
      }
      if (counter) counter.textContent = visible + (visible === 1 ? ' product' : ' products');
      if (empty) empty.hidden = visible !== 0;
    };
    chips.forEach(button => button.addEventListener('click', () => {
      subcategory = button.dataset.storeFilter;
      chips.forEach(chip => {
        const active = chip === button;
        chip.classList.toggle('active', active); chip.setAttribute('aria-pressed', String(active));
      });
      filterCards();
    }));
    if (input) input.addEventListener('input', filterCards);
    if (sort) sort.addEventListener('change', sortCards);
    sortCards(); filterCards();
  }
  refreshSavedPage(); refreshSaveControls();
})();
