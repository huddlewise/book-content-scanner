# KinRead - To Do

Last updated: 2026-09-04

## 0. Right now: uncommitted work

Today's changes are finished and verified locally but **not committed**:

- Affiliate "Where to get it" links (`server.js`, `public/app.js`, `public/style.css`, `public/terms.html`)
- Usage meter + quota reset date (`server.js`, `public/app.js`, `public/index.html`, `public/style.css`)
- Password-reset link hardening + branded reset email (`server.js`)
- Docs: `.env.example`, `DEPLOYMENT.md`

- [ ] Review the diff, then commit and push (Render auto-deploys from `main`)
- [ ] Before `git add`: confirm `.gitignore` still covers everything in `data/` (recurring past mistake)

---

## 1. Blocked on you (secrets - add these yourself, never paste into chat)

### Resend email delivery
- [ ] Sign up at resend.com, create an API key
- [ ] Add to `.env`: `RESEND_API_KEY=re_...` and `RESEND_FROM_EMAIL=KinRead <onboarding@resend.dev>`
- [ ] Add both to Render's env vars
- [ ] Then: real inbox delivery test of the password reset flow
- [ ] Before real customers: verify a sending domain (`onboarding@resend.dev` only delivers to your own Resend signup address)

### Live Stripe billing
- [ ] Create a live-mode webhook endpoint in the Stripe Dashboard pointing at
      `https://book-content-scanner.onrender.com/api/billing/webhook`
      Events: `checkout.session.completed`, `customer.subscription.created/updated/deleted`
- [ ] Set in Render: `STRIPE_SECRET_KEY` (live `sk_live_...`), `STRIPE_PRICE_ID` = `price_1UAmKOHVo6yA55eejhkcbZO0`, `STRIPE_WEBHOOK_SECRET` (`whsec_...` from that endpoint)
- [ ] One real live-card purchase test, then cancel it
      (the full loop is already proven in test mode - this is just the live repeat)

### Render env vars
- [ ] Set `APP_BASE_URL=https://book-content-scanner.onrender.com` (new - password reset links)
- [ ] Confirm `SESSION_SECRET` and `DATABASE_URL` are still set

### Affiliate revenue (optional, unblocks money from the links already built)
- [ ] Apply to Amazon Associates and/or Bookshop.org affiliates
- [ ] Set `AMAZON_ASSOCIATE_TAG`, `AMAZON_DOMAIN`, `BOOKSHOP_AFFILIATE_ID` in Render
      (until then the Amazon link works untagged and Bookshop.org stays hidden)

---

## 2. Still untested

- [ ] Physical-phone camera + barcode scan on the deployed HTTPS URL
- [ ] Legal review of `privacy.html` / `terms.html` before scaling to paying customers

---

## 3. Backlog (not started)

- [ ] Public SEO pages for cached analyses (`/book/<isbn>`) - the main organic growth channel
- [ ] Ops: Sentry error tracking, uptime monitoring, database backups
- [ ] Institutional / API licensing for schools and libraries (Phase 3 of the monetisation plan)

---

## Notes

- Old commits still contain `data/kids.json` and `data/thresholds.json` (real family data). They're
  untracked going forward, but scrubbing history needs a force-push - not done, decide if it matters.
- The shared analysis cache is global on purpose: a book any family has analysed is free for everyone
  and doesn't consume quota.
