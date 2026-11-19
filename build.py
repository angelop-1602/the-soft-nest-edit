#!/usr/bin/env python3
"""Static generator for The Soft Nest Edit. Run: python3 build.py"""
import os, json, shutil, html, re
from pathlib import Path
from datetime import date, datetime, time, timezone
from email.utils import format_datetime
from urllib.parse import quote, urlparse
import yaml, mistune
from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).parent
DIST = ROOT / 'dist'
SITE = yaml.safe_load((ROOT / 'data/site.yml').read_text(encoding='utf-8'))
BASE_URL = (SITE.get('site_url') or os.getenv('SITE_URL') or os.getenv('CF_PAGES_URL') or 'http://localhost:8000').rstrip('/')
ENV = Environment(loader=FileSystemLoader(ROOT / 'templates'), autoescape=select_autoescape(['html', 'xml']), trim_blocks=True, lstrip_blocks=True)
MD = mistune.create_markdown(escape=True, plugins=['table', 'strikethrough'])
CATEGORIES = [('Living Room','living-room'),('Bedroom','bedroom'),('Small Spaces','small-spaces'),('Home Organization','home-organization'),('Lifestyle','lifestyle')]
CAT_SLUG = dict(CATEGORIES)
CATEGORY_IMAGES = {
  'Living Room': 'https://images.unsplash.com/photo-1722942631531-5b09fed44978?auto=format&fit=crop&w=960&q=78',
  'Bedroom': 'https://images.unsplash.com/photo-1616594039964-ae9021a400a0?auto=format&fit=crop&w=960&q=78',
  'Small Spaces': 'https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=960&q=78',
  'Home Organization': 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=960&q=78',
  'Lifestyle': 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=960&q=78',
}


# SOFTNEST_STOREFRONT_24_V1 — separate owned-store inventory from Journal affiliate links.
# SOFTNEST_INDEPENDENT_SHOP_V2 — listings can be previews until checkout is verified.
STORE_CATEGORIES = yaml.safe_load((ROOT / 'data/shop_categories.yml').read_text(encoding='utf-8'))
STORE_CATEGORY_BY_NAME = {c['name']: c for c in STORE_CATEGORIES}
STORE_CATEGORY_BY_SLUG = {c['slug']: c for c in STORE_CATEGORIES}


def load_store_product(path):
    """Publish verified catalog information; never show a Buy action without prerequisites."""
    from decimal import Decimal, InvalidOperation
    raw = path.read_text(encoding='utf-8')
    chunks = raw.split('---', 2)
    if len(chunks) != 3 or chunks[0].strip():
        raise ValueError(f'{path}: expected YAML front matter')
    meta = yaml.safe_load(chunks[1]) or {}
    if meta.get('published') is not True:
        return None
    essential = ('title', 'category', 'subcategory', 'image', 'image_alt', 'summary')
    if any(not str(meta.get(field) or '').strip() for field in essential):
        print(f'Warning: {path.name} missing essential catalog details — skipped')
        return None
    category = STORE_CATEGORY_BY_NAME.get(meta['category'])
    if not category or meta['subcategory'] not in category['subcategories']:
        print(f'Warning: {path.name} has unsupported category/subcategory — skipped')
        return None
    slug = path.stem
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
        print(f'Warning: {path.name} has invalid slug — skipped')
        return None
    image = str(meta['image']).strip()
    image_uri = urlparse(image)
    if not (image.startswith('/uploads/') and '..' not in image.split('/') or
            (image_uri.scheme == 'https' and image_uri.netloc and not image_uri.username and not image_uri.password)):
        print(f'Warning: {path.name} has invalid image URL — skipped')
        return None
    raw_price = meta.get('price_usd')
    price_display = ''
    if raw_price is not None and str(raw_price).strip():
        try:
            price = Decimal(str(raw_price))
            if not price.is_finite() or price <= 0 or price.as_tuple().exponent < -2:
                raise InvalidOperation
            price_display = format(price, '.2f')
        except (InvalidOperation, TypeError, ValueError):
            print(f'Warning: {path.name} has invalid USD price — skipped')
            return None
    checkout_url = str(meta.get('checkout_url') or '').strip()
    if checkout_url:
        parsed = urlparse(checkout_url)
        if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or any(ch.isspace() for ch in checkout_url):
            print(f'Warning: {path.name} has invalid HTTPS checkout URL — skipped')
            return None
    # Backward compatible: existing listings with validated URLs remain buyable.
    # New CMS records must explicitly enable ready_to_sell.
    requested_sale = meta.get('ready_to_sell') if 'ready_to_sell' in meta else bool(checkout_url)
    shipping = str(meta.get('shipping_details') or '').strip()
    returns = str(meta.get('return_details') or '').strip()
    is_purchasable = bool(requested_sale and checkout_url and price_display and shipping and returns)
    if requested_sale and not is_purchasable:
        print(f'Warning: {path.name} requested Buy Now but lacks checkout, price, shipping or return terms; displayed as preview')
    return {**meta, 'slug': slug, 'category_slug': category['slug'],
            'url': f'/shop/product/{slug}/', 'checkout_url': checkout_url if is_purchasable else '',
            'price_display': price_display, 'is_purchasable': is_purchasable,
            'shipping_details': shipping, 'return_details': returns,
            'featured': meta.get('featured') is True,
            'sku': str(meta.get('sku') or '').strip()}


