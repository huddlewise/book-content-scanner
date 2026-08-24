# KinRead Validation Checklist

Use this checklist before sharing a deployment or demonstrating a new release. Record the date, environment, browser/device, and any failing step.

## 1. Preflight

- [ ] Confirm the deployed commit matches the intended branch.
- [ ] Confirm `GET /health` returns HTTP 200 and `{ "ok": true }`.
- [ ] Confirm production has `SESSION_SECRET` and `DATABASE_URL` configured.
- [ ] Confirm `ANTHROPIC_API_KEY` has available credit and an account spending limit.
- [ ] Confirm `GOOGLE_BOOKS_API_KEY` is configured.
- [ ] Confirm `ADMIN_EMAIL` and `ADMIN_PASSWORD` are configured if owner access is needed.
- [ ] Confirm no secrets or local account data are tracked by Git.

For local checks:

```powershell
node --check server.js
node --check public/app.js
git status --short
```

## 2. Authentication Smoke Test

Use a new throwaway email address for destructive tests.

- [ ] Anonymous visit redirects to `/login`.
- [ ] Privacy and Terms pages load without signing in and are styled correctly.
- [ ] New account signup succeeds with a valid email and password.
- [ ] Duplicate email signup is rejected without creating a second account.
- [ ] Wrong-password login is rejected.
- [ ] Correct login reaches the app and shows the account badge.
- [ ] Logout returns to `/login` and protected API calls return HTTP 401.
- [ ] Logging in again restores the same account's data.
- [ ] Password reset request shows the same generic message for existing and unknown emails.
- [ ] A valid reset link changes the password and cannot be reused.

## 3. Core Book Workflow

Prefer a known ISBN such as `9780439708180` for Harry Potter and the Philosopher's Stone. A cached analysis should be used when available, avoiding another paid Claude request.

- [ ] ISBN/title lookup returns book metadata and a cover when available.
- [ ] Cover-photo identification handles a clear cover and does not guess unreadable ISBN digits.
- [ ] Analyse returns a summary, content categories, sources, confidence, age guidance, and mental models.
- [ ] The traffic-light verdict is correct for each configured kid.
- [ ] A cached repeat analysis returns quickly and does not consume monthly quota.
- [ ] A low-confidence identification can be retried and is not incorrectly cached.
- [ ] API errors show useful inline feedback rather than a browser alert or broken layout.
- [ ] Saving a book adds it to the private library.
- [ ] Library search, genre filtering, notes, and deletion work after reload.
- [ ] Lesson search returns results or a clear error, and selecting a result enters the normal lookup flow.

Only use `forceRefresh` with deliberate approval because it calls the paid Claude API and consumes quota.

## 4. Family and Responsive UI

- [ ] Add, edit, and remove a kid profile.
- [ ] Change thresholds and confirm they persist after reload.
- [ ] Verify verdicts update when a threshold changes.
- [ ] Check the main workflow at approximately 390px, 528px, and desktop width.
- [ ] Confirm the account controls do not overlap or wrap mid-word.
- [ ] Confirm camera permissions and barcode scanning on the intended phone/browser over HTTPS.
- [ ] Check keyboard focus and visible labels for the main controls.

## 5. Account Isolation and Safety

Use two separate throwaway accounts.

- [ ] Account A cannot see Account B's library, kids, notes, or thresholds.
- [ ] The shared analysis cache benefits Account B without consuming quota for a cached book.
- [ ] Free-tier quota blocks a sixth uncached analysis with HTTP 402 and an upgrade path.
- [ ] Admin credentials provide unlimited analyses and lesson searches.
- [ ] Account deletion removes the account's private data, clears the session, and prevents login with the deleted credentials.
- [ ] Account deletion does not remove the shared analysis cache.

## 6. Optional Billing and Email Validation

Run these only after the related production secrets are configured. Use Stripe test mode and a test card such as `4242 4242 4242 4242`.

- [ ] Checkout opens for a free account.
- [ ] Successful checkout webhook changes the account to `paid`.
- [ ] Paid accounts no longer show the free quota.
- [ ] Customer portal opens for a paid account.
- [ ] Subscription cancellation webhook returns the account to `free`.
- [ ] Account deletion cancels an active subscription.
- [ ] Password reset email arrives from the configured Resend sender.

## 7. Evidence and Sign-Off

Record:

- Date and environment (local, staging, or production)
- Git commit or deployment ID
- Browser and device
- Tests skipped because they require paid services
- Failures, screenshots, and relevant server-log timestamps
- Person who approved sharing the deployment

A release is ready to share when Sections 1-5 pass, with any skipped paid-service checks explicitly recorded.
