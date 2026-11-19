(function () {
  'use strict';
  const search = document.querySelector('#decor-search');
  if (search) {
    const tiles = Array.from(document.querySelectorAll('[data-decor-search]'));
    const count = document.querySelector('#decor-count');
    const empty = document.querySelector('#decor-empty');
    const filter = function () {
      const term = search.value.trim().toLocaleLowerCase();
      let visible = 0;
      for (const tile of tiles) {
        const shown = !term || (tile.dataset.decorSearch || '').includes(term);
        tile.hidden = !shown;
        if (shown) visible++;
      }
      if (count) count.textContent = visible + (visible === 1 ? ' collection' : ' collections');
      if (empty) empty.hidden = visible !== 0;
    };
    search.addEventListener('input', filter);
  }
  const buttons = Array.from(document.querySelectorAll('[data-store-filter]'));
  if (buttons.length) {
    const cards = Array.from(document.querySelectorAll('#filtered-products .store-product-card'));
    const count = document.querySelector('#store-filter-count');
    const empty = document.querySelector('#store-filter-empty');
    for (const button of buttons) button.addEventListener('click', function () {
      const selected = button.dataset.storeFilter;
      for (const other of buttons) {
        const active = other === button;
        other.classList.toggle('active', active);
        other.setAttribute('aria-pressed', String(active));
      }
      let visible = 0;
      for (const card of cards) {
        const match = selected === 'all' || card.dataset.subcategory === selected;
        card.hidden = !match;
        if (match) visible++;
      }
      if (count) count.textContent = visible + (visible === 1 ? ' product' : ' products');
      if (empty) empty.hidden = visible !== 0;
    });
  }
})();