store_product_dir = ROOT / 'content/store-products'
store_products = [p for path in store_product_dir.glob('*.md')
                  if (p := load_store_product(path))]
store_products.sort(key=lambda p: (not p['featured'], p['title'].lower()))


def store_product_schema(item):
    data = {'@context': 'https://schema.org', '@type': 'Product',
            'name': item['title'], 'description': item['summary'],
            'image': [absolute_url(item['image'])]}
    # Preview-only listings have no Offer markup; never tell search engines they are for sale.
    if item['is_purchasable']:
        data['offers'] = {'@type': 'Offer', 'url': BASE_URL + item['url'],
                          'priceCurrency': 'USD', 'price': item['price_display']}
    return data


def load_product(path):
    """Return a publicly eligible product, or None for drafts/incomplete entries.

    Products are intentionally static editorial recommendations, not an online store.
    Only explicitly published products with valid HTTPS retailer links appear.
    """
    raw = path.read_text(encoding='utf-8')
    chunks = raw.split('---', 2)
    if len(chunks) != 3 or chunks[0].strip():
        raise ValueError(f'{path}: expected YAML front matter between --- lines')
    meta = yaml.safe_load(chunks[1]) or {}
    if meta.get('published') is not True:
        return None
    required = ['title', 'retailer', 'category', 'summary', 'image', 'image_alt', 'product_url']
    missing = [key for key in required if not meta.get(key)]
    if missing:
        print(f'Warning: unpublished incomplete product {path.name}; missing {missing}')
        return None
    url = str(meta['product_url']).strip()
    parsed = urlparse(url)
    if (parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password
            or any(ch.isspace() for ch in url)):
        print(f'Warning: product {path.name} has invalid HTTPS retailer URL; skipped')
        return None
    image_url = str(meta['image']).strip()
    image_parsed = urlparse(image_url)
    if not (image_url.startswith('/uploads/') or
            (image_parsed.scheme == 'https' and image_parsed.netloc)):
        print(f'Warning: product {path.name} has an invalid image path; skipped')
        return None
    slug = path.stem
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
        print(f'Warning: product {path.name} has an invalid slug; skipped')
        return None
    if meta['category'] not in CAT_SLUG:
        print(f'Warning: product {path.name} has an unsupported category; skipped')
        return None
    return {
        **meta, 'slug': slug, 'product_url': url,
        'affiliate': meta.get('affiliate') is True,
        'featured_shop': meta.get('featured_shop') is True,
        'price_note': str(meta.get('price_note') or '').strip(),
        'category_slug': CAT_SLUG[meta['category']],
    }


