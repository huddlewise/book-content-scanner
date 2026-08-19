# Deploying BookAware

This guide covers different ways to deploy BookAware so you and others can access it from anywhere with HTTPS (required for camera access on other devices).

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
   - `NODE_ENV` = production
5. Deploy

Your app will get a permanent HTTPS URL like `https://yourapp-xyz.onrender.com`

**Cost:** Free tier has limited resources; paid plans start at $7/month

### Option 2: Fly.io

**Pros:** Generous free tier, fast global deployment

1. Install Fly CLI: `npm install -g flyctl`
2. Run `flyctl launch` in this directory
3. Set your API key: `flyctl secrets set ANTHROPIC_API_KEY=sk-ant-...`
4. Deploy: `flyctl deploy`

Your app gets a URL like `https://yourapp.fly.dev`

**Cost:** Free tier includes 3 shared-cpu-1x VMs; generous free allowance

### Option 3: Railway

**Pros:** Simple dashboard, easy environment variable management

1. Go to [railway.app](https://railway.app)
2. Create a new project, connect your GitHub repo (or upload this folder)
3. Add environment variables in the dashboard
4. Railway automatically deploys on each push

**Cost:** Free tier with $5/month credit; paid plans start after that

### Option 4: Vercel

**Note:** Vercel is primarily for serverless functions. This Express app works better on Render or Fly.

---

## Phone/Tablet Access

Once deployed to a cloud service with HTTPS, you can:

1. Share the HTTPS URL (e.g., `https://bookaware-xyz.onrender.com`)
2. Open it in Safari/Chrome on any phone/tablet
3. Camera access works immediately over HTTPS

**No extra setup needed** — just bookmark it.

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

1. **Use per-person or limited keys:** Don't share your main API key with testers. Instead:
   - Create a separate Anthropic API key just for sharing
   - Set spending limits on that key at https://console.anthropic.com/account/usage-limits
   - Rotate/delete the key once testing is over

2. **Environment variables:** The `.env` file is git-ignored. Good — never commit API keys.

3. **Data privacy:** All book analyses and your library are stored locally:
   - On localhost: in `/data/library.json` on your machine
   - On cloud deploy: on that cloud provider's server (read their privacy policy)
   - No data is sent to anyone except Google Books API and Anthropic's Claude

4. **HTTPS required:** Phone/tablet camera requires HTTPS. Always use `https://`, never `http://`.

---

## Custom Domain (Optional)

Once deployed to Render/Fly/Railway, you can add your own domain:

1. Buy a domain (e.g., bookaware.family)
2. Set it up in your deployment service's dashboard (they have built-in DNS instructions)
3. Takes ~10 minutes to propagate

This makes the URL friendlier: `https://bookaware.family` instead of `https://bookaware-xyz.onrender.com`

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

- Share the URL with family/friends
- Set spending limits on your API key to control costs
- Monitor usage at https://console.anthropic.com/account/usage
- Keep the code updated by pulling new versions (or redeploy)
