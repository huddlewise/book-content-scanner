import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const LIBRARY_PATH = path.join(DATA_DIR, 'library.json');
const KIDS_PATH = path.join(DATA_DIR, 'kids.json');
const THRESHOLDS_PATH = path.join(DATA_DIR, 'thresholds.json');

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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

const readLibrary = () => readStoredJson('library', LIBRARY_PATH, []);
const writeLibrary = (entries) => writeStoredJson('library', LIBRARY_PATH, entries);
const readKids = () => readStoredJson('kids', KIDS_PATH, []);
const writeKids = (kids) => writeStoredJson('kids', KIDS_PATH, kids);
const readThresholds = () => readStoredJson('thresholds', THRESHOLDS_PATH, null);
const writeThresholds = (thresholds) => writeStoredJson('thresholds', THRESHOLDS_PATH, thresholds);

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
  "age_guidance": "publisher/reviewer suggested age or grade range if known, otherwise empty string",
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

app.post('/api/analyze', async (req, res) => {
  if (!anthropic) {
    return res.status(500).json({ error: 'Server has no ANTHROPIC_API_KEY configured. Add one to your .env file and restart.' });
  }

  const { title, authors, isbn, publisher } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required to analyse a book.' });
  }

  const bookDescriptor = [
    `Title: ${title}`,
    authors?.length ? `Author(s): ${authors.join(', ')}` : null,
    publisher ? `Publisher: ${publisher}` : null,
    isbn ? `ISBN: ${isbn}` : null,
  ].filter(Boolean).join('\n');

  const prompt = `A parent is deciding whether the following children's or young-adult book is a fit for their family. Research this specific edition using web search - check sources like Common Sense Media, BookTrust, Kirkus Reviews, School Library Journal, Goodreads content-warning threads, or the publisher's own age guidance.

${bookDescriptor}

Report on: sexual content, coarse language/cussing, violence or scary content, substance use, self-harm or suicide themes (including whether it's a passing mention or a central plot element), LGBTQ+ characters/relationships/themes (reported factually - who and how central, not as a warning), and other notable themes (family structure, disability, race/culture, religion, grief, etc.). If you cannot confidently identify this exact book, say so in "caveat" and set "identified" to false rather than guessing.

${ANALYSIS_SCHEMA_PROMPT}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
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
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Could not parse Claude response as JSON:', { stopReason: message.stop_reason, text });
      const error = message.stop_reason === 'max_tokens'
        ? 'The analysis response was cut short. Try again with this book.'
        : 'Got an unexpected response while analysing. Try again.';
      return res.status(502).json({ error });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Analyse error:', err);
    res.status(502).json({ error: 'Content analysis failed. Check your API key and connection, then try again.' });
  }
});

// ---------- family: kid profiles + age thresholds ----------

app.get('/api/kids', async (_req, res) => {
  res.json(await readKids());
});

app.post('/api/kids', async (req, res) => {
  const { name, age } = req.body;
  if (!name || typeof age !== 'number' || age < 0 || age > 18) {
    return res.status(400).json({ error: 'A kid needs a name and an age (0-18).' });
  }
  const kids = await readKids();
  const kid = { id: randomUUID(), name, age };
  kids.push(kid);
  await writeKids(kids);
  res.json(kid);
});

app.put('/api/kids/:id', async (req, res) => {
  const { name, age } = req.body;
  const kids = await readKids();
  const kid = kids.find((k) => k.id === req.params.id);
  if (!kid) return res.status(404).json({ error: 'Kid profile not found.' });
  if (name) kid.name = name;
  if (typeof age === 'number') kid.age = age;
  await writeKids(kids);
  res.json(kid);
});

app.delete('/api/kids/:id', async (req, res) => {
  const kids = await readKids();
  const filtered = kids.filter((k) => k.id !== req.params.id);
  await writeKids(filtered);
  res.json({ deleted: filtered.length !== kids.length });
});

app.get('/api/thresholds', async (_req, res) => {
  const saved = await readThresholds();
  res.json(saved || DEFAULT_THRESHOLDS);
});

app.post('/api/thresholds', async (req, res) => {
  await writeThresholds(req.body);
  res.json(req.body);
});

// ---------- cover photo reading (Claude vision, no web search needed) ----------

const COVER_READ_PROMPT = `This is a photo of a children's or YA book cover (front and/or back). Read what's actually printed:
- The book title, exactly as printed
- The author name(s)
- If a barcode is visible, the human-readable ISBN digits printed next to it (usually 10 or 13 digits, often starting 978 or 979) - only if you can read them clearly, don't guess digits

Respond with ONLY this JSON, no other text:
{ "title": "..." or empty string if unreadable, "authors": ["..."], "isbn": "..." or empty string, "confidence": "high" | "medium" | "low" }`;

app.post('/api/identify-cover', async (req, res) => {
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
      parsed = JSON.parse(cleaned);
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

app.get('/api/library', async (_req, res) => {
  const entries = await readLibrary();
  entries.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  res.json(entries);
});

app.post('/api/library', async (req, res) => {
  const entry = req.body;
  if (!entry.isbn && !entry.title) {
    return res.status(400).json({ error: 'Entry needs at least an ISBN or a title.' });
  }
  const entries = await readLibrary();
  const key = entry.isbn || entry.title;
  const existingIndex = entries.findIndex((e) => (e.isbn || e.title) === key);
  const toSave = { ...entry, savedAt: new Date().toISOString() };

  if (existingIndex >= 0) {
    entries[existingIndex] = { ...entries[existingIndex], ...toSave };
  } else {
    entries.push(toSave);
  }
  await writeLibrary(entries);
  res.json(toSave);
});

app.delete('/api/library/:key', async (req, res) => {
  const entries = await readLibrary();
  const filtered = entries.filter((e) => (e.isbn || e.title) !== req.params.key);
  await writeLibrary(filtered);
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
