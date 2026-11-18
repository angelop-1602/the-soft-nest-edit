(function () {
  'use strict';
  const toggle = document.querySelector('.mobile-toggle');
  const nav = document.querySelector('#site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      const isOpen = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && nav.classList.contains('open')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }
  const search = document.getElementById('post-search');
  if (search) {
    const cards = [...document.querySelectorAll('#post-list .post-card')];
    const empty = document.querySelector('#empty-search');
    search.addEventListener('input', function () {
      const query = search.value.toLocaleLowerCase().trim();
      let visible = 0;
      for (const card of cards) {
        const matches = !query || (card.dataset.search || '').includes(query);
        card.hidden = !matches;
        if (matches) visible += 1;
      }
      if (empty) empty.hidden = visible !== 0;
    });
  }
})();
