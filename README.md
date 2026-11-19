# The Soft Nest Edit

A Python/Jinja2 home decor shop and journal with Cloudflare Worker APIs, D1, CJ catalog staging and PayPal Sandbox tests. Customer checkout and supplier purchases remain disabled.

See [COMMERCE-DEVELOPMENT.md](COMMERCE-DEVELOPMENT.md) for the local watcher, isolated D1 migration commands, pricing policy, shipping estimates and tests. The static starter instructions below cover the journal and editorial content.

## What's included

The private Product Atelier at `/admin/products/` adds supplier verification,
pricing, quality reviews and audited approvals. See [ADMIN-PRODUCTS.md](ADMIN-PRODUCTS.md)
for Access configuration, local administrator sign-in, migrations and staging commands.

- Responsive editorial homepage, journal, category and article pages
- Three sample long-form blog articles, ready to edit
- Shop the Edit landing page with published products (and editorial guides when no products exist)
- Affiliate Product Manager in Pages CMS with a separate product library and related-product picker in blog posts
- Product cards in articles, on the Shop page and (when featured) on the homepage; automatic link disclosure and sponsored attributes
- About, contact, affiliate disclosure and provisional privacy policy
- Search on journal listings, Pinterest share links, Open Graph tags, BlogPosting structured data, XML sitemap and RSS feed
- `/admin/` shortcut to the hosted **Pages CMS** editor
- `.pages.yml` with rich-text editor, image upload, categories, drafts, featured posts and site settings
- Cloudflare Pages-compatible build output (`dist/`)

## 1. Try it locally

Requires Python 3.10+.

```bash
python3 -m pip install -r requirements.txt
python3 build.py
cd dist && python3 -m http.server 8000
```

Visit `http://localhost:8000` and `http://localhost:8000/admin/`.

## 2. Put it on GitHub

1. Create a GitHub repository named `the-soft-nest-edit`. A private repository is fine if both integrations have access to it.
2. Upload **the source files from this package**, including the hidden `.pages.yml`. Do not use just the `dist/` folder.
3. Set the default branch to `main` if it isn't already.
4. Make sure `.pages.yml`, `build.py`, `templates/`, `content/`, `data/`, `static/`, and `requirements.txt` are in the repository root.

## 3. Free admin editor: Pages CMS

1. Go to <https://app.pagescms.org> and sign in with GitHub.
2. Install the Pages CMS GitHub App for the repository you created.
3. Open your repo. Pages CMS will read the included `.pages.yml` file and show **Blog posts** and **Site settings**.
4. Under **Affiliate Products**, choose Create, enter the product name, retailer, category, image, original description, and approved HTTPS retailer/affiliate link. Turn on **Affiliate link** when applicable. Leave **Published** off while drafting.
5. Under **Blog posts**, edit an existing article or create a new one, then use **Related affiliate products** to select published products. Set **Highlight on homepage** in a product to feature it on the homepage as well.
6. Save: Pages CMS commits changes to GitHub. Cloudflare's connected build/deploy then publishes the updated pages. View the build log if the site doesn't update.

**Important:** The admin UI actually lives at `app.pagescms.org` and is secured by GitHub login. `/admin/` on your public blog is merely a shortcut. It does not host a secret password form or provide additional security. Do not put passwords or API keys in `.pages.yml`.

## 4. Deploy on Cloudflare Pages for free

1. Create a Cloudflare account and open **Workers & Pages**.
2. Choose **Create application → Pages → Connect to Git**, then select your GitHub repository.
3. Use these settings:
   - **Framework preset:** None
   - **Production branch:** `main`
   - **Build command:** `pip install -r requirements.txt && python3 build.py`
   - **Build output directory:** `dist`
   - **Root directory:** repository root (leave blank)
