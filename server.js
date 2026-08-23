import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import pg from 'pg';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHmac, timingSafeEqual, scryptSync, randomBytes, createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const LIBRARY_PATH = path.join(DATA_DIR, 'library.json');
const KIDS_PATH = path.join(DATA_DIR, 'kids.json');
const THRESHOLDS_PATH = path.join(DATA_DIR, 'thresholds.json');
const ANALYSIS_CACHE_PATH = path.join(DATA_DIR, 'analysisCache.json');
const LESSON_SEARCH_CACHE_PATH = path.join(DATA_DIR, 'lessonSearchCache.json');
const ACCOUNTS_PATH = path.join(DATA_DIR, 'accounts.json');

// Default "comfortable from this age" settings per category and severity level.
// These are just a starting point loosely based on common content-rating norms -
// edit freely in the Family tab, every family draws these lines differently.
// lgbtq_content / other_themes default to 0 (never flagged) since they're informational,
// not a severity scale - raise them only if you want this family to gate on them too.
const DEFAULT_THRESHOLDS = {
  sexual_content: { mild: 12, moderate: 15, strong: 17 },
  language: { mild: 8, moderate: 12, strong: 15 },
  violence: { mild: 8, moderate: 11, strong: 14 },
  substance_use: { mild: 10, moderate: 13, strong: 16 },
  self_harm_suicide: { mild: 12, moderate: 14, strong: 16 },
  lgbtq_content: { minor: 0, central: 0 },
  other_themes: { minor: 0, central: 0 },
};

const app = express();
app.set('trust proxy', 1); // needed for correct req.ip behind Render/Fly/Railway's proxy

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function subscriptionHasPaidAccess(status) {
  return status === 'active' || status === 'trialing';
}

async function syncAccountFromSubscription(subscription) {
  const accounts = await readAccounts();
  const accountId = subscription.metadata?.accountId;
  const account = accounts.find((candidate) => (
    candidate.id === accountId
    || candidate.stripeSubscriptionId === subscription.id
    || candidate.stripeCustomerId === subscription.customer
  ));
  if (!account) {
    console.warn(`Stripe subscription ${subscription.id} could not be matched to a KinRead account.`);
    return;
  }

  account.plan = subscriptionHasPaidAccess(subscription.status) ? 'paid' : 'free';
  account.stripeCustomerId = subscription.customer;
  account.stripeSubscriptionId = subscription.id;
  await writeAccounts(accounts);
}

// Stripe needs the raw (unparsed) request body to verify its signature, so this route is
// registered before express.json() below, which would otherwise consume the body first.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Billing is not configured.');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const accountId = session.client_reference_id;
      if (accountId) {
        const accounts = await readAccounts();
        const account = accounts.find((a) => a.id === accountId);
        if (account) {
          account.plan = ['paid', 'no_payment_required'].includes(session.payment_status) ? 'paid' : 'free';
          account.stripeCustomerId = session.customer;
          account.stripeSubscriptionId = session.subscription;
          await writeAccounts(accounts);
        }
      }
    } else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
      await syncAccountFromSubscription(event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handling error:', err);
    res.status(500).json({ error: 'Webhook handling failed.' });
  }
});

app.use(express.json({ limit: '10mb' }));

// ---------- rate limiting for costly Claude-backed endpoints ----------
// Simple in-memory sliding window per IP - fine for a single-process family/small-group
// app. Protects against a shared URL, bug, or bot running up an unexpected API bill.
const rateLimitHits = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const hits = (rateLimitHits.get(ip) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      return res.status(429).json({ error: 'Too many requests right now. Please wait a bit and try again.' });
    }
    hits.push(now);
    rateLimitHits.set(ip, hits);
    next();
  };
}
const analyzeRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });
const coverIdRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 40 });
// Auth endpoints get their own, stricter limits - unlike the Claude-backed ones above, these
// protect against brute-force login attempts, signup spam, and forgot-password abuse rather
// than API cost.
const loginRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const signupRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
const forgotPasswordRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });

// Unauthenticated on purpose - for uptime monitors (UptimeRobot, Render/Fly health checks)
// so they don't get redirected to the login page and reported as down.
app.get('/health', async (_req, res) => {
  const requiresPostgres = process.env.NODE_ENV === 'production';
  if (!requiresPostgres) return res.json({ ok: true, storage: pool ? 'postgres' : 'local' });
  if (!pool) return res.status(503).json({ ok: false, storage: 'unavailable' });

  try {
    await pool.query('SELECT 1');
    return res.json({ ok: true, storage: 'postgres' });
  } catch (err) {
    console.error('Health check database query failed:', err.message);
    return res.status(503).json({ ok: false, storage: 'unavailable' });
  }
});

// ---------- account auth (email + password, one session per account) ----------

const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('WARNING: SESSION_SECRET not set - using a random secret that changes every restart '
    + '(all customers will be logged out on each deploy). Set SESSION_SECRET in .env for production.');
  return randomBytes(32).toString('hex');
})();
const SESSION_COOKIE = 'kinread_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FREE_TIER_MONTHLY_LIMIT = 5;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase() || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64).toString('hex');
  const hashBuffer = Buffer.from(hash, 'hex');
  const candidateBuffer = Buffer.from(candidate, 'hex');
  return hashBuffer.length === candidateBuffer.length && timingSafeEqual(hashBuffer, candidateBuffer);
}

