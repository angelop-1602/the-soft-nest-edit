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

  const container = document.getElementById('filtered-products');
  if (container) {
    const cards = Array.from(container.querySelectorAll('.store-product-card'));
    const input = document.getElementById('store-product-search');
    const sort = document.getElementById('store-product-sort');
    const counter = document.getElementById('store-filter-count');
    const empty = document.getElementById('store-filter-empty');
    const chips = Array.from(document.querySelectorAll('[data-store-filter]'));
    const collections = Array.from(document.querySelectorAll('[data-collection-filter]'));
    const expand = document.getElementById('collection-expand');
    const available = document.getElementById('store-available-only');
    const activeFilters = document.getElementById('store-active-filters');
    const activeLabel = document.getElementById('store-active-label');
    const reset = document.getElementById('store-filter-reset');
    const heading = document.getElementById('store-products-title');
    const emptyTitle = document.getElementById('store-empty-title');
    const emptyMessage = document.getElementById('store-empty-message');
    const defaultHeading = heading ? heading.innerHTML : '';
    const defaultEmptyTitle = emptyTitle ? emptyTitle.textContent : '';
    const defaultEmptyMessage = emptyMessage ? emptyMessage.textContent : '';
    let collection = 'all';
    let subcategory = 'all';
    let expanded = false;

    const refreshCollections = () => {
      collections.forEach(button => {
        const selected = button.dataset.collectionFilter === collection;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
        // Keep the selected collection visible when the rest are collapsed.
        button.hidden = !expanded && button.hasAttribute('data-more-collection') && !selected;
      });
      if (expand) {
        expand.hidden = false;
        expand.setAttribute('aria-expanded', String(expanded));
        expand.firstChild.textContent = expanded ? 'Show fewer collections ' : `View all ${collections.length - 1} collections `;
      }
    };
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
        const matches = (collection === 'all' || card.dataset.collection === collection)
          && (subcategory === 'all' || card.dataset.subcategory === subcategory)
          && (!term || (card.dataset.productSearch || '').includes(term))
          && (!available || !available.checked || card.dataset.available === 'true');
        card.hidden = !matches; if (matches) visible += 1;
      }
      const selected = collections.find(button => button.dataset.collectionFilter === collection);
      const name = selected ? selected.dataset.collectionName : '';
      const descriptions = [];
      if (collection !== 'all') descriptions.push(name);
      if (term) descriptions.push(`Search: ${input.value.trim()}`);
      if (available && available.checked) descriptions.push('Available to order');
      if (counter) counter.textContent = visible + (visible === 1 ? ' product' : ' products')
        + (descriptions.length ? ' · ' + descriptions.join(' · ') : '');
      if (activeFilters) activeFilters.hidden = descriptions.length === 0;
      if (activeLabel) activeLabel.textContent = descriptions.join(' · ');
      if (heading) {
        if (collection === 'all') heading.innerHTML = defaultHeading;
        else heading.textContent = name;
      }
      if (empty) empty.hidden = visible !== 0;
      if (emptyTitle && emptyMessage) {
        if (term) {
          emptyTitle.textContent = 'No pieces found this time.';
          emptyMessage.textContent = 'Try a different search or clear your filters to explore more pieces.';
        } else if (available && available.checked) {
          emptyTitle.textContent = 'Nothing ready to order just yet.';
          emptyMessage.textContent = 'Clear the availability filter to explore previews. Each product will show when it is ready to order.';
        } else if (collection !== 'all') {
          emptyTitle.textContent = 'A little more to come.';
          emptyMessage.textContent = `We are still curating ${name.toLowerCase()}. Choose another collection or clear your filters to see all pieces.`;
        } else {
          emptyTitle.textContent = defaultEmptyTitle;
          emptyMessage.textContent = defaultEmptyMessage;
        }
      }
    };
    chips.forEach(button => button.addEventListener('click', () => {
      subcategory = button.dataset.storeFilter;
      chips.forEach(chip => {
        const active = chip === button;
        chip.classList.toggle('active', active); chip.setAttribute('aria-pressed', String(active));
      });
      filterCards();
    }));
    collections.forEach(button => button.addEventListener('click', () => {
      collection = button.dataset.collectionFilter;
      refreshCollections(); filterCards();
    }));
    if (expand) expand.addEventListener('click', () => {
      expanded = !expanded;
      refreshCollections();
    });
    if (available) available.addEventListener('change', filterCards);
    if (reset) reset.addEventListener('click', () => {
      collection = 'all'; subcategory = 'all';
      if (input) input.value = '';
      if (available) available.checked = false;
      refreshCollections(); filterCards();
    });
    if (input) input.addEventListener('input', filterCards);
    if (sort) sort.addEventListener('change', sortCards);
    refreshCollections(); sortCards(); filterCards();
  }
  refreshSavedPage(); refreshSaveControls();
})();
