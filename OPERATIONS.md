# KinRead Operations Checklist

Use this checklist before enabling live billing or inviting a wider group of customers.

## Production smoke check

1. Visit `https://book-content-scanner.onrender.com/health` and confirm it reports `"ok":true` and `"storage":"postgres"`.
2. Open a known public guide at `/book/<isbn>` in a private browser window. It must load without an account and must not show any child, threshold, library, or note data.
3. Sign in, analyse one new book, then confirm its suggestions respect the configured family thresholds and its public-guide link works.

## Error tracking

1. Create a Node.js project in Sentry.
2. Copy its DSN directly into Render as `SENTRY_DSN`.
3. Redeploy, then use Sentry's test-event option or monitor the next handled production error.

Sentry is disabled when `SENTRY_DSN` is blank. The application sends no account email, child, library, or note data to Sentry.

## Uptime monitoring

1. Create an HTTPS monitor in UptimeRobot, Better Stack, or a comparable service.
2. Monitor `https://book-content-scanner.onrender.com/health` every five minutes.
3. Set the alert recipient and verify the first successful check.

The health endpoint is public and reports `503` if production Postgres is unavailable.

## Database recovery

1. In Supabase, open the database backup settings and confirm the restore/point-in-time recovery coverage for the current plan.
2. Record the recovery process and a database-owner contact in the team's private operations notes.
3. Schedule a quarterly restore rehearsal against a non-production database before accepting paid subscriptions.

## Affiliate programmes

1. Apply for Amazon Associates and/or Bookshop.org using the business details and public KinRead guides.
2. When approved, add `AMAZON_ASSOCIATE_TAG` and/or `BOOKSHOP_AFFILIATE_ID` directly in Render.
3. Open an analysis page and confirm the retailer link and commission disclosure appear correctly.

## Legal review

Have a qualified lawyer review `public/privacy.html` and `public/terms.html` before paid launch. In particular, confirm the public shared-analysis wording, subscription/cancellation terms, and privacy obligations for the countries where KinRead is offered.