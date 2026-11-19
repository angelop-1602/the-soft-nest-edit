#!/usr/bin/env python3
"""Integration checks for The Soft Nest Edit 24-collection storefront.

Run from the repository root after `python build.py`: python test_storefront.py
Creates test-only listings in a temporary checkout, never your production catalog.
"""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import yaml

ROOT = Path(__file__).resolve().parent
CATALOG = yaml.safe_load((ROOT / 'data/shop_categories.yml').read_text(encoding='utf-8'))
assert len(CATALOG) == 24
assert len({c['slug'] for c in CATALOG}) == 24
assert all(c['subcategories'] for c in CATALOG)


def run_build(folder):
    run = subprocess.run([sys.executable, 'build.py'], cwd=folder, capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + '\n' + run.stderr


def page(folder, route):
    return (folder / 'dist' / route / 'index.html').read_text(encoding='utf-8')


def indexed_urls(folder):
    root = ET.parse(folder / 'dist' / 'sitemap.xml')
    return [x.text for x in root.findall('.//{*}loc')]


run_build(ROOT)
shop = page(ROOT, 'shop')
assert '>All categories</a>' not in shop
assert shop.count('data-collection-filter=') == len(CATALOG) + 1
assert 'aria-label="Filter products by collection"' in shop
assert 'id="store-available-only"' in shop
assert 'id="store-product-search"' in shop
assert 'Good things are taking shape.' in shop
assert 'Most popular' not in shop, 'Sales popularity must not be invented'
for c in CATALOG:
    assert (ROOT / 'dist' / 'shop' / 'category' / c['slug'] / 'index.html').exists()
    assert (ROOT / 'static' / 'assets' / 'icons' / 'lucide' / (c['icon'] + '.svg')).is_file()

with tempfile.TemporaryDirectory(prefix='softnest-store-test-') as tmp:
    temp = Path(tmp) / 'site'
    shutil.copytree(ROOT, temp, ignore=shutil.ignore_patterns('dist', '.git', '.local', '.wrangler', '.dev.vars*', '.env*', '__pycache__', 'uploads', '*.pyc'))
    (temp / 'content/store-products/test-lamp.md').write_text('''---
title: Test Interior Floor Lamp
category: Lighting & Lamps
subcategory: Floor Lamps
image: https://example.org/images/lamp.jpg
image_alt: Simple floor lamp
summary: Test-only listing for product page integration checks.
price_usd: 49.99
checkout_url: https://www.paypal.com/checkoutnow?token=TEST-ONLY
shipping_details: Verified shipping details must be entered before any real product is published.
return_details: Verified return terms must be entered before any real product is published.
published: true
featured: true
---
Test-only unpublished in real repository.
''', encoding='utf-8')
    run_build(temp)
    lamp = page(temp, 'shop/product/test-lamp')
    category = page(temp, 'shop/category/lighting-lamps')
    home = page(temp, '')
    assert '$49.99' in lamp and 'www.paypal.com/checkoutnow' in lamp
    assert 'Floor Lamps' in category and 'Test Interior Floor Lamp' in category
    assert 'Test Interior Floor Lamp' in home
    assert 'data-collection="lighting-lamps" data-available="true"' in page(temp, 'shop')
    assert any('/shop/product/test-lamp/' in u for u in indexed_urls(temp))
    assert any('/shop/category/lighting-lamps/' in u for u in indexed_urls(temp))
    assert not any('/shop/category/wall-decor/' in u for u in indexed_urls(temp))
    assert 'noindex,follow' in page(temp, 'shop/category/wall-decor')

    file = temp / 'content/store-products/test-lamp.md'
    file.write_text(file.read_text().replace('https://www.paypal.com/checkoutnow?token=TEST-ONLY', 'javascript:alert(1)'), encoding='utf-8')
    run_build(temp)
    assert not (temp / 'dist/shop/product/test-lamp/index.html').exists()
    assert not any('/shop/product/test-lamp/' in u for u in indexed_urls(temp))

print('PASS: 24 collections, browse search, product/detail routing, safe publishing, noindex for empty collections.')