4. Under environment variables, set `PYTHON_VERSION` to `3.11` or another supported recent Python version if necessary for the build environment.
5. Deploy. Cloudflare will give you a `*.pages.dev` address after you select an available project name.
6. In Pages CMS → Site settings, enter that live URL in `site_url` (including `https://`) and your Pinterest profile URL once available. Saving triggers the next deployment with correct canonical URLs and sitemap links.

If the build errors because Python tooling is unavailable in your particular build environment, use a GitHub Actions workflow to generate `dist/` and deploy via Cloudflare Wrangler, or switch to a Node-based static generator. This project was deliberately designed to be portable.

## 5. Your content workflow

`Pages CMS → GitHub commit → Cloudflare build → Published blog post`

- Each article is stored as Markdown in `content/posts/`.
- The article URL comes from the filename (e.g. `my-cozy-living-room.md` → `/journal/my-cozy-living-room/`).
- Cover images and article images can be uploaded through Pages CMS into `static/uploads/` and rendered from `/uploads/...`.
- `published: false` articles are omitted from live builds. Future-dated articles are also omitted until the build runs again after their date; there is **no automatic scheduled rebuild**. For planned future posts, save drafts and manually publish them on the intended day.
- Changes to categories require adjusting both `build.py` and `.pages.yml`.
- Once you have approved affiliate links, manage them centrally under **Affiliate Products** and choose them with each article's **Related affiliate products** picker. The site renders product cards below the article, and on the Shop page.
- Only `published: true` products with complete information, a valid HTTPS URL, and a valid image are displayed. Drafts and invalid URLs are hidden. Both the product item and article should be published.
- In product fields, **Affiliate link** enables `rel="sponsored nofollow noopener noreferrer"` and visible disclosure. Apply merchant-specific disclosure and creative requirements as well.
- **Price note** is optional. Prefer leaving numeric prices blank or verifying pricing rules and accuracy before adding them. The store controls actual prices and availability.
- The affiliate system displays outbound links; it does **not** track commissions, clicks, inventory, conversion events, or payouts.

## 6. Before launching publicly

- Confirm the brand name, handle and domain don't conflict with other businesses or trademarks.
- Set the correct site URL and public email address in Site settings.
- Review the Privacy Policy and Affiliate Disclosure for your real integrations and applicable laws; the included versions are starter copy, not legal advice.
- Confirm affiliate programs allow your intended traffic/referral methods before publishing merchant links.
- Replace sample photography and review the quality and accuracy of posts. The starter images use Unsplash image URLs. Verify availability and usage rights of each photo; Unsplash offers free commercial usage under its license: <https://unsplash.com/license>.
- Claim the published website in your Pinterest Business account and add your live blog address to its profile.
- Optional: add Cloudflare Web Analytics after updating the privacy information, if appropriate.

## Tech details

- Python: PyYAML, Jinja2, Mistune
- No client framework; static pages plus Cloudflare Workers/D1 APIs, with secrets kept server-side
- CSS and JS in `static/assets/`
- Source code and content remain portable across static hosts

## Known limitations

- Pages CMS requires GitHub authorization and availability of the third-party hosted CMS service.
- Deployment to Cloudflare and GitHub cannot be completed from a ZIP file alone. You must connect your own accounts.
- Customer checkout and CJ purchases remain disabled; product checkout foundations are Sandbox-only. Affiliate sales and commissions are managed by the linked merchants.
- Blog comment forms, newsletter backend, and on-site analytics are intentionally not enabled in the starter.
- Affiliate products are editorial content entries, not a checkout or an inventory-management system.

## 7. Affiliate Product Manager upgrade

For an existing deployment, **do not replace your entire repository with this older starter snapshot**; this package was based on the original version of the site and your new Pages CMS posts may be more recent. Apply the included affiliate patch or copy only its changed source files, then keep your current `content/posts/`, `data/site.yml`, and deployment configuration intact.

Use `python3 test_affiliate_manager.py` to test locally. See `AFFILIATE-MANAGER-SETUP.md` for the exact upgrade steps.