function matchesAdminCredentials(email, password) {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD || email !== ADMIN_EMAIL || typeof password !== 'string') return false;
  const supplied = Buffer.from(password);
  const configured = Buffer.from(ADMIN_PASSWORD);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

// Session token is `${accountId}.${expiresAt}.${signature}` - accountId is a UUID (no dots),
// so splitting on '.' is unambiguous.
function signSession(accountId, expiresAt) {
  const payload = `${accountId}.${expiresAt}`;
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [accountId, expiresAtStr, sig] = parts;
  const expectedSig = createHmac('sha256', SESSION_SECRET).update(`${accountId}.${expiresAtStr}`).digest('hex');
  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expectedSig);
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return null;
  return accountId;
}

function startSession(res, accountId) {
  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  res.cookie(SESSION_COOKIE, signSession(accountId, expiresAt), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Sends via Resend in production. Local development can use the console fallback so the
// password reset flow remains testable without an email provider. Reset links are never
// returned from an API response.
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('RESEND_API_KEY is required in production');
    }
    const plainText = html
      .replace(/<a href="([^"]+)"[^>]*>/gi, '$1 (') // keep link URLs visible before stripping tags
      .replace(/<\/a>/gi, ')')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(`\n[dev email - no RESEND_API_KEY set]\nTo: ${to}\nSubject: ${subject}\n${plainText}\n`);
    return true;
  }
  if (process.env.NODE_ENV === 'production' && !process.env.RESEND_FROM_EMAIL) {
    throw new Error('RESEND_FROM_EMAIL is required in production');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'KinRead <onboarding@resend.dev>',
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`Resend email send failed (${res.status}): ${details}`);
  }
  return true;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return cookies;
}

