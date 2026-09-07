import 'dotenv/config';
import pg from 'pg';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const ORGANIZATIONS_PATH = path.join(DATA_DIR, 'organizations.json');

function requireString(value, field, index) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Organization ${index + 1} is missing required string field "${field}".`);
  }
}

function validateOrganizations(organizations) {
  if (!Array.isArray(organizations)) {
    throw new Error('data/organizations.json must contain a JSON array.');
  }

  const seenIds = new Set();
  const seenSlugs = new Set();
  organizations.forEach((organization, index) => {
    requireString(organization?.id, 'id', index);
    requireString(organization?.slug, 'slug', index);
    requireString(organization?.name, 'name', index);

    if (seenIds.has(organization.id)) throw new Error(`Duplicate organization id: ${organization.id}`);
    if (seenSlugs.has(organization.slug)) throw new Error(`Duplicate organization slug: ${organization.slug}`);
    seenIds.add(organization.id);
    seenSlugs.add(organization.slug);

    if (organization.plan && !['free', 'paid'].includes(organization.plan)) {
      throw new Error(`Organization ${organization.id} has invalid plan "${organization.plan}".`);
    }
  });
}

async function readOrganizationsFile() {
  const raw = await readFile(ORGANIZATIONS_PATH, 'utf-8');
  const organizations = JSON.parse(raw);
  validateOrganizations(organizations);
  return organizations;
}

async function syncToLocalFile(organizations) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(ORGANIZATIONS_PATH, `${JSON.stringify(organizations, null, 2)}\n`, 'utf-8');
  console.log(`Validated ${organizations.length} organization config(s) in data/organizations.json.`);
}

async function syncToPostgres(organizations) {
  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('DATABASE_URL must start with postgres:// or postgresql://');
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookaware_state (
        name TEXT PRIMARY KEY,
        data JSONB NOT NULL
      )
    `);
    await pool.query(
      `INSERT INTO bookaware_state (name, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data`,
      ['organizations', JSON.stringify(organizations)],
    );
    console.log(`Synced ${organizations.length} organization config(s) to Postgres shared state.`);
  } finally {
    await pool.end();
  }
}

async function main() {
  const organizations = await readOrganizationsFile();
  if (process.env.DATABASE_URL) {
    await syncToPostgres(organizations);
  } else {
    await syncToLocalFile(organizations);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
