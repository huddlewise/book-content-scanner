import readline from 'readline';
import { writeFile, access } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function isTruthy(value) {
  return ['y', 'yes', '1', 'true'].includes(String(value).trim().toLowerCase());
}

async function main() {
  if (await fileExists(ENV_PATH)) {
    console.log('Already set up (.env exists) - skipping.');
    console.log('Delete .env and run "node setup.js" again if you want to change your key.\n');
    return;
  }

  console.log('\nKinRead setup');
  console.log('--------------');
  console.log('You need a free Anthropic API key to run analyses.');
  console.log('Get one at https://console.anthropic.com  (Settings -> API Keys)\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  let anthropicKey = '';
  while (!anthropicKey.startsWith('sk-ant-')) {
    anthropicKey = (await ask('Paste your Anthropic API key: ')).trim();
    if (!anthropicKey.startsWith('sk-ant-')) {
      console.log('That doesn\'t look like an Anthropic key (should start with "sk-ant-"). Try again.\n');
    }
  }

  let stripeSetup = '';
  while (!['y', 'n'].includes(stripeSetup.trim().toLowerCase())) {
    stripeSetup = (await ask('Set up Stripe billing now? (y/n): ')).trim();
  }

  let stripeSecretKey = '';
  let stripePriceId = '';
  let stripeWebhookSecret = '';

  if (isTruthy(stripeSetup)) {
    console.log('\nStripe setup (optional but required for paid checkout):');
    while (!stripeSecretKey.startsWith('sk_')) {
      stripeSecretKey = (await ask('Stripe secret key (starts with sk_): ')).trim();
      if (!stripeSecretKey.startsWith('sk_')) {
        console.log('That doesn\'t look like a Stripe secret key. Try again.\n');
      }
    }

    while (!stripePriceId.startsWith('price_')) {
      stripePriceId = (await ask('Stripe price ID (starts with price_): ')).trim();
      if (!stripePriceId.startsWith('price_')) {
        console.log('That doesn\'t look like a Stripe price ID. Try again.\n');
      }
    }

    while (!stripeWebhookSecret.startsWith('whsec_')) {
      stripeWebhookSecret = (await ask('Stripe webhook secret (starts with whsec_): ')).trim();
      if (!stripeWebhookSecret.startsWith('whsec_')) {
        console.log('That doesn\'t look like a Stripe webhook secret. Try again.\n');
      }
    }
  }
  rl.close();

  // Signing in uses a signed session cookie - a fixed secret keeps everyone logged in
  // across server restarts (without one, sessions reset on every restart/deploy).
  const sessionSecret = randomBytes(32).toString('hex');

  const envLines = [
    `ANTHROPIC_API_KEY=${anthropicKey}`,
    `SESSION_SECRET=${sessionSecret}`,
    'PORT=3000',
  ];

  if (stripeSecretKey) {
    envLines.push(`STRIPE_SECRET_KEY=${stripeSecretKey}`);
  }
  if (stripePriceId) {
    envLines.push(`STRIPE_PRICE_ID=${stripePriceId}`);
  }
  if (stripeWebhookSecret) {
    envLines.push(`STRIPE_WEBHOOK_SECRET=${stripeWebhookSecret}`);
  }

  await writeFile(ENV_PATH, `${envLines.join('\n')}\n`, 'utf-8');

  if (stripeSecretKey && stripePriceId && stripeWebhookSecret) {
    console.log('\nSaved! Stripe billing is enabled for this app.\n');
  } else {
    console.log('\nSaved! Start the app and add Stripe values later if you want paid checkout enabled.\n');
  }
}

main();