# Build the product lookup before resolving references in posts.
product_dir = ROOT / 'content/products'
products = [product for path in product_dir.glob('*.md') if (product := load_product(path))]
products.sort(key=lambda product: (not product['featured_shop'], product['title'].lower()))
products_by_slug = {p['slug']: p for p in products}


def related_products(refs):
    """Resolve Pages CMS references stored as content/products/<slug>.md paths."""
    if not refs:
        return []
    if isinstance(refs, str):
        refs = [refs]
    if not isinstance(refs, list):
        return []
    selected, seen = [], set()
    for reference in refs:
        if not isinstance(reference, str):
            continue
        slug = Path(reference.replace('\\', '/')).stem
        product = products_by_slug.get(slug)
        if product and slug not in seen:
            selected.append(product)
            seen.add(slug)
    return selected


def load_post(path):
    raw = path.read_text(encoding='utf-8')
    chunks = raw.split('---',2)
    if len(chunks) != 3 or chunks[0].strip():
        raise ValueError(f'{path}: expected YAML front matter between --- lines')
    meta = yaml.safe_load(chunks[1]) or {}
    required = ['title','date','description','category','image','image_alt']
    missing = [key for key in required if not meta.get(key)]
    if missing:
        raise ValueError(f'{path}: missing fields {missing}')
    if meta.get('published') is not True:
        return None
    raw_date = meta['date']
    if isinstance(raw_date, (date,datetime)):
        d = raw_date
    else:
        d = date.fromisoformat(str(raw_date)[:10])
    if d > date.today() and os.getenv('INCLUDE_FUTURE_POSTS') != '1':
        return None
    # Only report a modification date that an editor explicitly entered.
    raw_updated = meta.get('updated')
    modified_iso = None
    if raw_updated:
        modified_date = raw_updated.date() if isinstance(raw_updated, datetime) else (
            raw_updated if isinstance(raw_updated, date) else date.fromisoformat(str(raw_updated)[:10]))
        if modified_date < d or modified_date > date.today():
            raise ValueError(f'{path}: updated must be between publication date and today')
        modified_iso = modified_date.isoformat()
    slug = path.stem
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
        raise ValueError(f'Invalid slug: {slug}')
    content_html = MD(chunks[2].strip())
    words = len(re.findall(r'\b\w+\b', chunks[2]))
    linked_products = related_products(meta.get('products', []))
    return {
       **meta, 'linked_products': linked_products,
       'has_affiliate_products': any(p['affiliate'] for p in linked_products),
       'slug':slug, 'date_iso':d.isoformat(), 'modified_iso':modified_iso,
       'date_display':d.strftime('%B %-d, %Y') if os.name!='nt' else d.strftime('%B %d, %Y'),
       'html':content_html, 'reading_minutes':max(2,round(words/200)),
       'url':f'/journal/{slug}/', 'category_slug':CAT_SLUG.get(meta['category'],'lifestyle'),
    }

posts = [p for path in (ROOT / 'content/posts').glob('*.md') if (p := load_post(path))]
posts.sort(key=lambda p:p['date_iso'],reverse=True)

if DIST.exists(): shutil.rmtree(DIST)
DIST.mkdir()
shutil.copytree(ROOT / 'static',DIST,dirs_exist_ok=True)


def absolute_url(value):
    """Resolve locally uploaded images for social previews and structured data."""
    if not value:
        return ''
    value = str(value)
    if value.startswith('https://') or value.startswith('http://'):
        return value
    return BASE_URL + ('/' + value.lstrip('/'))


def breadcrumbs_for(post):
    parts = [('/', 'Home'), ('/journal/', 'Journal'),
             (f'/category/{post["category_slug"]}/', post['category']),
             (post['url'], post['title'])]
    return {'@context': 'https://schema.org', '@type': 'BreadcrumbList',
            'itemListElement': [
                {'@type': 'ListItem', 'position': index,
                 'name': label, 'item': BASE_URL + url}
                for index, (url, label) in enumerate(parts, 1)]}


