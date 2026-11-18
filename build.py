#!/usr/bin/env python3
"""Static generator for The Soft Nest Edit. Run: python3 build.py"""
import os, json, shutil, html, re
from pathlib import Path
from datetime import date, datetime
from urllib.parse import quote
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
    slug = path.stem
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
        raise ValueError(f'Invalid slug: {slug}')
    content_html = MD(chunks[2].strip())
    words = len(re.findall(r'\b\w+\b', chunks[2]))
    return {
       **meta, 'slug':slug, 'date_iso':d.isoformat(),
       'date_display':d.strftime('%B %-d, %Y') if os.name!='nt' else d.strftime('%B %d, %Y'),
       'html':content_html, 'reading_minutes':max(2,round(words/200)),
       'url':f'/journal/{slug}/', 'category_slug':CAT_SLUG.get(meta['category'],'lifestyle'),
    }

posts = [p for path in (ROOT / 'content/posts').glob('*.md') if (p := load_post(path))]
posts.sort(key=lambda p:p['date_iso'],reverse=True)

if DIST.exists(): shutil.rmtree(DIST)
DIST.mkdir()
shutil.copytree(ROOT / 'static',DIST,dirs_exist_ok=True)

def render(path, template='page.html', **params):
    url = '/' if not path else '/' + path.strip('/') + '/'
    title = params.get('title') or SITE['name']
    description = params.get('description') or SITE['description']
    image = params.get('og_image') or (posts[0]['image'] if posts else '')
    full_url = BASE_URL + url
    context = dict(site=SITE, title=title, description=description,
        current_path=url, canonical=full_url, og_image=image, full_url=full_url,
        posts=posts, featured=[x for x in posts if x.get('featured',False)],
        categories=CATEGORIES, category_images=CATEGORY_IMAGES, year=date.today().year)
    context.update(params)
    output = ENV.get_template(template).render(**context)
    target = DIST / path / 'index.html' if path else DIST / 'index.html'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(output,encoding='utf-8')
    return url

render('', 'home.html', title='The Soft Nest Edit | Cozy home decor, thoughtfully styled', page='home')
render('journal','journal.html',title='The Journal | Home Decor Ideas',description='Browse thoughtful decor ideas and easy styling guides for bedrooms, small spaces and cozy living rooms.',page='journal',selected='All',visible_posts=posts)
for category, slug in CATEGORIES:
    matching=[x for x in posts if x['category']==category]
    render(f'category/{slug}', 'journal.html', title=f'{category} Ideas | The Soft Nest Edit', description=f'Browse gentle, practical {category.lower()} inspiration, affordable tips and beautiful home ideas.', page='journal', selected=category, visible_posts=matching)
for post in posts:
    related=[x for x in posts if x['slug']!=post['slug']][:2]
    render(f'journal/{post["slug"]}','article.html',title=post['title']+' | The Soft Nest Edit',description=post['description'], og_image=post['image'], page='article', post=post, related=related)
render('shop','shop.html', title='Shop the Edit | Thoughtful Decor Finds',description='Explore home decor shopping guides and smart category-by-category ideas for cozy, functional spaces.',page='shop')
render('about','simple.html', title='About | The Soft Nest Edit', page='about', heading='A home to come back to.', kicker='OUR STORY',
  body="The Soft Nest Edit is a home decor journal for people who want their spaces to feel calm, cozy and truly their own. We believe thoughtful rooms are made one little decision at a time—not by buying everything new. Here you'll find practical styling ideas, helpful small-space inspiration and carefully considered product categories. We write for real homes, real budgets and the little moments that make a place feel lived in.")
render('contact','simple.html', title='Contact | The Soft Nest Edit', page='contact',heading="Let's keep in touch.", kicker='CONTACT',
  body='Have a decor question, collaboration idea or note about our content? You can reach us using the contact details below when our public business email is ready. For now, explore the journal and follow our website updates.')
