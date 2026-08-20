# KinRead

Scan a book's barcode, understand its plot and content, and get a sourced summary — language, violence, sexual content, substance use, themes/representation, and useful mental models it explores — before deciding whether it is right for your family. Create a free account and everything gets saved to your own private library, so you build up your own reference over time and can pick up where you left off from any device.

## How it works

1. Find the book three ways: scan the barcode, **photograph the cover** (Claude reads the title, author, and the printed ISBN digits straight off the photo), or type the ISBN/title yourself
2. The app looks up the book via Google Books
3. Hit "Analyse content" — Claude searches the web (Common Sense Media, BookTrust, Kirkus, School Library Journal, etc.) and returns a sourced content summary plus up to four plot-grounded ways of thinking the story explores
4. If you've added kids in the **Family** tab, you'll also see a verdict for each of them — "Good to go", "Worth discussing first", or "Not a fit for this family" — based on the age thresholds you've set
5. Review it, add your own notes, and save it to your library

Nothing is presented as gospel. Every analysis shows its sources and a confidence level, and you can add your own notes before saving — treat the AI summary as a well-researched starting point, not a verdict, especially for obscure or self-published titles it may not have solid coverage on.

## For testers (no coding required)

1. Unzip this folder somewhere on your computer.
2. **Mac**: double-click `start-mac.command`. First time only, macOS will warn it's from an "unidentified developer" — right-click it and choose **Open** instead, then confirm.
   **Windows**: double-click `start-windows.bat`.
3. If Node.js isn't installed yet, it'll tell you and link where to get it (free, a couple minutes) — then just run the file again.
4. First launch only, it'll ask you to paste in an Anthropic API key. Get a free one at [console.anthropic.com](https://console.anthropic.com) (Settings → API Keys), or use one the person who shared this with you provided.
5. Your browser opens automatically. Create a free account (just an email + password) — this is what keeps your library and kids' profiles private to you, even if others use the same shared link. Your laptop's own webcam works immediately for barcode scanning — no extra setup needed.

Every account gets 5 free content analyses a month; a paid plan for unlimited analyses is coming soon.

Want to try it with your phone's camera instead of your laptop's? That needs one extra step — see "Using it on your phone" below. It's optional.

**Note for whoever's distributing this**: sharing your own API key with testers is easiest, but set a spending limit on that key first (console.anthropic.com → Settings → API Keys → spending limits) so it can't run up a surprise bill if someone uses it more than expected.

## Manual setup (for developers)

You'll need [Node.js](https://nodejs.org) 18 or later.

```bash
npm install
npm run setup
```

`npm run setup` walks you through adding your Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com)) and writes it to `.env`. This is a paid API — each "Analyse" click and each "Photograph cover" capture uses Claude, costing a small amount (the cover read is a quick vision call with no web search, so it's cheaper than a full analysis).

```bash
npm start
```

Open **http://localhost:3000** in your browser.

## Using it on your phone (for the camera)

Your laptop's own camera works right away at `localhost` — no setup needed. This section is only for the phone-in-hand experience: browsers block camera access over plain HTTP from another device, so opening `http://<your-computer's-IP>:3000` from your phone over wifi won't get camera permission by default. Easiest fixes:

- **Skip the tunnel**: type the ISBN by hand (it's the number under the barcode) or search by title on your phone — this always works, no HTTPS needed.
- **Tunnel it**: run `npx ngrok http 3000` (or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)) and open the `https://` URL it gives you on your phone.
- **Deploy it**: see [DEPLOYMENT.md](DEPLOYMENT.md) for cloud hosting options (Render, Fly.io, Railway, etc.) that give you a permanent HTTPS URL.

## Ready to share? 

See [SHARING.md](SHARING.md) for guides on:
- Deploying to the cloud for family/friends
- Managing costs (setting spending limits on your API key)
- Troubleshooting for non-technical users
- Compliance notes for schools/libraries

## Project layout

```
server.js              Express backend: accounts/auth, book lookup, Claude analysis, library storage
setup.js                Interactive first-run wizard that writes .env
start-mac.command       Double-click launcher for Mac testers
start-windows.bat       Double-click launcher for Windows testers
public/                 Frontend (vanilla HTML/CSS/JS, no build step)
data/accounts.json      Registered accounts (created automatically, gitignored)
data/accounts/<id>/     Each account's own library, kids, and thresholds (gitignored)
```

Each account's library/kids/thresholds are private to that account. The one exception is the book-analysis cache (`data/analysisCache.json`), which is shared across every account on purpose - once anyone has analysed a given book, everyone gets that result instantly and for free.

## Notes on the categories

Five categories use a severity scale (none/mild/moderate/strong): sexual content, language/cussing, violence, substance use, and self-harm/suicide themes. LGBTQ+ content gets its own separate field (`lgbtq_content`), apart from a broader "other themes" field (family structure, disability, race/culture, religion, grief, etc.) — both reported as neutral, factual information, styled the same understated way regardless of the answer rather than as a "concern" alongside the severity-scored categories. Feel free to adjust the wording in `ANALYSIS_SCHEMA_PROMPT` in `server.js` if you want the categories to work differently.

## Mental models

Each new analysis can also identify up to four transferable ways of thinking that the story illustrates, such as empathy, cause and effect, trade-offs, incentives, or questioning assumptions. They are grounded in particular plot points or character choices, include a caveat where the story complicates the lesson, and are informational only: they do not influence family age thresholds or verdicts. Older saved entries simply do not show this section.

## Per-kid age profiles

The **Family** tab lets you add each kid (name + age) and set family-wide thresholds: the minimum age at which you would be comfortable with a child encountering each content level. Every analysis then shows a verdict per kid — "Good to go", "Worth discussing first", or "Not a fit for this family" — instead of just raw category levels. Choose **"Always flag"** on any level to flag it regardless of a kid's age — useful for anything your family considers off-limits outright, not just age-gated.

The default thresholds (in `DEFAULT_THRESHOLDS` in `server.js`) are a loose starting point based on common content-rating conventions, not a claim about what's right for any particular kid or family — edit them freely in the Family tab. `lgbtq_content` and `other_themes` default to 0 (never flagged), consistent with treating them as neutral information rather than a severity scale; raise them above 0 there too if you'd rather this family's verdicts factor them in.

## Genre search

The Library tab shows genre chips (Fantasy, Humorous Stories, etc.) pulled from whatever Google Books tagged each saved book with — tap one to filter your library to that genre, or use the search box, which also matches genre text. Genres come from Google Books' own categories, so coverage varies by title; books it didn't tag won't show a genre and won't appear under any chip.

## Extending it

Some easy next steps if you want to keep building:
- Export your library to CSV or a printable PDF list
- A "recommend something similar" button using the library you've built up
- Batch-scanning mode for going through a shelf at once
