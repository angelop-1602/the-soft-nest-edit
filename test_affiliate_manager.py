#!/usr/bin/env python3
"""Integration tests for the affiliate manager; creates no public sample links."""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml
from html.parser import HTMLParser

SOURCE = Path(__file__).resolve().parent

def build_at(path):
    result = subprocess.run([sys.executable, 'build.py'], cwd=path, capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(result.stdout + '\n' + result.stderr)
    return result.stdout


class PageReader(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.cards = 0
        self.ctas = []
        self.words = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get('class') or '').split()
        if 'affiliate-product' in classes:
            self.cards += 1
        if 'affiliate-product-button' in classes and tag == 'a':
            self.ctas.append(attrs)

    def handle_data(self, data):
        self.words.append(data)

    def get_text(self):
        return ' '.join(self.words)


def read_page(root, page):
    return PageReader((root / 'dist' / page / 'index.html').read_text(encoding='utf-8'))


def test():
    cfg = yaml.safe_load((SOURCE / '.pages.yml').read_text())
    collections = {x['name']: x for x in cfg['content']}
    assert 'posts' in collections and 'products' in collections
    assert collections['products']['path'] == 'content/products'
    assert next(f for f in collections['posts']['fields'] if f['name']=='products')['options']['multiple']
    assert read_page(SOURCE, 'shop').cards == 0, 'Draft products must not appear on public site'

    with tempfile.TemporaryDirectory(prefix='softnest-affiliate-test-') as temp:
        root = Path(temp) / 'site'
        shutil.copytree(
    SOURCE,
    root,
    ignore=shutil.ignore_patterns(
        'dist',
        '__pycache__',
        '.git',
        '*.pyc',
        'uploads'
    )
)
        post_path = root / 'content/posts/cozy-living-room-ideas-on-a-budget.md'
        post = post_path.read_text()
        assert '\n---\n' in post
        post_path.write_text(post.replace('\n---\n', '\nproducts:\n  - content/products/test-woven-lamp.md\n---\n', 1))

        product_file = root / 'content/products/test-woven-lamp.md'
        product_file.write_text('''---
title: Test Woven Lamp
retailer: Example Store
category: Living Room
image: https://example.org/images/lamp.jpg
image_alt: Woven test lamp
summary: For integration testing only. Not a real recommendation.
product_url: https://example.org/products/test-lamp?ref=sample
price_note: ''
affiliate: true
featured_shop: true
published: true
---
Internal integration test product.
''')
        print(build_at(root))
        shop = read_page(root, 'shop')
        article = read_page(root, 'journal/cozy-living-room-ideas-on-a-budget')
        home = read_page(root, '')
        for page in [shop, article, home]:
            assert page.cards == 1, f'Expected one product card, got {page.cards}'
            assert 'Test Woven Lamp' in page.get_text()
            assert 'Affiliate disclosure' in page.get_text()
            cta = page.ctas[0]
            assert cta.get('href') == 'https://example.org/products/test-lamp?ref=sample'
            assert {'sponsored', 'nofollow', 'noopener', 'noreferrer'}.issubset(set(cta['rel'].split()))
        assert 'Example Ceramic Vase' not in shop.get_text(), 'Unpublished example draft leaked'

        # Draft product does not render anywhere after changing the published flag.
        product_file.write_text(product_file.read_text().replace('published: true', 'published: false'))
        build_at(root)
        assert read_page(root, 'shop').cards == 0
        assert read_page(root, 'journal/cozy-living-room-ideas-on-a-budget').cards == 0

        # Security: invalid schemes cannot become a public merchant link.
        product_file.write_text(product_file.read_text().replace('published: false', 'published: true').replace('https://example.org/products/test-lamp?ref=sample', 'javascript:alert(1)'))
        build_at(root)
        assert read_page(root, 'shop').cards == 0
    print('All Affiliate Product Manager integration checks passed.')

if __name__ == '__main__':
    test()