render('affiliate-disclosure','legal.html',title='Affiliate Disclosure | The Soft Nest Edit',page='legal',heading='Affiliate Disclosure',body_html='''<p>The Soft Nest Edit is being developed as an affiliate-supported website. In the future, some articles may contain affiliate links. If you click a qualifying affiliate link and make a purchase, we may receive a commission at no additional cost to you.</p><p>When a post contains affiliate links, we aim to make that relationship clear near the recommendation and provide useful context about why a product may suit a particular space. We do not present untested products as personally tested.</p><p>At launch, our example articles do not contain commissioned product links. The presence of a product category or store name does not, by itself, imply a paid relationship.</p><p>Any claims about product quality, pricing, stock or suitability should be checked on the retailer's official site before purchasing.</p>''')
render('privacy','legal.html',title='Privacy Policy | The Soft Nest Edit',page='legal',heading='Privacy Policy',body_html='''<p><strong>Last updated:</strong> November 18, 2026</p><p>This starter website is a static information website. It does not create user accounts or collect newsletter signups. We have not installed analytics, advertising cookies or a contact submission service in this starter version.</p><p>Our hosting provider may process routine server and request information as part of delivering the website. We also load example photography from Unsplash and web fonts from Google Fonts; those services can receive requests from a visitor's browser, including network information such as IP address. External websites we link to, including Pinterest and merchants if added later, follow their own privacy policies.</p><p>If we add analytics, forms, comments, advertising or affiliate network tracking, this policy must be reviewed and updated before those features go live. Additional rights or disclosures may apply depending on where visitors are located.</p><p>For questions about personal data, use the business contact information published on our Contact page once available.</p><p><em>This template is not legal advice. Review and tailor it before launching your business.</em></p>''')
render('admin','admin.html',title='Editor access | The Soft Nest Edit',page='admin')
render('404','simple.html',title='Page not found | The Soft Nest Edit',page='404',heading='This page has wandered off.',kicker='404 — PAGE NOT FOUND',body='We could not find that page. Head back to our journal to find something lovely.')
(DIST / '404.html').write_text((DIST / '404/index.html').read_text(encoding='utf-8'),encoding='utf-8')

# Search engine discovery and feed.
import xml.etree.ElementTree as ET
root=ET.Element('urlset',xmlns='http://www.sitemaps.org/schemas/sitemap/0.9')
page_paths=['/','/journal/','/about/','/shop/','/contact/','/affiliate-disclosure/','/privacy/'] + [p['url'] for p in posts] + [f'/category/{slug}/' for _,slug in CATEGORIES]
for location in page_paths:
    node=ET.SubElement(root,'url')
    ET.SubElement(node,'loc').text=BASE_URL+location
ET.ElementTree(root).write(DIST / 'sitemap.xml',encoding='utf-8',xml_declaration=True)
(DIST/'robots.txt').write_text('User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: '+BASE_URL+'/sitemap.xml\n',encoding='utf-8')
feed=ET.Element('rss',version='2.0'); channel=ET.SubElement(feed,'channel')
for tag,val in [('title',SITE['name']),('link',BASE_URL),('description',SITE['description'])]: ET.SubElement(channel,tag).text=val
for post in posts:
    item=ET.SubElement(channel,'item')
    for tag,val in [('title',post['title']),('link',BASE_URL+post['url']),('guid',BASE_URL+post['url']),('description',post['description']),('pubDate',post['date_iso'])]: ET.SubElement(item,tag).text=val
ET.ElementTree(feed).write(DIST/'rss.xml',encoding='utf-8',xml_declaration=True)
(DIST/'_headers').write_text('''/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n\n/admin/*\n  X-Robots-Tag: noindex, nofollow\n''',encoding='utf-8')
(DIST/'_redirects').write_text('/blog /journal/ 301\n/blog/ /journal/ 301\n',encoding='utf-8')
print(f"Built {len(posts)} published posts, {len(page_paths)} indexed paths in {DIST}")
