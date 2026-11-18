# Affiliate Product Manager — The Soft Nest Edit

This upgrade adds a **Products** collection to Pages CMS and lets each blog post select products with a multi-select reference field. It uses the existing Python/Jinja2 static generator and Cloudflare Workers Git deployment flow. It does **not** require a database, paid hosting or a separate password system.

## Before applying the update

1. Wait for your latest Cloudflare deployment to finish.
2. Open your local website project in VS Code and run `git status`.
3. If you have uncommitted edits, commit or back them up first; don't overwrite them with an older snapshot.
4. Run `git pull --ff-only origin main` (replace `main` with your production branch) to get the newest posts from Pages CMS.
5. Make a backup branch: `git switch -c feature/affiliate-products`.

## Preferred: apply the small patch

Download `affiliate-manager.patch` into your project's parent folder, then from the repository root:

```bash
git apply --check /path/to/affiliate-manager.patch
git apply /path/to/affiliate-manager.patch
python3 -m pip install -r requirements.txt
python3 build.py
python3 test_affiliate_manager.py
git add .pages.yml build.py templates static/assets/styles.css content/products/ README.md AFFILIATE-MANAGER-SETUP.md test_affiliate_manager.py
git commit -m "Add Pages CMS affiliate product manager"
git push -u origin feature/affiliate-products
```

Review the branch and merge it into `main` through a GitHub pull request. Cloudflare should deploy from the configured production branch. If `git apply --check` fails, STOP and reconcile any differences with your current code rather than forcing an overwrite.

Alternative: extract `affiliate-manager-update-files.zip` into your repository root after reviewing the named files. This archive contains only changed source files; it does **not** contain or replace any of your existing blog posts or website settings.

## New Pages CMS fields

### Affiliate Products collection

- **Product name**: A clear editorial name, not an exaggerated claim
- **Store / retailer**: Shop visitors will be sent to
- **Product category**: Same categories as your articles
- **Product image / description**: A licensed image with useful alt text
- **Why this product is relevant**: Original, accurate value for readers
- **Retailer / affiliate URL**: Only HTTPS links will render; make sure your affiliate program permits placement
- **Optional price note**: Usually leave blank; price claims can become outdated
- **Affiliate link**: Enable for commission-generating links
- **Highlight on homepage**: Displays the product on the homepage and places it first in Shop the Edit
- **Published**: Turn on after checking the content; drafts don't render
- **Editor notes**: Not shown on the site, but visible to anyone with repository access

### Blog posts collection

- **Related affiliate products**: Select up to 8 products from the Products collection. The card appears below the article content if the product itself is published.

## Test the end-to-end flow

1. After merging the update, visit https://app.pagescms.org and open the right repository/branch.
2. Confirm **Affiliate Products** appears next to **Blog posts**.
3. Create a product and leave **Published** off; confirm it is not visible on the site.
4. Add a real, approved HTTPS product link and a licensed image, then turn on **Published**, and save.
5. Edit an article and select the product under **Related affiliate products**; save and publish the article.
6. Check GitHub shows the updated files; open Cloudflare → Workers & Pages → the-soft-nest-edit → Deployments/Builds and confirm success.
7. Visit the Shop page and relevant article; the product should be visible with a retailer link and proper affiliate disclosure.
8. If an item isn't visible, check its Published switch, link validity, cover image, and that it was selected in the article; review Cloudflare build logs for warnings.

## Safety and business notes

- This is an outbound affiliate product manager, not a shop checkout or affiliate commission dashboard.
- Do not put API keys, passwords, or secret affiliate network credentials in product files.
- Follow your affiliate program's terms for tracking links, prices, and image usage, and clearly identify affiliate relationships.
- Your real existing `data/site.yml` and any new posts from Pages CMS should remain in place. No `wrangler` configuration or Cloudflare connection settings are changed.
