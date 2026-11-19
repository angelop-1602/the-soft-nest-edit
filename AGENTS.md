# Repository guide

## Project structure

The Soft Nest Edit combines a Python-generated home decor shop and journal with
Cloudflare Worker APIs. The README describes the original static-site starter;
consult `wrangler.jsonc` and `src/` for the current backend behavior.

- `build.py`: static generator using Jinja2, PyYAML, and Mistune; requires Python
  3.10 or newer. Importing this script also runs the build.
- `templates/`: Jinja HTML templates and shared macros.
- `static/assets/`: browser JavaScript and CSS, without a frontend build tool.
- `static/uploads/`: content images, served under `/uploads/`.
- `content/posts/`: journal Markdown with YAML front matter.
- `content/products/`: editorial affiliate recommendations.
- `content/store-products/`: separate shop listings with sale-readiness fields.
- `data/site.yml` and `data/shop_categories.yml`: site settings and shop taxonomy.
- `.pages.yml`: Pages CMS schema; `/admin/` links to the hosted CMS.
- `src/index.js`: Worker routing and scheduled CJ catalog sync; other modules
  implement catalog preview, planning cart, readiness, commerce math, and PayPal
  sandbox checkout.
- `migrations/`: ordered Cloudflare D1 SQL migrations.
- `wrangler.jsonc`: Worker entry point, `ASSETS` and `DB` bindings, and cron config.
- `dist/`: generated site. `.wrangler/`: local Wrangler state and temporary files.
  Both currently contain tracked files despite `dist/` being ignored.

## Local commands

Run these from the repository root:

```powershell
python -m pip install -r requirements.txt
python build.py
python -m http.server 8000 --directory dist
```

The Python server previews static pages only; Worker APIs need the Wrangler
runtime and the relevant local bindings and secrets. There is no `package.json`.
The JavaScript tests use Node's built-in test runner (verified with Node 22):

```powershell
node --test tests/*.test.mjs
```

For generator, template, content-schema, or static-asset changes, build and run
the relevant integration scripts directly:

```powershell
python test_site_seo.py
python test_affiliate_manager.py
python test_storefront.py
python test_independent_shop.py
```

`test_site_seo.py` and `test_affiliate_manager.py` read the existing `dist/`;
build first. `test_storefront.py` rebuilds the working repository as well as a
temporary copy. The other catalog integration checks also use temporary copies.
Run build-dependent checks sequentially so output is not replaced mid-test.

## Editing and verification

- Inspect `git status` before changing files and preserve unrelated local work.
  `build.py` deletes and recreates `dist/`; if that output has user changes,
  perform build verification in an isolated copy instead.
- Make site changes in source templates, content, data, or assets rather than
  patching generated HTML. Do not add generated output or Wrangler state to a
  commit unless the task calls for it.
- Keep journal categories synchronized between `build.py` and `.pages.yml`.
  Keep shop taxonomy changes consistent with `data/shop_categories.yml` and CMS
  fields. Markdown filenames determine public slugs; preserve existing URLs
  unless a route change is intended.
- Preserve escaping and URL validation. Retain affiliate disclosures and
  sponsored link attributes, canonical URLs, structured data, sitemap/RSS
  behavior, and noindex rules for private or preview pages.
- Keep affiliate recommendations separate from owned-store listings and the
  D1-backed CJ catalog. Draft, invalid, or incomplete records must retain their
  existing publication and purchase gates.
- Preserve the current commerce boundaries: catalog/cart previews cannot place
  orders, readiness does not enable checkout or fulfillment, and PayPal checkout
  is an explicitly gated sandbox demo with a server-owned USD 1.00 amount.
  Changes to those behaviors require task scope that includes them.
- Keep credentials, supplier costs, private sourcing fields, and tokens out of
  public HTML, browser assets, API responses, and logs. Use server-side bindings
  and secrets for integrations.
- Add database changes as new ordered migration files. Keep local verification
  distinct from remote migrations, catalog syncs, and deployments.
- Run checks relevant to the change and report their results and any checks not
  run. Do not assume the older README describes current Worker capabilities.
