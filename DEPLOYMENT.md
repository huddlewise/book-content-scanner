# Deploying KinRead

This guide covers different ways to deploy KinRead so you and others can access it from anywhere with HTTPS (required for camera access on other devices).

## Environment Variables

| Variable | Required? | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Powers content analysis and cover-photo reading |
| `SESSION_SECRET` | Yes | Signs customer login sessions - without it, everyone gets logged out on every restart/redeploy. `npm run setup` generates one automatically for local use; set your own random 64-character value for any cloud deployment |
| `GOOGLE_BOOKS_API_KEY` | Recommended | Avoids Google Books rate-limiting (~100 lookups/day without it) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Optional | Owner credentials with unlimited analyses and lesson searches; the owner account is created on first login if needed |
| `DATABASE_URL` | Recommended for real customers | A Postgres connection string. Without it, accounts and libraries are stored as JSON files on disk - fine for local use, but most cloud hosts wipe local disk on every redeploy, which would delete every customer's account and library |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Required in production | Needed for password reset emails. `RESEND_FROM_EMAIL` must be a verified sender in your Resend account (for example `KinRead <noreply@yourdomain.com>`). |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Optional | Only needed once you're ready to accept real subscription payments |

KinRead now requires every visitor to sign up for a free account (email + password) - there's no more single shared family password. Each account gets its own private library, kid profiles, and thresholds, plus 5 free content analyses a month. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the owner account before deployment; passwords cannot be recovered from the stored hashes.

## Local Development

For testing on your own machine:

```bash
npm install
npm run setup     # First time only, to enter your API key
npm start
```

Open `http://localhost:3000` in your browser. Camera works fine locally.

---

## Cloud Deployment

### Option 1: Render (Recommended for simplicity)

**Pros:** Free tier available, automatic deploys from GitHub, built-in SSL/HTTPS

1. Push this project to a GitHub repository
2. Go to [render.com](https://render.com) and sign up
3. Create a new "Web Service" and connect your GitHub repo
4. Set environment variables:
   - `ANTHROPIC_API_KEY` = your API key
   - `SESSION_SECRET` = a random 64-character string (e.g. run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` locally and paste the output)
   - `DATABASE_URL` = a Render Postgres instance's connection string (add one from Render's dashboard - free tier available), so customer accounts survive redeploys
   - `RESEND_API_KEY` = your Resend API key for password-reset emails
   - `RESEND_FROM_EMAIL` = a verified sender like `KinRead <noreply@yourdomain.com>`
   - `NODE_ENV` = production
5. Deploy

Your app will get a permanent HTTPS URL like `https://yourapp-xyz.onrender.com`

**Cost:** Free tier has limited resources; paid plans start at $7/month

### Option 2: Fly.io

**Pros:** Generous free tier, fast global deployment

1. Install Fly CLI: `npm install -g flyctl`
2. Run `flyctl launch` in this directory
3. Set your secrets: `flyctl secrets set ANTHROPIC_API_KEY=sk-ant-... SESSION_SECRET=... DATABASE_URL=...`
4. Deploy: `flyctl deploy`

Your app gets a URL like `https://yourapp.fly.dev`

**Cost:** Free tier includes 3 shared-cpu-1x VMs; generous free allowance

### Option 3: Railway

**Pros:** Simple dashboard, easy environment variable management

1. Go to [railway.app](https://railway.app)
2. Create a new project, connect your GitHub repo (or upload this folder)
3. Add environment variables in the dashboard (including `SESSION_SECRET` and `DATABASE_URL` - Railway can provision a Postgres instance for you)
4. Railway automatically deploys on each push

**Cost:** Free tier with $5/month credit; paid plans start after that

### Option 4: Vercel

**Note:** Vercel is primarily for serverless functions. This Express app works better on Render or Fly.

---

## Phone/Tablet Access

Once deployed to a cloud service with HTTPS, you can:

1. Share the HTTPS URL (e.g., `https://kinread-xyz.onrender.com`)
2. Open it in Safari/Chrome on any phone/tablet
3. Camera access works immediately over HTTPS

**No extra setup needed**, just bookmark it.

---

## Self-Hosted (Advanced)

### Using ngrok (temporary tunneling, useful for testing)

```bash
npm start
# In another terminal:
npx ngrok http 3000
```

ngrok gives you a temporary HTTPS URL (valid for 2 hours on free tier). Share that URL with anyone.

### Using Cloudflare Tunnel (permanent, free)

```bash
npm start
# In another terminal:
npm install -g @cloudflare/wrangler
wrangler tunnel
```

Creates a permanent HTTPS tunnel without port forwarding. Great if you want to keep the server running on your home machine.

---

## Security Notes for Sharing

**Your API key is sensitive.** If you're sharing this app:

1. **Set a spending limit anyway:** Even with accounts and the 5-analyses/month free tier capping cost per customer, set a spending limit on your Anthropic key at https://console.anthropic.com/account/usage-limits so total usage across all customers can't run away.

2. **Environment variables:** The `.env` file is git-ignored. Good, never commit API keys or `SESSION_SECRET`.

3. **Set a real `SESSION_SECRET` per deployment.** Don't reuse your local one in production, and never commit it.

4. **Data privacy:** Every customer gets their own account and private library:
   - With `DATABASE_URL` set: stored in your Postgres database
   - Without it: stored as JSON files under `data/accounts/<id>/` on that server's disk (lost on redeploy on most hosts - use Postgres for anything beyond local testing)
   - Book titles/ISBNs are sent to Google Books API and Anthropic's Claude to produce each analysis

5. **HTTPS required:** Phone/tablet camera requires HTTPS. Always use `https://`, never `http://`.

---

## Custom Domain (Optional)

Once deployed to Render/Fly/Railway, you can add your own domain:

1. Buy a domain (e.g., kinread.family)
2. Set it up in your deployment service's dashboard (they have built-in DNS instructions)
3. Takes ~10 minutes to propagate

This makes the URL friendlier: `https://kinread.family` instead of `https://kinread-xyz.onrender.com`

---

## Troubleshooting

### "Camera permission denied"

- Make sure you're using `https://`, not `http://`
- Allow camera permission in your browser's site settings
- Try a different browser (Safari, Chrome)

### "API key error"

- Check that `ANTHROPIC_API_KEY` environment variable is set in your deployment platform
- Visit https://console.anthropic.com to verify your key is active
- Check your spending limit hasn't been exceeded

### "The server took too long to respond"

- Free tier may be slow. If you need speed, upgrade to a paid plan.
- Analyses can take 30-60 seconds depending on Anthropic's load.

---

## Next Steps

- Run the [validation checklist](VALIDATION.md) against the deployed URL before sharing it
- Share the URL with family/friends
- Set spending limits on your API key to control costs
- Monitor usage at https://console.anthropic.com/account/usage
- Keep the code updated by pulling new versions (or redeploy)
