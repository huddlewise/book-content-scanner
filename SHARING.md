# Sharing KinRead with Family & Friends

This guide covers how to share KinRead with others while protecting your API key and managing costs.

## Quick Start for Sharing

### Option A: Deploy to the Cloud (Recommended)

This is easiest for non-technical people:

1. Follow the [DEPLOYMENT.md](DEPLOYMENT.md) guide
2. Share the HTTPS URL (e.g., `https://kinread.yourfamily.com`)
3. They just bookmark it and tap to use — no installation needed
4. Works on phones, tablets, computers — any browser with HTTPS

**Best for:** Family, book clubs, school groups

### Option B: Run Locally + Share with Ngrok (Quick Demo)

For a quick demo without deploying:

```bash
npm start
# Open http://localhost:3000 in one browser
# In another terminal:
npx ngrok http 3000
# Share the HTTPS URL that ngrok gives you (e.g., https://xxxxx.ngrok.io)
```

Good for showing it to 1-2 people, but the URL expires after 2 hours (or 8 hours with a free account).

**Best for:** Quick demos, testing

---

## Cost Management

KinRead uses Anthropic's Claude API, which charges per API call:

### Typical Costs

- **Per "Analyse content" click:** ~$0.01-0.03 (includes web search)
- **Per "Photograph cover" capture:** ~$0.001 (vision only, no web search)
- **50 books analysed:** ~$1-1.50

### Protecting Your Budget

**Set a spending limit:**

1. Go to https://console.anthropic.com/account/usage-limits
2. Set a monthly budget (e.g., $50/month)
3. Once hit, the API key stops working — no surprise bills

**For testers, use a separate API key:**

```
# Key 1: Your main key — for personal use
# Key 2: Tester key — set a low spending limit ($5-10), delete after testing
```

Create and manage keys at https://console.anthropic.com/account/api-keys

---

## Who Should Use KinRead?

✅ **Parents** deciding on books for kids
✅ **Teachers** vetting books for classrooms
✅ **Librarians** building reading guides
✅ **Educators** researching age-appropriate content
✅ **Book clubs** discussing content for mixed ages

❌ **Not recommended:** Commercial use, bulk content screening for publishers (contact Anthropic for enterprise licensing)

---

## Privacy & Data

- **Local storage:** Your library (books + notes) stays on the device you're using
- **Cloud deploy:** Your library is stored on that cloud provider's servers
- **API calls:** Book titles/ISBNs are sent to Anthropic (Claude) and Google (Books API)
- **No tracking:** KinRead doesn't phone home or track usage

**For FERPA compliance (schools):** Avoid storing student data in KinRead. Use it as a tool to research books, but don't save analyses that include student names/IDs.

---

## Technical Requirements for Others

### To use KinRead:

- A web browser (Chrome, Safari, Firefox, Edge — any modern browser)
- Internet connection
- That's it! No installation needed if you're sharing a cloud deployment

### For camera features:

- Must be on HTTPS (not HTTP) — cloud deployments are automatically HTTPS
- Browser must have camera permission granted
- Works on phones, tablets, laptops

### For offline use:

- Not supported yet — KinRead needs internet to search book info

---

## Sharing Scenarios

### Scenario 1: Family of 4

1. Deploy to Render/Fly (free tier, 5 min setup)
2. Add to bookmarks on their phones/tablets
3. Costs: ~$50/month if they analyse 100+ books; adjust spending limit as needed

### Scenario 2: Book Club of 8 People

1. Share a cloud deployment link
2. Everyone bookmarks it
3. Each person maintains their own library (stored locally in their browser)
4. Shared API key means shared cost — set a group spending limit

### Scenario 3: Classroom (30 Students)

1. Teacher deploys KinRead
2. Students use it to research books (no login needed)
3. Everyone's analyses go to the same library
4. **Data note:** Keep spending limit low; delete the deployment after the unit

---

## Troubleshooting for Others

**"It says camera permission denied"**
- They need to allow camera access in their browser settings
- Usually a popup when first visiting HTTPS URL

**"The analysis takes forever"**
- Normal — Anthropic's servers are sometimes busy
- Typical wait: 30-60 seconds
- If >2 minutes, they can close and try again

**"I see an API key error"**
- The person running the server needs to set `ANTHROPIC_API_KEY` properly
- Check https://console.anthropic.com that the key is active

**"The URL doesn't work / 404"**
- Deployment may have crashed or URL changed
- Check the deployment platform's dashboard (Render, Fly, etc.)
- Restart the service if needed

---

## Maintenance

If you're running a shared deployment:

- **Weekly:** Check https://console.anthropic.com/account/usage — make sure you're staying under budget
- **Monthly:** Review if people are still using it; delete if not needed
- **As updates come out:** Pull the latest code and redeploy

---

## Next Steps

1. Choose your deployment option (Render recommended)
2. Follow [DEPLOYMENT.md](DEPLOYMENT.md)
3. Set a spending limit
4. Share the link!

Have questions? Check the [README.md](README.md) or [DEPLOYMENT.md](DEPLOYMENT.md).
