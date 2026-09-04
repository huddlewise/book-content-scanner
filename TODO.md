# KinRead - To Do

Last updated: 2026-09-04

## Done this session

- Affiliate "Where to get it" links (Amazon + Bookshop.org, referral tags optional)
- Free-tier usage meter with quota reset date
- Fixed a password-reset host-header poisoning vulnerability (`APP_BASE_URL`)
- Branded HTML + plain-text password reset email
- **Resend fully working**, local and production, from a verified sending domain
- Separate Resend API keys per environment, both tested
- Root SPF + Google Workspace DKIM records published and Gmail authentication started for `huddlewisdom.com`
- Test email from Google Workspace passed `SPF`, `DKIM`, and `DMARC`
- Physical phone test passed: barcode scan, camera permission, Google Books lookup, and cover photo reading
- Refreshed Anthropic key after cover reading exposed an upstream `401`; production cover reading now works
- Added clearer server-side cover-reading error diagnostics and deployed them as `1e10cb9`

Main feature work committed and deployed as `19d9990`; cover diagnostics deployed as `1e10cb9`.

---

## 1. Live Stripe — the main blocker for taking money

The full checkout → upgrade → portal → cancel → downgrade loop is already proven in test mode.
The live product and price already exist:

- product `prod_VB8bxzPEKKbrvP` (KinRead Family)
- price `price_1UAmKOHVo6yA55eejhkcbZO0` ($5.99/mo)

Remaining:

- [ ] Create a **live-mode** webhook endpoint in the Stripe Dashboard pointing at
      `https://book-content-scanner.onrender.com/api/billing/webhook`
      Events: `checkout.session.completed`, `customer.subscription.created/updated/deleted`
- [ ] Set in Render: `STRIPE_SECRET_KEY` (live `sk_live_...`), `STRIPE_PRICE_ID`,
      `STRIPE_WEBHOOK_SECRET` (from the new endpoint)
- [ ] One real live-card purchase, confirm the webhook flips the account to `paid`, then cancel

Live secrets go straight from the Stripe Dashboard into Render — never through the terminal
or chat, unlike the test-mode setup.

---

## 2. Still untested

- [ ] Legal review of `privacy.html` / `terms.html` before scaling to paying customers

---

## 3. Backlog (not started)

- [ ] Affiliate programme applications (Amazon Associates / Bookshop.org). The code is done —
      links appear untagged until `AMAZON_ASSOCIATE_TAG` / `BOOKSHOP_AFFILIATE_ID` are set in Render
- [ ] Public SEO pages for cached analyses (`/book/<isbn>`) - the main organic growth channel
- [ ] Ops: Sentry error tracking, uptime monitoring, database backups
- [ ] Institutional / API licensing for schools and libraries

---

## Reference

**DNS is edited in Kajabi**, not GoDaddy or Cloudflare. `huddlewisdom.com` is registered at
GoDaddy, points to Cloudflare nameservers, but that Cloudflare zone belongs to Kajabi (the
website host). There is no Cloudflare account to log into.

**Resend sending domain:** `mail.huddlewisdom.com` (Tokyo region), sender
`KinRead <noreply@mail.huddlewisdom.com>`.

**Old commits** still contain `data/kids.json` and `data/thresholds.json` (real family data).
They're untracked going forward, but scrubbing history needs a force-push — decide if it matters.

**The shared analysis cache is global on purpose**: a book any family has analysed is free for
everyone and doesn't consume quota.
