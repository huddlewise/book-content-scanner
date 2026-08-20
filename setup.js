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

  let key = '';
  while (!key.startsWith('sk-ant-')) {
    key = (await ask('Paste your Anthropic API key: ')).trim();
    if (!key.startsWith('sk-ant-')) {
      console.log('That doesn\'t look like an Anthropic key (should start with "sk-ant-"). Try again.\n');
    }
  }
  rl.close();

  // Signing in uses a signed session cookie - a fixed secret keeps everyone logged in
  // across server restarts (without one, sessions reset on every restart/deploy).
  const sessionSecret = randomBytes(32).toString('hex');

  await writeFile(ENV_PATH, `ANTHROPIC_API_KEY=${key}\nSESSION_SECRET=${sessionSecret}\nPORT=3000\n`, 'utf-8');
  console.log('\nSaved! Starting the app now - you\'ll be asked to create a free account on first visit.\n');
}

main();