def article_schema(post):
    url = BASE_URL + post['url']
    publisher = {'@type': 'Organization', 'name': SITE['name'], 'url': BASE_URL + '/'}
    info = {'@context': 'https://schema.org', '@type': 'BlogPosting',
            'headline': post['title'], 'description': post['description'],
            'mainEntityOfPage': {'@type': 'WebPage', '@id': url},
            'url': url, 'image': [absolute_url(post['image'])],
            'datePublished': post['date_iso'],
            'author': publisher, 'publisher': publisher}
    if post.get('modified_iso'):
        info['dateModified'] = post['modified_iso']
    return info


def website_schema():
    publisher = {'@type': 'Organization', 'name': SITE['name'], 'url': BASE_URL + '/'}
    if SITE.get('pinterest_url'):
        publisher['sameAs'] = [SITE['pinterest_url']]
    return {'@context': 'https://schema.org', '@graph': [publisher,
            {'@type': 'WebSite', 'name': SITE['name'], 'url': BASE_URL + '/',
             'publisher': {'@type': 'Organization', 'name': SITE['name'],
                           'url': BASE_URL + '/'}}]}


def render(path, template='page.html', **params):
    url = '/' if not path else '/' + path.strip('/') + '/'
    title = params.get('title') or SITE['name']
    description = params.get('description') or SITE['description']
    image = params.get('og_image') or (posts[0]['image'] if posts else '')
    image_alt = params.get('og_image_alt') or (posts[0]['image_alt'] if posts else '')
    full_url = BASE_URL + url
    context = dict(site=SITE, title=title, description=description,
        current_path=url, canonical=full_url, og_image=absolute_url(image),
        og_image_alt=image_alt, full_url=full_url, website_jsonld=website_schema(),
        posts=posts, featured=[x for x in posts if x.get('featured',False)],
        products=products, featured_products=[p for p in products if p['featured_shop']],
        categories=CATEGORIES, category_images=CATEGORY_IMAGES, year=date.today().year,
        store_categories=STORE_CATEGORIES, store_products=store_products,
        featured_store_products=[p for p in store_products if p['featured']])
    context.update(params)
    output = ENV.get_template(template).render(**context)
    target = DIST / path / 'index.html' if path else DIST / 'index.html'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(output,encoding='utf-8')
    return url

render('', 'home.html', title='Shop Home Decor & Read Styling Ideas | The Soft Nest Edit', page='home')
render('journal','journal.html',title='The Journal | Home Decor Ideas',description='Browse thoughtful decor ideas and easy styling guides for bedrooms, small spaces and cozy living rooms.',page='journal',selected='All',visible_posts=posts)
for category, slug in CATEGORIES:
    matching=[x for x in posts if x['category']==category]
    render(f'category/{slug}', 'journal.html', title=f'{category} Ideas | The Soft Nest Edit', description=f'Browse gentle, practical {category.lower()} inspiration, affordable tips and beautiful home ideas.', page='journal', selected=category, visible_posts=matching)
for post in posts:
    related=[x for x in posts if x['slug']!=post['slug']][:2]
    render(f'journal/{post["slug"]}','article.html',title=post['title']+' | The Soft Nest Edit',description=post['description'], og_image=post['image'], og_image_alt=post['image_alt'],
           page='article', post=post, related=related,
           article_jsonld=article_schema(post), breadcrumb_jsonld=breadcrumbs_for(post))
render('shop', 'shop.html',
       title='Shop Home Decor by Category | The Soft Nest Edit',
       description='Browse curated home decor, from furniture and lighting to wall art, mirrors, rugs and outdoor accents. Explore 24 collections.',
       page='shop')
render('shop/catalog-preview', 'store_cj_preview.html',
       title='CJ Catalog Staging Preview | The Soft Nest Edit',
       description='Unpriced supplier record preview before product approval.',
       page='cj-preview', noindex=True)
