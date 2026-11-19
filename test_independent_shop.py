#!/usr/bin/env python3
"""Regression tests for custom shop catalog previews, search, saved-list and sales gates."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

SOURCE = Path(__file__).resolve().parent


def build(root):
    result = subprocess.run([sys.executable, 'build.py'], cwd=root, text=True,
                            capture_output=True)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr


def read(root, path):
    return (root / 'dist' / path / 'index.html').read_text(encoding='utf-8')


def sitemap(root):
    doc = ET.parse(root / 'dist/sitemap.xml')
    return [x.text for x in doc.findall('.//{*}loc')]


with tempfile.TemporaryDirectory(prefix='softnest-custom-store-') as folder:
    root = Path(folder) / 'site'
    shutil.copytree(SOURCE, root, ignore=shutil.ignore_patterns('dist', '.git', '.local', '.wrangler', '.dev.vars*', '.env*', '__pycache__', 'uploads', '*.pyc'))
    directory = root / 'content/store-products'
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'preview-vase.md').write_text('''---
title: Preview Handmade Ceramic Vase
category: Vases & Decorative Containers
subcategory: Ceramic Vases
image: https://example.org/vase.jpg
image_alt: Cream stoneware vase
summary: Simple decorative vase in warm neutral ceramic for shelves and consoles.
published: true
ready_to_sell: false
featured: true
---
Internal sourcing notes.
''', encoding='utf-8')
    (directory / 'ready-lamp.md').write_text('''---
title: Ready Interior Table Lamp
category: Lighting & Lamps
subcategory: Table Lamps
image: https://example.org/lamp.jpg
image_alt: Warm table lamp
summary: A cozy lamp with warm light for bedside tables and living rooms.
price_usd: 49.99
checkout_url: https://www.paypal.com/checkoutnow?token=TEST-ONLY
shipping_details: Verified shipping to the US.
return_details: Verified return terms.
ready_to_sell: true
published: true
featured: false
sku: PRIVATE-CJ-SKU-123
---
Internal sourcing notes.
''', encoding='utf-8')
    build(root)
    shop = read(root, 'shop')
    vase = read(root, 'shop/product/preview-vase')
    lamp = read(root, 'shop/product/ready-lamp')
    saved = read(root, 'shop/saved')
    urls = sitemap(root)
    assert 'Preview Handmade Ceramic Vase' in shop and 'Ready Interior Table Lamp' in shop
    assert 'Find a product' in shop and 'Price: low to high' in shop
    assert 'Not yet available to order' in vase and 'Buy securely' not in vase
    assert 'Buy securely' in lamp and 'www.paypal.com/checkoutnow' in lamp
    assert 'PRIVATE-CJ-SKU-123' not in lamp
    assert '"offers"' not in vase and '"offers"' in lamp
    assert 'noindex,follow' in vase and 'noindex,follow' not in lamp
    assert 'noindex,follow' in saved and 'saved-catalog-data' in saved
    assert 'shop/product/ready-lamp/' in ' '.join(urls)
    assert 'shop/product/preview-vase/' not in ' '.join(urls)
    assert 'shop/saved/' not in ' '.join(urls)
    assert 'noindex,follow' in read(root, 'shop/category/vases-decorative-containers')
    assert 'noindex,follow' not in read(root, 'shop/category/lighting-lamps')
    assert (root / 'dist/assets/store-enhancements.css').is_file()
    assert (root / 'dist/assets/shopfront.js').is_file()

    # If checkout details become incomplete, the Buy button must disappear.
    file = directory / 'ready-lamp.md'
    file.write_text(file.read_text().replace('shipping_details: Verified shipping to the US.\n', ''), encoding='utf-8')
    build(root)
    assert 'Not yet available to order' in read(root, 'shop/product/ready-lamp')
    assert 'Buy securely' not in read(root, 'shop/product/ready-lamp')

    # Invalid checkout URLs cannot be rendered as public links.
    file.write_text(file.read_text().replace('https://www.paypal.com/checkoutnow?token=TEST-ONLY', 'javascript:alert(1)'), encoding='utf-8')
    build(root)
    assert not (root / 'dist/shop/product/ready-lamp/index.html').exists()

print('PASS: preview catalog, safe checkout gate, search/sort, saved products, SEO and private SKU checks')
