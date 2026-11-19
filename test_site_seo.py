"""Regression checks for generated SEO metadata, motion assets, and URLs.

Run after `python build.py`: `python test_site_seo.py`.
Uses only Python's standard library.
"""
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).parent
DIST = ROOT / 'dist'
assert (DIST / 'index.html').is_file(), 'Run python build.py before testing.'


def meta_content(html, tag):
    match = re.search(r'<meta\s+[^>]*?(?:name|property)="' + re.escape(tag) + r'"[^>]*?content="([^"]*)"', html)
    return match.group(1) if match else None


def canonical(html):
    match = re.search(r'<link\s+rel="canonical"\s+href="([^"]+)"', html)
    return match.group(1) if match else None


def schemas(html):
    return [json.loads(raw) for raw in re.findall(
        r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL)]


all_html = [p for p in DIST.rglob('index.html')]
assert all_html, 'No generated HTML files found.'
for page in all_html:
    html = page.read_text(encoding='utf-8')
    assert '<meta name="description"' in html, f'{page}: missing description'
    assert canonical(html) and canonical(html).startswith('https://'), f'{page}: invalid canonical URL'
    assert '/assets/motion.css' in html and '/assets/motion.js' in html, f'{page}: missing animation assets'
    assert 'http://localhost' not in html, f'{page}: local URL leaked to production output'
    assert (meta_content(html, 'og:image') or '').startswith('https://'), f'{page}: social image must be absolute'
    for data in schemas(html):
        if data.get('@type') == 'BlogPosting':
            assert data['author']['name'] == 'The Soft Nest Edit'
            assert data['mainEntityOfPage']['@id'] == canonical(html)
            assert data['image'][0].startswith('https://')
            assert data.get('datePublished')
        if data.get('@type') == 'BreadcrumbList':
            assert len(data['itemListElement']) == 4

for private in ('admin', '404'):
    html = (DIST / private / 'index.html').read_text(encoding='utf-8')
    assert 'noindex,nofollow' in html, f'{private}: not excluded from indexing'

site = ET.parse(DIST / 'sitemap.xml')
urls = [e.text for e in site.findall('.//{*}loc')]
assert urls and all(x.startswith('https://') for x in urls)
assert not any('/admin/' in u or '/404/' in u for u in urls)
ET.parse(DIST / 'rss.xml')
assert (DIST / 'robots.txt').read_text().find('sitemap.xml') >= 0
assert (DIST / 'assets/motion.css').exists() and (DIST / 'assets/motion.js').exists()
print(f'PASS: {len(all_html)} pages, {len(urls)} sitemap entries, valid RSS and motion assets')