for collection in STORE_CATEGORIES:
    matches = [item for item in store_products if item['category_slug'] == collection['slug']]
    render(f"shop/category/{collection['slug']}", 'store_category.html',
           title=f"{collection['name']} | Home Decor | The Soft Nest Edit",
           description=f"Explore {collection['name'].lower()} including {', '.join(collection['subcategories'][:4]).lower()}. Shop decor and browse inspiration at The Soft Nest Edit.",
           page='shop', store_category=collection, store_category_products=matches,
           noindex=not any(item['is_purchasable'] for item in matches))
for item in store_products:
    render(f"shop/product/{item['slug']}", 'store_product.html',
           title=f"{item['title']} | The Soft Nest Edit",
           description=item['summary'], page='shop', store_product=item,
           og_image=item['image'], og_image_alt=item['image_alt'],
           store_product_jsonld=store_product_schema(item),
           noindex=not item['is_purchasable'])
render('shop/checkout-test', 'store_paypal_sandbox.html',
       title='PayPal Sandbox Checkout Test | The Soft Nest Edit',
       description='Sandbox-only test of PayPal payment integration. No products sold.',
       page='paypal-sandbox-test', noindex=True)
render('shop/saved', 'store_saved.html', title='Saved Home Decor | The Soft Nest Edit',
       description='Your saved home decor ideas from The Soft Nest Edit.',
       page='saved', noindex=True,
       saved_catalog=[{'slug': p['slug'], 'title': p['title'], 'url': p['url'],
                       'image': p['image'], 'image_alt': p['image_alt'],
                       'category': p['category'], 'summary': p['summary'],
                       'price_display': p['price_display']} for p in store_products])
render('about','simple.html', title='About The Soft Nest Edit | Our Story',
       description='Meet The Soft Nest Edit, a home decor journal sharing approachable decorating advice, cozy room ideas and thoughtful finds.',
       page='about', heading='A home to come back to.', kicker='OUR STORY',
  body="The Soft Nest Edit is a home decor shop and journal for people who want their spaces to feel calm, cozy and truly their own. We believe thoughtful rooms are made one little decision at a time—not by buying everything new. Here you'll find practical styling ideas, helpful small-space inspiration and carefully considered product categories. We write for real homes, real budgets and the little moments that make a place feel lived in.")
render('contact','simple.html', title='Contact The Soft Nest Edit',
       description='Connect with The Soft Nest Edit about home decor ideas, editorial content and potential collaborations.',
       page='contact',heading="Let's keep in touch.", kicker='CONTACT',
  body='Have a decor question, collaboration idea or note about our content? You can reach us using the contact details below when our public business email is ready. For now, explore the journal and follow our website updates.')
render('affiliate-disclosure','legal.html',title='Affiliate Disclosure | The Soft Nest Edit',
       description='How affiliate links and product recommendations work at The Soft Nest Edit, including potential commissions.',
       page='legal',heading='Affiliate Disclosure',body_html='''<p>The Soft Nest Edit may be supported by affiliate links. Some shopping guides or articles may contain these links. If you click a qualifying affiliate link and make a purchase, we may receive a commission at no additional cost to you.</p><p>When a post contains affiliate links, we aim to make that relationship clear near the recommendation and provide useful context about why a product may suit a particular space. We do not present untested products as personally tested.</p><p>We identify affiliate links near relevant recommendations and in product cards where appropriate. The presence of a product category or store name does not, by itself, imply a paid relationship.</p><p>As an Amazon Associate I earn from qualifying purchases.</p><p>Any claims about product quality, pricing, stock or suitability should be checked on the retailer's official site before purchasing.</p>''')
