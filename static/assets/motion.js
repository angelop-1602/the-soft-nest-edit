/* The Soft Nest Edit — optional progressive motion enhancements. */
(function () {
  'use strict';

  const header = document.querySelector('.site-header');
  if (header) {
    let scrollScheduled = false;
    const updateHeader = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 12);
      scrollScheduled = false;
    };
    updateHeader();
    window.addEventListener('scroll', () => {
      if (scrollScheduled) return;
      scrollScheduled = true;
      window.requestAnimationFrame(updateHeader);
    }, { passive: true });
  }

  // Keep the sticky navigation predictable for keyboard and mobile users.
  const nav = document.getElementById('site-nav');
  const toggle = document.querySelector('.mobile-toggle');
  if (nav && toggle) {
    const closeNav = () => {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    };
    nav.querySelectorAll('a').forEach(link => link.addEventListener('click', closeNav));
    document.addEventListener('pointerdown', event => {
      if (nav.classList.contains('open') && !nav.contains(event.target) && !toggle.contains(event.target)) {
        closeNav();
      }
    });
  }

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion || !('IntersectionObserver' in window)) return;

  const selectors = [
    '.intro-layout > *',
    '.filter-bar',
    '.simple-page > .micro-title',
    '.simple-page > h1',
    '.simple-page > p',
    '.simple-page > .btn',
    '.legal-page > .prose',
    '.legal-page > .read-link',
    '.section-heading > *',
    '.category-card',
    '.post-card',
    '.quote-banner .shell',
    '.shop-image',
    '.shop-copy',
    '.shop-guide',
    '.store-hero-copy > *',
    '.store-hero-photo',
    '.shop-introduction > *',
    '.store-tools',
    '.collection-tile',
    '.store-product-card',
    '.store-collection-header > *',
    '.store-subcategories',
    '.store-detail > *',
    '.store-detail-foot > *',
    '.shop-soft-launch',
    '.store-journal-cta > *',
    '.affiliate-product',
    '.closing-content',
    '.sub-hero > *',
    '.article-header > *',
    '.article-body-layout .prose > h2',
    '.article-body-layout .prose > h3',
    '.article-body-layout .prose > blockquote',
    '.article-body-layout .prose > ul',
    '.article-body-layout .prose > ol',
    '.article-body-layout .article-end',
    '.article-hero-image',
    '.article-content > .article-disclosure',
    '.article-product-section',
    '.curated-products-section > .section-heading',
    '.curated-products-intro',
    '.shop-guides-heading',
    '.shop-disclaimer',
    '.related-section > .section-heading',
    '.footer-grid > *',
    '.footer-bottom'
  ];
  const targets = Array.from(document.querySelectorAll(selectors.join(',')));
  if (!targets.length) return;

  // Make only offscreen elements eligible for reveal, avoiding a flash of
  // disappearing content during initial page load or with slow connections.
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const offscreenTargets = targets.filter(element => {
    const box = element.getBoundingClientRect();
    return box.top > viewportHeight * 0.88;
  });
  if (!offscreenTargets.length) return;

  const observer = new IntersectionObserver((entries, io) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      io.unobserve(entry.target);
    }
  }, { threshold: 0.08, rootMargin: '0px 0px -36px 0px' });

  offscreenTargets.forEach((element, index) => {
    element.classList.add('reveal-item');
    element.style.setProperty('--reveal-delay', `${(index % 3) * 65}ms`);
    observer.observe(element);
  });
  document.documentElement.classList.add('motion-enabled');
})();