const AUTH_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>KinRead</title>
<link rel="icon" href="icon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
<style>
  :root { --primary: #00a99d; --gradient-brand: linear-gradient(135deg, #07534f 0%, #008f86 48%, #55d7c2 100%); }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f3f4fb; font-family: 'Public Sans', -apple-system, BlinkMacSystemFont, sans-serif; padding: 1rem; box-sizing: border-box; -webkit-font-smoothing: antialiased; }
  .card { background: #fff; border-radius: 20px; padding: 2rem; width: min(92vw, 24rem);
    box-shadow: 0 18px 40px rgba(43,48,120,0.16); border-top: 3px solid transparent; border-image: var(--gradient-brand) 1; }
  .brand-mark { width: 34px; height: 34px; border-radius: 10px; background: var(--gradient-brand);
    box-shadow: 0 10px 26px rgba(79,70,229,0.32); display: flex; align-items: center; justify-content: center; margin-bottom: 0.9rem; }
  .brand-mark svg { width: 18px; height: 18px; stroke: #fff; }
  h1 { margin: 0 0 0.3rem; font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 1.7rem; color: #1b1d2b; letter-spacing: -0.02em; }
  h1 span { background: var(--gradient-brand); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p.sub { margin: 0 0 1.3rem; color: #676c85; font-size: 0.9rem; font-family: 'Public Sans', sans-serif; }
  input { width: 100%; box-sizing: border-box; padding: 0.7rem 0.85rem; border: 1px solid #d3d5ea;
    border-radius: 10px; font-size: 1rem; margin-bottom: 0.8rem; font-family: 'Public Sans', sans-serif; }
  input:focus { outline: 2px solid var(--primary); border-color: var(--primary); }
  button { width: 100%; padding: 0.75rem; border: 0; border-radius: 10px; background: var(--gradient-brand);
    color: #fff; font-size: 1rem; font-weight: 700; cursor: pointer; font-family: 'Public Sans', sans-serif; }
  button:hover { opacity: 0.92; }
  #error { color: #d9382a; font-size: 0.85rem; min-height: 1.1rem; margin-top: 0.6rem; }
  .toggle { text-align: center; margin-top: 1rem; font-size: 0.85rem; color: #676c85; }
  .toggle button { all: unset; color: var(--primary); font-weight: 700; cursor: pointer; font-family: 'Public Sans', sans-serif; font-size: inherit; }
  .legal-consent { font-size: 0.78rem; color: #676c85; text-align: center; margin: 0.9rem 0 0; }
  .legal-consent a { color: var(--primary); }
  .hidden { display: none; }
</style>
</head>
<body>
  <form class="card" id="auth-form">
    <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg></span>
    <h1>Kin<span>Read</span></h1>
    <p class="sub" id="auth-sub">Sign in to your account.</p>
    <input id="email" type="email" placeholder="Email" autocomplete="email" autofocus required />
    <input id="password" type="password" placeholder="Password" autocomplete="current-password" required />
    <button type="submit" id="auth-submit">Sign in</button>
    <p id="error"></p>
    <p class="toggle" id="forgot-toggle"><button type="button" id="forgot-btn">Forgot password?</button></p>
    <p class="toggle" id="auth-toggle">New here? <button type="button" id="toggle-btn">Create an account</button></p>
    <p class="legal-consent hidden" id="legal-consent">By creating an account, you agree to our <a href="/terms.html" target="_blank">Terms</a> and <a href="/privacy.html" target="_blank">Privacy Policy</a>.</p>
  </form>

  <form class="card hidden" id="forgot-form">
    <h1>Reset your password</h1>
    <p class="sub">Enter your account email and we'll send a reset link.</p>
    <input id="forgot-email" type="email" placeholder="Email" autocomplete="email" autofocus required />
    <button type="submit" id="forgot-submit">Send reset link</button>
    <p id="forgot-message" class="sub" style="margin:0.6rem 0 0"></p>
    <p class="toggle"><button type="button" id="forgot-back-btn">Back to sign in</button></p>
  </form>
  <script>
    let mode = 'login';
    const form = document.getElementById('auth-form');
    const sub = document.getElementById('auth-sub');
    const submitBtn = document.getElementById('auth-submit');
    const toggleWrap = document.getElementById('auth-toggle');
    function toggleMode() {
      mode = mode === 'login' ? 'signup' : 'login';
      sub.textContent = mode === 'login' ? 'Sign in to your account.' : 'Create your free KinRead account.';
      submitBtn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      document.getElementById('legal-consent').style.display = mode === 'signup' ? 'block' : 'none';
      document.getElementById('forgot-toggle').style.display = mode === 'login' ? 'block' : 'none';
      toggleWrap.textContent = mode === 'login' ? 'New here? ' : 'Already have an account? ';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = mode === 'login' ? 'Create an account' : 'Sign in';
      btn.addEventListener('click', toggleMode);
      toggleWrap.appendChild(btn);
    }
    document.getElementById('toggle-btn').addEventListener('click', toggleMode);
    document.getElementById('forgot-btn').addEventListener('click', () => {
      form.classList.add('hidden');
      document.getElementById('forgot-form').classList.remove('hidden');
    });
    document.getElementById('forgot-back-btn').addEventListener('click', () => {
      document.getElementById('forgot-form').classList.add('hidden');
      form.classList.remove('hidden');
    });
    document.getElementById('forgot-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('forgot-email').value;
      const messageEl = document.getElementById('forgot-message');
      const btn = document.getElementById('forgot-submit');
      btn.disabled = true;
      try {
        const res = await fetch('/api/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json().catch(() => ({}));
        messageEl.textContent = data.message || "If that email has an account, we've sent a reset link.";
      } catch {
        messageEl.textContent = 'Could not reach the server. Try again.';
      } finally {
        btn.disabled = false;
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('error');
      errorEl.textContent = '';
      try {
        const res = await fetch(mode === 'login' ? '/api/login' : '/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          errorEl.textContent = data.error || 'Something went wrong.';
          return;
        }
        window.location.href = '/';
      } catch {
        errorEl.textContent = 'Could not reach the server. Try again.';
      }
    });
  </script>
</body>
</html>`;

app.get('/login', (_req, res) => {
  res.type('html').send(AUTH_PAGE_HTML);
});

app.post('/api/signup', signupRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const accounts = await readAccounts();
  if (accounts.some((a) => a.email === normalizedEmail)) {
    return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });
  }
  const account = {
    id: randomUUID(),
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    plan: matchesAdminCredentials(normalizedEmail, password) ? 'paid' : 'free',
    analysesUsed: 0,
    periodStart: currentPeriodStart(),
    createdAt: new Date().toISOString(),
  };
  accounts.push(account);
  await writeAccounts(accounts);
  startSession(res, account.id);
  res.json({ ok: true, email: account.email });
});

app.post('/api/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const accounts = await readAccounts();
  const isAdminLogin = matchesAdminCredentials(normalizedEmail, password);
  let account = accounts.find((a) => a.email === normalizedEmail);
  if (!account && isAdminLogin) {
    account = {
      id: randomUUID(),
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      plan: 'paid',
      analysesUsed: 0,
      periodStart: currentPeriodStart(),
      createdAt: new Date().toISOString(),
    };
    accounts.push(account);
    await writeAccounts(accounts);
  }
  if (!account || (!isAdminLogin && !verifyPassword(password, account.passwordHash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (isAdminLogin && account.plan !== 'paid') {
    account.plan = 'paid';
    await writeAccounts(accounts);
  }
  startSession(res, account.id);
  res.json({ ok: true, email: account.email });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

app.post('/api/forgot-password', forgotPasswordRateLimit, async (req, res) => {
  const { email } = req.body || {};
  // Always respond the same way whether or not the account exists, so this endpoint can't
  // be used to discover which emails have an account.
  const genericResponse = { ok: true, message: "If that email has an account, we've sent a reset link." };
  if (!isValidEmail(email)) return res.json(genericResponse);

  const normalizedEmail = email.trim().toLowerCase();
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.email === normalizedEmail);
  if (account) {
    const token = randomBytes(32).toString('hex');
    account.resetTokenHash = hashToken(token);
    account.resetTokenExpiresAt = Date.now() + RESET_TOKEN_TTL_MS;
    await writeAccounts(accounts);

    const origin = `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${origin}/reset-password.html?token=${token}`;
    await sendEmail({
      to: account.email,
      subject: 'Reset your KinRead password',
      html: `<p>Someone requested a password reset for your KinRead account.</p>
        <p><a href="${resetUrl}">Click here to choose a new password</a> (valid for 1 hour).</p>
        <p>If this wasn't you, you can safely ignore this email.</p>`,
    }).catch((err) => console.error('Could not send password reset email:', err));
  }
  res.json(genericResponse);
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'Missing reset token.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const tokenHash = hashToken(token);
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.resetTokenHash === tokenHash);
  if (!account || !account.resetTokenExpiresAt || Date.now() >= account.resetTokenExpiresAt) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }
  account.passwordHash = hashPassword(password);
  delete account.resetTokenHash;
  delete account.resetTokenExpiresAt;
  await writeAccounts(accounts);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  const publicPaths = ['/login', '/api/login', '/api/signup', '/api/forgot-password', '/api/reset-password', '/privacy.html', '/terms.html', '/reset-password.html', '/style.css'];
  if (publicPaths.includes(req.path)) return next();
  const cookies = parseCookies(req.headers.cookie);
  const accountId = verifySession(cookies[SESSION_COOKIE]);
  if (accountId) {
    req.accountId = accountId;
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated.' });
  return res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/me', async (req, res) => {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.id === req.accountId);
  if (!account) return res.status(401).json({ error: 'Not authenticated.' });
  const analysesUsed = account.periodStart === currentPeriodStart() ? account.analysesUsed : 0;
  res.json({
    email: account.email,
    plan: account.plan,
    analysesUsed,
    analysesLimit: account.plan === 'paid' ? null : FREE_TIER_MONTHLY_LIMIT,
  });
});

// ---------- billing (Stripe Checkout + customer portal) ----------

app.post('/api/billing/create-checkout-session', async (req, res) => {
  if (!stripe || !process.env.STRIPE_PRICE_ID) {
    return res.status(500).json({ error: 'Billing is not set up yet - contact support.' });
  }
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.id === req.accountId);
  if (!account) return res.status(401).json({ error: 'Not authenticated.' });

  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer: account.stripeCustomerId || undefined,
      customer_email: account.stripeCustomerId ? undefined : account.email,
      client_reference_id: account.id,
      subscription_data: { metadata: { accountId: account.id } },
      success_url: `${origin}/?upgraded=1`,
      cancel_url: `${origin}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout session error:', err);
    res.status(502).json({ error: 'Could not start checkout. Try again.' });
  }
});

app.post('/api/billing/create-portal-session', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Billing is not set up yet - contact support.' });
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.id === req.accountId);
  if (!account?.stripeCustomerId) return res.status(400).json({ error: 'No billing account found yet.' });

  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${origin}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe portal session error:', err);
    res.status(502).json({ error: 'Could not open the billing portal. Try again.' });
  }
});

// Permanently deletes the account and every piece of data scoped to it (library, kids,
// thresholds). Cancels any active Stripe subscription first so billing doesn't keep going
// for a deleted account. The shared analysis cache is untouched - it holds no personal data.
app.delete('/api/account', async (req, res) => {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.id === req.accountId);
  if (!account) return res.status(401).json({ error: 'Not authenticated.' });

  if (stripe && account.stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(account.stripeSubscriptionId);
    } catch (err) {
      console.error('Could not cancel Stripe subscription during account deletion:', err.message);
    }
  }

  if (pool) {
    await pool.query('DELETE FROM account_state WHERE account_id = $1', [req.accountId]);
  } else {
    await rm(path.join(DATA_DIR, 'accounts', req.accountId), { recursive: true, force: true }).catch(() => {});
  }

  await writeAccounts(accounts.filter((a) => a.id !== req.accountId));
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

let pool = null;
if (process.env.DATABASE_URL) {
  try {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
      throw new Error('DATABASE_URL must start with postgres:// or postgresql://');
    }
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    });
  } catch (err) {
    console.warn(`WARNING: Invalid DATABASE_URL - using local JSON storage. ${err.message}`);
  }
}

// ---------- storage (Supabase PostgreSQL in production, JSON files locally) ----------

async function readJsonFile(filePath, fallback) {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonFile(filePath, data) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookaware_state (
      name TEXT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_state (
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      data JSONB NOT NULL,
      PRIMARY KEY (account_id, name)
    )
  `);
  console.log('Persistent storage enabled via DATABASE_URL');
}

async function readStoredJson(name, filePath, fallback) {
  if (!pool) return readJsonFile(filePath, fallback);
  const result = await pool.query('SELECT data FROM bookaware_state WHERE name = $1', [name]);
  if (result.rows.length) return result.rows[0].data;

  const data = await readJsonFile(filePath, fallback);
  await pool.query(
    'INSERT INTO bookaware_state (name, data) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING',
    [name, JSON.stringify(data)],
  );
  return data;
}

async function writeStoredJson(name, filePath, data) {
  if (!pool) return writeJsonFile(filePath, data);
  await pool.query(
    `INSERT INTO bookaware_state (name, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data`,
    [name, JSON.stringify(data)],
  );
}

// Per-account storage - every customer's library/kids/thresholds are isolated by accountId.
// The shared analysis cache below stays global (readStoredJson/writeStoredJson) on purpose:
// it's keyed by book, not by account, so every customer benefits from a book already scanned.
async function readAccountJson(accountId, name, fallback) {
  if (!pool) return readJsonFile(path.join(DATA_DIR, 'accounts', accountId, `${name}.json`), fallback);
  const result = await pool.query(
    'SELECT data FROM account_state WHERE account_id = $1 AND name = $2',
    [accountId, name],
  );
  if (result.rows.length) return result.rows[0].data;
  await pool.query(
    'INSERT INTO account_state (account_id, name, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (account_id, name) DO NOTHING',
    [accountId, name, JSON.stringify(fallback)],
  );
  return fallback;
}

async function writeAccountJson(accountId, name, data) {
  if (!pool) {
    const dir = path.join(DATA_DIR, 'accounts', accountId);
    await mkdir(dir, { recursive: true });
    return writeFile(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2), 'utf-8');
  }
  await pool.query(
    `INSERT INTO account_state (account_id, name, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (account_id, name) DO UPDATE SET data = EXCLUDED.data`,
    [accountId, name, JSON.stringify(data)],
  );
}

const readLibrary = (accountId) => readAccountJson(accountId, 'library', []);
const writeLibrary = (accountId, entries) => writeAccountJson(accountId, 'library', entries);
const readKids = (accountId) => readAccountJson(accountId, 'kids', []);
const writeKids = (accountId, kids) => writeAccountJson(accountId, 'kids', kids);
const readThresholds = (accountId) => readAccountJson(accountId, 'thresholds', null);
const writeThresholds = (accountId, thresholds) => writeAccountJson(accountId, 'thresholds', thresholds);
const readAnalysisCache = () => readStoredJson('analysisCache', ANALYSIS_CACHE_PATH, {});
const writeAnalysisCache = (cache) => writeStoredJson('analysisCache', ANALYSIS_CACHE_PATH, cache);
const readLessonSearchCache = () => readStoredJson('lessonSearchCache', LESSON_SEARCH_CACHE_PATH, {});
const writeLessonSearchCache = (cache) => writeStoredJson('lessonSearchCache', LESSON_SEARCH_CACHE_PATH, cache);

// Accounts stay in the shared (non-per-account) store, keyed by email for signup/login lookup.
const readAccounts = () => readStoredJson('accounts', ACCOUNTS_PATH, []);
const writeAccounts = (accounts) => writeStoredJson('accounts', ACCOUNTS_PATH, accounts);

function currentPeriodStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Resets the monthly counter if we've rolled into a new month, then enforces the free-tier
// cap (paid accounts are unlimited). Called only on a cache miss, right before paying for a
// fresh Claude analysis - cached results never count against a customer's quota.
async function checkAndConsumeAnalysisQuota(accountId) {
  const accounts = await readAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return { ok: false, error: 'Account not found.' };
  const thisPeriod = currentPeriodStart();
  if (account.periodStart !== thisPeriod) {
    account.periodStart = thisPeriod;
    account.analysesUsed = 0;
  }
  if (account.plan !== 'paid' && account.analysesUsed >= FREE_TIER_MONTHLY_LIMIT) {
    await writeAccounts(accounts);
    return {
      ok: false,
      error: `You've used your ${FREE_TIER_MONTHLY_LIMIT} free analyses this month. Upgrade to KinRead Family for unlimited analyses.`,
    };
  }
  account.analysesUsed += 1;
  await writeAccounts(accounts);
  return { ok: true };
}

// Every family that scans the same book reuses one shared, paid Claude analysis instead of
// paying for a fresh one. Prefer the ISBN (edition-specific); fall back to a normalized
// title+author key for books looked up without one.
function analysisCacheKey({ isbn, title, authors }) {
  const cleanIsbn = (isbn || '').replace(/[^0-9Xx]/g, '');
  if (cleanIsbn) return `isbn:${cleanIsbn.toLowerCase()}`;
  const normalize = (s) => (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim();
  return `title:${normalize(title)}|${normalize((authors || []).join(' '))}`;
}

// ---------- book lookup (Google Books API) ----------

app.post('/api/lookup', async (req, res) => {
  const { isbn, q } = req.body;
  let url;
  let cleanIsbn = '';

  if (isbn && /^\d{9,13}$/.test(isbn.replace(/-/g, ''))) {
    cleanIsbn = isbn.replace(/-/g, '');
    url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}`;
  } else if (q && q.trim().length > 1) {
    url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q.trim())}&maxResults=1`;
  } else {
    return res.status(400).json({ error: 'Provide either a valid ISBN (9-13 digits) or a title to search for.' });
  }

  // Add API key if available (improves rate limits)
  if (process.env.GOOGLE_BOOKS_API_KEY) {
    url += `&key=${process.env.GOOGLE_BOOKS_API_KEY}`;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Books responded ${response.status}`);
    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      return res.status(404).json({ error: 'No matching book found. Try a different search or check the spelling.' });
    }

    const info = data.items[0].volumeInfo;
    res.json({
      isbn: cleanIsbn || info.industryIdentifiers?.find((i) => i.type.startsWith('ISBN'))?.identifier || '',
      title: info.title || 'Unknown title',
      subtitle: info.subtitle || '',
      authors: info.authors || [],
      publisher: info.publisher || '',
      publishedDate: info.publishedDate || '',
      description: info.description || '',
      thumbnail: info.imageLinks?.thumbnail?.replace('http://', 'https://') || '',
      categories: info.categories || [],
    });
  } catch (err) {
    console.error('Lookup error:', err);
    res.status(502).json({ error: 'Could not reach the book lookup service. Check your connection and try again.' });
  }
});

// ---------- content analysis (Claude + web search) ----------

const ANALYSIS_SCHEMA_PROMPT = `Respond with ONLY a single valid JSON object - no markdown fences, no commentary before or after. Use exactly this shape:

{
  "identified": true or false,
  "confidence": "high" | "medium" | "low",
  "summary": "1-3 neutral sentences describing the book and its content overall",
  "categories": {
    "sexual_content": { "level": "none" | "mild" | "moderate" | "strong", "notes": "brief, specific, neutral description or empty string" },
    "language": { "level": "none" | "mild" | "moderate" | "strong", "notes": "brief note on swearing/cussing/crude language or empty string" },
    "violence": { "level": "none" | "mild" | "moderate" | "strong", "notes": "brief note or empty string" },
    "substance_use": { "level": "none" | "mild" | "moderate" | "strong", "notes": "brief note or empty string" },
    "self_harm_suicide": { "level": "none" | "mild" | "moderate" | "strong", "notes": "brief, factual note on any self-harm, suicidal ideation, or suicide content/themes - e.g. a background mention vs. a central plot element - or empty string if none" },
    "lgbtq_content": { "level": "none" | "minor" | "central", "notes": "factual, neutral description of any LGBTQ+ characters, relationships, or themes - e.g. who, and how central to the plot - or empty string if none" },
    "other_themes": { "level": "none" | "minor" | "central", "notes": "neutral note on other notable identity or thematic content - family structure, disability, race/culture, religion, grief, etc. - or empty string" }
  },
  "mental_models": [
    {
      "name": "short, plain-language name of a transferable way of thinking",
      "evidence": "specific plot, character choice, or recurring idea that illustrates it",
      "takeaway": "one neutral sentence about the useful lesson a child may take from it",
      "caveat": "brief note if the book complicates, challenges, or models an unhelpful version of the idea; otherwise empty string"
    }
  ],
  "age_guidance": "brief age or grade range only, e.g. '8-12' or 'Grades 3-5' - a few words at most, never a full sentence; empty string if unknown",
  "discussion_points": [
    {
      "topic": "short plain-language issue worth discussing with a child",
      "why_it_matters": "one brief, neutral sentence grounded in the story about why this issue may come up for a child",
      "principle": "short name of the child-development principle behind the suggestion, e.g. 'Validate before problem-solving' or 'Belonging and agency'",
      "talking_tip": "one brief, developmentally informed, non-diagnostic suggestion for how a parent could discuss it, written in plain, restrained UK English"
    }
  ],
  "comparable_titles": [
    {
      "title": "a well-known book most parents would recognise",
      "author": "author name",
      "why": "one short neutral sentence on what's similar - content level, themes, or reading experience"
    }
  ],
  "sources": [ { "title": "source name", "url": "https://..." } ],
  "caveat": "note here if identification is uncertain, sources disagree, or coverage is thin - otherwise empty string"
}`;

function extractJsonObject(text) {
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = unfenced.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < unfenced.length; index += 1) {
    const char = unfenced[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return unfenced.slice(start, index + 1);
  }
  return null;
}

// Claude occasionally emits a literal (unescaped) newline/tab inside a JSON string value,
// which JSON.parse rejects. Escape control characters that appear inside string literals.
function escapeControlCharsInStrings(text) {
  let inString = false;
  let escaped = false;
  let out = '';
  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      } else if (char === '\n') {
        out += '\\n';
        continue;
      } else if (char === '\r') {
        out += '\\r';
        continue;
      } else if (char === '\t') {
        out += '\\t';
        continue;
      }
    } else if (char === '"') {
      inString = true;
    }
    out += char;
  }
  return out;
}

// Claude's web search sometimes leaves literal citation markers (e.g. "(cite: ...)",
// "【cite†source】", footnote-style tokens, or "<cite index=...>...</cite>" tags wrapping
// real content) in generated prose instead of using structured citation metadata.
// Strip the markers/tags but keep any wrapped content before the client sees it.
function stripCitationArtifacts(value) {
  if (typeof value === 'string') {
    return value
      .replace(/<\/?cite[^>]*>/gi, '')
      .replace(/[\(\[]cite[^\)\]]*[\)\]]/gi, '')
      .replace(/[【\u3010][^】\u3011]*[】\u3011]/g, '')
      .replace(/\s+([,.;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
  if (Array.isArray(value)) return value.map(stripCitationArtifacts);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripCitationArtifacts(v)]));
  }
  return value;
}

app.post('/api/analyze', analyzeRateLimit, async (req, res) => {
  if (!anthropic) {
    return res.status(500).json({ error: 'Server has no ANTHROPIC_API_KEY configured. Add one to your .env file and restart.' });
  }

  const { title, authors, isbn, publisher, forceRefresh } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required to analyse a book.' });
  }

  const cacheKey = analysisCacheKey({ isbn, title, authors });
  const cache = await readAnalysisCache();
  if (!forceRefresh && cache[cacheKey]) {
    return res.json({ ...cache[cacheKey], cached: true });
  }

  // Only a cache miss costs a real Claude call, so only a cache miss counts against quota.
  const quota = await checkAndConsumeAnalysisQuota(req.accountId);
  if (!quota.ok) {
    return res.status(402).json({ error: quota.error });
  }

  const bookDescriptor = [
    `Title: ${title}`,
    authors?.length ? `Author(s): ${authors.join(', ')}` : null,
    publisher ? `Publisher: ${publisher}` : null,
    isbn ? `ISBN: ${isbn}` : null,
  ].filter(Boolean).join('\n');

  const prompt = `A parent is deciding whether the following children's or young-adult book is a fit for their family. Research this specific edition using web search - check sources like Common Sense Media, BookTrust, Kirkus Reviews, School Library Journal, Goodreads content-warning threads, or the publisher's own age guidance. Search efficiently: a couple of well-chosen queries covering the most reliable sources are better than many broad ones.

${bookDescriptor}

Report on: sexual content, coarse language/cussing, violence or scary content, substance use, self-harm or suicide themes (including whether it's a passing mention or a central plot element), LGBTQ+ characters/relationships/themes (reported factually - who and how central, not as a warning), and other notable themes (family structure, disability, race/culture, religion, grief, etc.). Also identify up to four mental models - transferable ways of thinking such as cause and effect, empathy, trade-offs, perseverance, incentives, systems thinking, or recognising unreliable assumptions - that the story genuinely illustrates. Ground each in the book's plot or characters; do not infer lessons from generic genre conventions. Include a caveat when the story presents the model as flawed, incomplete, or harmful. Return an empty array when no model can be supported confidently. If the story raises meaningful issues a parent may want to talk through with a child, include up to three discussion_points. Base each talking_tip on an appropriate, practical child psychiatry or psychology principle, such as emotion coaching (notice and name feelings), validation before problem-solving, developmentally appropriate perspective-taking, collaborative coping and safety planning, or repair after conflict. Where the story involves belonging, competition, mistaken goals, encouragement, or independence, you may also use an Adlerian lens: belonging and significance, agency within limits, encouragement over praise, and curiosity about the child's private logic. Put the chosen principle in the principle field. Use these frameworks as flexible conversation lenses, not diagnoses or treatment; do not label a child, predict behaviour, give clinical advice, or imply that an Adlerian interpretation is definitive. Write parent-facing guidance in plain, intelligent, restrained UK English. Keep sentences short and clean. State the substantive point directly. Avoid therapy-speak, motivational language, generic social-media phrasing, rhetorical flourishes, and unnecessary hedging. Distinguish what the story shows from what a parent might reasonably discuss. Keep suggestions neutral, practical, culturally respectful, and non-diagnostic; return an empty array when no clear discussion angle stands out. Also suggest up to three comparable titles - books a parent has likely already encountered - that are genuinely similar in reading level, tone, or content intensity, so they can quickly calibrate ("if you know X, expect a similar experience"); leave the array empty rather than guessing if nothing fits well. If you cannot confidently identify this exact book, say so in "caveat" and set "identified" to false rather than guessing.

${ANALYSIS_SCHEMA_PROMPT}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    const cleaned = extractJsonObject(text);

    let parsed;
    try {
      if (!cleaned) throw new Error('No complete JSON object in response');
      parsed = JSON.parse(escapeControlCharsInStrings(cleaned));
    } catch (parseErr) {
      console.error('Could not parse Claude response as JSON:', { stopReason: message.stop_reason, text });
      const error = message.stop_reason === 'max_tokens'
        ? 'The analysis response was cut short. Try again with this book.'
        : 'Got an unexpected response while analysing. Try again.';
      return res.status(502).json({ error });
    }

    const result = stripCitationArtifacts(parsed);
    // Don't cache low-confidence misses - a retry (or a future prompt tweak) might do better.
    if (result.identified !== false) {
      cache[cacheKey] = result;
      await writeAnalysisCache(cache);
    }

    res.json({ ...result, cached: false });
  } catch (err) {
    console.error('Analyse error:', err);
    res.status(502).json({ error: 'Content analysis failed. Check your API key and connection, then try again.' });
  }
});

// ---------- discover books by lesson/mental model (search by idea, not title) ----------

function lessonSearchCacheKey(query) {
  return query.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim();
}

app.post('/api/discover-by-lesson', analyzeRateLimit, async (req, res) => {
  if (!anthropic) {
    return res.status(500).json({ error: 'Server has no ANTHROPIC_API_KEY configured. Add one to your .env file and restart.' });
  }
  const { query } = req.body;
  if (!query || query.trim().length < 3) {
    return res.status(400).json({ error: 'Describe the idea or lesson you\'re looking for.' });
  }

  const cacheKey = lessonSearchCacheKey(query);
  const cache = await readLessonSearchCache();
  if (cache[cacheKey]) return res.json({ ...cache[cacheKey], cached: true });

  const quota = await checkAndConsumeAnalysisQuota(req.accountId);
  if (!quota.ok) return res.status(402).json({ error: quota.error });

  const prompt = `A parent wants to find children's or young-adult storybooks (real, existing published books - never invent a title) that genuinely illustrate the following idea or lesson through their plot or characters:

"${query.trim()}"

Suggest up to 5 real storybooks that are strong, genuine examples, not just tangentially related. For each, briefly explain how the story illustrates the idea, grounded in specific plot points or character choices, and include an approximate age range. If you can't confidently think of good real examples, return fewer (even zero) rather than inventing titles.

Respond with ONLY this JSON, no other text: { "books": [ { "title": "...", "author": "...", "ageRange": "...", "why": "..." } ] }`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    const cleaned = extractJsonObject(text);

    let parsed;
    try {
      if (!cleaned) throw new Error('No complete JSON object in response');
      parsed = JSON.parse(escapeControlCharsInStrings(cleaned));
    } catch (parseErr) {
      console.error('Could not parse lesson-search response as JSON:', { stopReason: message.stop_reason, text });
      const error = message.stop_reason === 'max_tokens'
        ? 'That search took longer than expected. Try a shorter or more specific description.'
        : 'Could not find book suggestions for that. Try rephrasing.';
      return res.status(502).json({ error });
    }

    const result = stripCitationArtifacts(parsed);
    cache[cacheKey] = result;
    await writeLessonSearchCache(cache);
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error('Lesson search error:', err);
    res.status(502).json({ error: 'Could not search for books right now. Try again.' });
  }
});

// ---------- family: kid profiles + age thresholds ----------

app.get('/api/kids', async (req, res) => {
  res.json(await readKids(req.accountId));
});

app.post('/api/kids', async (req, res) => {
  const { name, age } = req.body;
  if (!name || typeof age !== 'number' || age < 0 || age > 18) {
    return res.status(400).json({ error: 'A kid needs a name and an age (0-18).' });
  }
  const kids = await readKids(req.accountId);
  const kid = { id: randomUUID(), name, age };
  kids.push(kid);
  await writeKids(req.accountId, kids);
  res.json(kid);
});

app.put('/api/kids/:id', async (req, res) => {
  const { name, age } = req.body;
  const kids = await readKids(req.accountId);
  const kid = kids.find((k) => k.id === req.params.id);
  if (!kid) return res.status(404).json({ error: 'Kid profile not found.' });
  if (name) kid.name = name;
  if (typeof age === 'number') kid.age = age;
  await writeKids(req.accountId, kids);
  res.json(kid);
});

app.delete('/api/kids/:id', async (req, res) => {
  const kids = await readKids(req.accountId);
  const filtered = kids.filter((k) => k.id !== req.params.id);
  await writeKids(req.accountId, filtered);
  res.json({ deleted: filtered.length !== kids.length });
});

app.get('/api/thresholds', async (req, res) => {
  const saved = await readThresholds(req.accountId);
  res.json(saved || DEFAULT_THRESHOLDS);
});

app.post('/api/thresholds', async (req, res) => {
  await writeThresholds(req.accountId, req.body);
  res.json(req.body);
});

// ---------- cover photo reading (Claude vision, no web search needed) ----------

const COVER_READ_PROMPT = `This is a photo of a children's or YA book cover (front and/or back). Read what's actually printed:
- The book title, exactly as printed
- The author name(s)
- If a barcode is visible, the human-readable ISBN digits printed next to it (usually 10 or 13 digits, often starting 978 or 979) - only if you can read them clearly, don't guess digits

Respond with ONLY this JSON, no other text:
{ "title": "..." or empty string if unreadable, "authors": ["..."], "isbn": "..." or empty string, "confidence": "high" | "medium" | "low" }`;

app.post('/api/identify-cover', coverIdRateLimit, async (req, res) => {
  if (!anthropic) {
    return res.status(500).json({ error: 'Server has no ANTHROPIC_API_KEY configured. Add one to your .env file and restart.' });
  }
  const { image, mediaType } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'No image received.' });
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
          { type: 'text', text: COVER_READ_PROMPT },
        ],
      }],
    });

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(escapeControlCharsInStrings(cleaned));
    } catch (parseErr) {
      console.error('Could not parse cover-read response as JSON:', cleaned);
      return res.status(502).json({ error: 'Could not read that cover clearly. Try again with better lighting, or enter details manually.' });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Cover read error:', err);
    res.status(502).json({ error: 'Could not read the cover. Check your connection and try again.' });
  }
});