render('privacy','legal.html',title='Privacy Policy | The Soft Nest Edit',
       description='Read The Soft Nest Edit privacy policy and how third-party hosting and links may process visitor information.',
       page='legal',heading='Privacy Policy',body_html='''<p><strong>Last updated:</strong> November 18, 2026</p><p>This website is served as a static storefront and journal. The optional Saved products list uses browser local storage to keep product identifiers on your device; it does not create an account or transmit your saved list to us. We do not collect payment card details directly. When checkout is available, it takes place through an external payment provider. We may receive customer contact, shipping and order details from that provider and share the information necessary for order fulfillment with our supplier and delivery partners. Review this policy against your actual provider terms before enabling sales.</p><p>Our hosting provider may process routine server and request information as part of delivering the website. We also load example photography from Unsplash and web fonts from Google Fonts; those services can receive requests from a visitor's browser, including network information such as IP address. External websites we link to, including Pinterest and merchants if added later, follow their own privacy policies.</p><p>If we add analytics, forms, comments, advertising or affiliate network tracking, this policy must be reviewed and updated before those features go live. Additional rights or disclosures may apply depending on where visitors are located.</p><p>For questions about personal data, use the business contact information published on our Contact page once available.</p><p><em>This template is not legal advice. Review and tailor it before launching your business.</em></p>''')
render('admin','admin.html',title='Editor access | The Soft Nest Edit',page='admin')
render('404','simple.html',title='Page not found | The Soft Nest Edit',
       description='This page is not available. Return to The Soft Nest Edit journal for home decor inspiration.',
       page='404',heading='This page has wandered off.',kicker='404 — PAGE NOT FOUND',body='We could not find that page. Head back to our journal to find something lovely.')
(DIST / '404.html').write_text((DIST / '404/index.html').read_text(encoding='utf-8'),encoding='utf-8')

# Search engine discovery and feed.
import xml.etree.ElementTree as ET
root=ET.Element('urlset',xmlns='http://www.sitemaps.org/schemas/sitemap/0.9')
page_paths=['/','/journal/','/about/','/shop/','/contact/','/affiliate-disclosure/','/privacy/'] + [p['url'] for p in posts] + [f'/category/{slug}/' for _,slug in CATEGORIES] + [f"/shop/category/{c['slug']}/" for c in STORE_CATEGORIES if any(p['category_slug'] == c['slug'] and p['is_purchasable'] for p in store_products)] + [p['url'] for p in store_products if p['is_purchasable']]
posts_by_url = {post['url']: post for post in posts}
for location in page_paths:
    node=ET.SubElement(root,'url')
    ET.SubElement(node,'loc').text=BASE_URL+location
    # Only provide lastmod when an editor has documented a meaningful update.
    if location in posts_by_url and posts_by_url[location].get('modified_iso'):
        ET.SubElement(node,'lastmod').text=posts_by_url[location]['modified_iso']
ET.ElementTree(root).write(DIST / 'sitemap.xml',encoding='utf-8',xml_declaration=True)
(DIST/'robots.txt').write_text('User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: '+BASE_URL+'/sitemap.xml\n',encoding='utf-8')
feed=ET.Element('rss',version='2.0'); channel=ET.SubElement(feed,'channel')
for tag,val in [('title',SITE['name']),('link',BASE_URL),('description',SITE['description'])]: ET.SubElement(channel,tag).text=val
for post in posts:
    item=ET.SubElement(channel,'item')
    published_utc = datetime.combine(date.fromisoformat(post['date_iso']), time.min, tzinfo=timezone.utc)
    for tag,val in [('title',post['title']),('link',BASE_URL+post['url']),('guid',BASE_URL+post['url']),('description',post['description']),('pubDate',format_datetime(published_utc))]: ET.SubElement(item,tag).text=val
ET.ElementTree(feed).write(DIST/'rss.xml',encoding='utf-8',xml_declaration=True)
(DIST/'_headers').write_text('''/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n\n/admin/*\n  X-Robots-Tag: noindex, nofollow\n''',encoding='utf-8')
(DIST/'_redirects').write_text('/blog /journal/ 301\n/blog/ /journal/ 301\n',encoding='utf-8')
print(f"Built {len(posts)} published posts, {len(page_paths)} indexed paths in {DIST}")
