# The Soft Nest Edit — Pinterest affiliate blog starter

An editorial home decor blog with a free GitHub-authenticated content editor. Built as a static Python/Jinja2 site so the public site doesn't require a database or a paid server.

## What's included

- Responsive editorial homepage, journal, category and article pages
- Three sample long-form blog articles, ready to edit
- Shop the Edit landing page (links to genuine editorial articles; **no pretend affiliate links**)
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
4. Under Blog posts, choose Create, enter the title, date, category, SEO description, cover image, alt text and body. Leave **Published** disabled to keep a draft. Flip it on when ready to publish.
5. Save: Pages CMS commits the article file to GitHub. Once Cloudflare is connected, its build/deploy starts automatically.

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
- Once you have approved affiliate links, add them naturally inside articles through the rich-text editor. Use clear, nearby disclosures, and follow each merchant's program rules.

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
- No client framework, no application server, no database, no login credentials in the public site
- CSS and JS in `static/assets/`
- Source code and content remain portable across static hosts

## Known limitations

- Pages CMS requires GitHub authorization and availability of the third-party hosted CMS service.
- Deployment to Cloudflare and GitHub cannot be completed from a ZIP file alone. You must connect your own accounts.
- The website is not an e-commerce checkout and does not manage affiliate sales or commissions.
- Blog comment forms, newsletter backend, and on-site analytics are intentionally not enabled in the starter.