// ---------- library CRUD ----------

app.get('/api/library', async (req, res) => {
  const entries = await readLibrary(req.accountId);
  entries.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  res.json(entries);
});

app.post('/api/library', async (req, res) => {
  const entry = req.body;
  if (!entry.isbn && !entry.title) {
    return res.status(400).json({ error: 'Entry needs at least an ISBN or a title.' });
  }
  const entries = await readLibrary(req.accountId);
  const key = entry.isbn || entry.title;
  const existingIndex = entries.findIndex((e) => (e.isbn || e.title) === key);
  const toSave = { ...entry, savedAt: new Date().toISOString() };

  if (existingIndex >= 0) {
    entries[existingIndex] = { ...entries[existingIndex], ...toSave };
  } else {
    entries.push(toSave);
  }
  await writeLibrary(req.accountId, entries);
  res.json(toSave);
});

app.delete('/api/library/:key', async (req, res) => {
  const entries = await readLibrary(req.accountId);
  const filtered = entries.filter((e) => (e.isbn || e.title) !== req.params.key);
  await writeLibrary(req.accountId, filtered);
  res.json({ deleted: filtered.length !== entries.length });
});

const PORT = process.env.PORT || 3000;
initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`KinRead running at http://localhost:${PORT}`);
      if (!anthropic) {
        console.warn('WARNING: ANTHROPIC_API_KEY not set - content analysis will not work until you add one to .env');
      }
    });
  })
  .catch((err) => {
    console.error('Could not initialize persistent storage; using local JSON storage instead:', err.message);
    pool?.end().catch(() => {});
    pool = null;
    app.listen(PORT, () => {
      console.log(`KinRead running at http://localhost:${PORT}`);
      if (!anthropic) {
        console.warn('WARNING: ANTHROPIC_API_KEY not set - content analysis will not work until you add one to .env');
      }
    });
  });
