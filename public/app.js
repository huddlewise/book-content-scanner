// ---------- state ----------
let currentBook = null;
let currentAnalysis = null;
let codeReader = null;
let cameraActive = false;
let cameraMode = null; // 'barcode' | 'photo'
let activeStream = null;
let barcodeHintTimer = null;
let pendingCoverDetails = null;
let kidsCache = [];
let thresholdsCache = {};

loadFamily(); // load kid profiles + thresholds up front so verdicts are ready right after a scan

// ---------- view switching ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.getElementById(`view-${tab.dataset.view}`).classList.add('active');
    if (tab.dataset.view === 'library') loadLibrary();
    if (tab.dataset.view === 'family') loadFamily();
    if (tab.dataset.view === 'scan') stopCamera();
  });
});

// ---------- camera: barcode scanning + cover photo capture ----------
const btnToggleCamera = document.getElementById('btn-toggle-camera');
const btnPhotoCover = document.getElementById('btn-photo-cover');
const btnCapturePhoto = document.getElementById('btn-capture-photo');
const cameraWrap = document.getElementById('camera-wrap');
const cameraStatus = document.getElementById('camera-status');
const cameraVideo = document.getElementById('camera-preview');

function barcodeDecodeHints() {
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
    ZXing.BarcodeFormat.EAN_13,
    ZXing.BarcodeFormat.EAN_8,
    ZXing.BarcodeFormat.UPC_A,
    ZXing.BarcodeFormat.UPC_E,
  ]);
  return hints;
}

btnToggleCamera.addEventListener('click', () => {
  if (cameraActive && cameraMode === 'barcode') stopCamera();
  else { stopCamera(); startCamera('barcode'); }
});

btnPhotoCover.addEventListener('click', () => {
  if (cameraActive && cameraMode === 'photo') stopCamera();
  else { stopCamera(); startCamera('photo'); }
});

btnCapturePhoto.addEventListener('click', () => {
  if (cameraMode === 'barcode') captureBarcode();
  else capturePhoto();
});

function startCamera(mode) {
  cameraMode = mode;
  cameraActive = true;
  cameraWrap.classList.remove('hidden');

  if (mode === 'barcode') {
    if (typeof ZXing === 'undefined') {
      cameraStatus.textContent = 'Barcode scanner failed to load. Check your internet connection, or enter details manually below.';
      return;
    }
    btnToggleCamera.textContent = 'Stop scanning';
    btnCapturePhoto.textContent = 'Capture barcode';
    btnCapturePhoto.classList.remove('hidden');
    cameraStatus.textContent = 'Camera ready. Point it at the barcode on the back cover.';
    clearTimeout(barcodeHintTimer);
    barcodeHintTimer = setTimeout(() => {
      if (cameraActive && cameraMode === 'barcode') {
        cameraStatus.textContent = 'Still looking. Hold the barcode flat, fill the frame, and avoid glare. You can also use Photograph cover.';
      }
    }, 8000);

    codeReader = new ZXing.BrowserMultiFormatReader(barcodeDecodeHints());
    codeReader.decodeFromConstraints({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    }, 'camera-preview', (result) => {
      if (result) {
        const text = result.getText().replace(/-/g, '');
        if (/^\d{10}$|^\d{13}$/.test(text)) {
          document.getElementById('input-isbn').value = text;
          stopCamera();
          lookupBook({ isbn: text });
        }
      }
      // NotFoundException fires continuously while no barcode is in frame - ignore it.
    }).catch((err) => {
      console.error('Camera error:', err);
      cameraStatus.textContent = 'Could not start the barcode scanner. Check camera permissions, or enter the ISBN manually below.';
      stopCamera();
    });
  } else {
    btnPhotoCover.textContent = 'Cancel';
    btnCapturePhoto.textContent = 'Capture cover';
    btnCapturePhoto.classList.remove('hidden');
    cameraStatus.textContent = 'Frame the title and author (and barcode, if visible), then tap Capture.';

    navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    })
      .then((stream) => {
        activeStream = stream;
        cameraVideo.srcObject = stream;
        cameraVideo.play().catch(() => {});
      })
      .catch((err) => {
        console.error('Camera error:', err);
        cameraStatus.textContent = 'Could not access the camera. Check permissions, or enter details manually below.';
        stopCamera();
      });
  }
}

function stopCamera() {
  clearTimeout(barcodeHintTimer);
  barcodeHintTimer = null;
  if (codeReader) {
    codeReader.reset();
    codeReader = null;
  }
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }
  cameraVideo.srcObject = null;
  cameraActive = false;
  cameraMode = null;
  cameraWrap.classList.add('hidden');
  btnCapturePhoto.classList.add('hidden');
  btnToggleCamera.textContent = 'Scan barcode';
  btnPhotoCover.textContent = 'Photograph cover';
  cameraStatus.textContent = '';
}

async function capturePhoto() {
  const canvas = document.createElement('canvas');
  const maxDim = 1000;
  const scale = Math.min(1, maxDim / Math.max(cameraVideo.videoWidth, cameraVideo.videoHeight));
  canvas.width = cameraVideo.videoWidth * scale;
  canvas.height = cameraVideo.videoHeight * scale;
  canvas.getContext('2d').drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  const previewUrl = canvas.toDataURL('image/jpeg', 0.72);

  stopCamera();
  const errorEl = document.getElementById('lookup-error');
  errorEl.classList.add('hidden');
  cameraStatus.textContent = 'Reading the cover...';

  try {
    const res = await fetch('/api/identify-cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, mediaType: 'image/jpeg' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not read the cover');

    if (!data.isbn && !data.title) {
      throw new Error("Couldn't make out the title or author clearly. Try again with better lighting, or enter it manually below.");
    }
    pendingCoverDetails = { ...data, previewUrl };
    renderCoverConfirmation(pendingCoverDetails);
  } catch (err) {
    cameraStatus.textContent = '';
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

function renderCoverConfirmation(details) {
  document.getElementById('cover-confirm-image').src = details.previewUrl;
  document.getElementById('cover-confirm-title').textContent = details.title || 'Title not detected';
  document.getElementById('cover-confirm-author').textContent = details.authors?.length
    ? details.authors.join(', ')
    : 'Author not detected';
  document.getElementById('cover-confirm-isbn').textContent = details.isbn ? `ISBN ${details.isbn}` : 'ISBN not detected';
  show('cover-confirm');
}

document.getElementById('btn-use-cover-details').addEventListener('click', () => {
  if (!pendingCoverDetails) return;
  const { isbn, title, authors } = pendingCoverDetails;
  hide('cover-confirm');
  if (isbn) {
    document.getElementById('input-isbn').value = isbn;
    lookupBook({ isbn });
  } else {
    const q = [title, (authors || []).join(' ')].filter(Boolean).join(' ');
    document.getElementById('input-title-search').value = q;
    lookupBook({ q });
  }
});

document.getElementById('btn-retry-cover').addEventListener('click', () => {
  pendingCoverDetails = null;
  hide('cover-confirm');
  startCamera('photo');
});

async function captureBarcode() {
  if (!cameraVideo.videoWidth || !cameraVideo.videoHeight || !codeReader) {
    cameraStatus.textContent = 'Camera is not ready yet. Hold still and try again.';
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = cameraVideo.videoWidth;
  canvas.height = cameraVideo.videoHeight;
  canvas.getContext('2d').drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);
  const attempts = [canvas];
  const crop = (x, y, width, height) => {
    const cropped = document.createElement('canvas');
    cropped.width = Math.round(canvas.width * width);
    cropped.height = Math.round(canvas.height * height);
    cropped.getContext('2d').drawImage(
      canvas,
      Math.round(canvas.width * x), Math.round(canvas.height * y),
      cropped.width, cropped.height,
      0, 0, cropped.width, cropped.height,
    );
    return cropped;
  };
  attempts.push(crop(0.05, 0.2, 0.9, 0.75));
  attempts.push(crop(0.1, 0.4, 0.8, 0.55));

  for (const attempt of attempts) {
    const image = new Image();
    image.src = attempt.toDataURL('image/png');
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });
      const stillReader = new ZXing.BrowserMultiFormatReader(barcodeDecodeHints());
      const result = await stillReader.decodeFromImage(image);
      const text = result.getText().replace(/-/g, '');
      if (/^\d{10}$|^\d{13}$/.test(text)) {
        document.getElementById('input-isbn').value = text;
        stopCamera();
        lookupBook({ isbn: text });
        return;
      }
    } catch {
      // Try the next crop before showing the failure message.
    }
  }
  cameraStatus.textContent = 'No ISBN barcode found. Move closer, fill the frame with the barcode, and avoid glare.';
}

// ---------- manual entry ----------
document.getElementById('btn-toggle-manual').addEventListener('click', (e) => {
  document.getElementById('form-title').classList.toggle('hidden');
  const nowVisible = !document.getElementById('form-title').classList.contains('hidden');
  e.target.textContent = nowVisible ? 'Hide title search' : "Can't find a barcode? Search by title instead";
});

document.getElementById('form-isbn').addEventListener('submit', (e) => {
  e.preventDefault();
  const isbn = document.getElementById('input-isbn').value.trim();
  if (isbn) lookupBook({ isbn });
});

document.getElementById('form-title').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('input-title-search').value.trim();
  if (q) lookupBook({ q });
});

// ---------- lookup ----------
async function lookupBook(payload) {
  const errorEl = document.getElementById('lookup-error');
  errorEl.classList.add('hidden');
  hide('book-card');
  hide('analysis-card');
  hide('analysis-loading');

  try {
    const res = await fetch('/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lookup failed');

    currentBook = data;
    renderBookCard(data);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

function renderBookCard(book) {
  document.getElementById('book-thumb').src = book.thumbnail || '';
  document.getElementById('book-thumb').style.visibility = book.thumbnail ? 'visible' : 'hidden';
  document.getElementById('book-title').textContent = book.title + (book.subtitle ? `: ${book.subtitle}` : '');
  document.getElementById('book-authors').textContent = book.authors?.length ? book.authors.join(', ') : 'Author unknown';
  const metaParts = [book.publisher, book.publishedDate].filter(Boolean);
  document.getElementById('book-meta').textContent = metaParts.join(' · ');
  show('book-card');
}

// ---------- analysis ----------
document.getElementById('btn-analyze').addEventListener('click', async () => {
  if (!currentBook) return;
  hide('analysis-card');
  show('analysis-loading');

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: currentBook.title,
        authors: currentBook.authors,
        isbn: currentBook.isbn,
        publisher: currentBook.publisher,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');

    currentAnalysis = data;
    renderAnalysis(data);
  } catch (err) {
    document.getElementById('analysis-card').innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    show('analysis-card');
  } finally {
    hide('analysis-loading');
  }
});

const CATEGORY_LABELS = {
  sexual_content: 'Sexual content',
  language: 'Language / profanity',
  violence: 'Violence',
  substance_use: 'Substance use',
  self_harm_suicide: 'Self-harm / suicide',
  lgbtq_content: 'LGBTQ+ content',
  other_themes: 'Other themes',
};

function stampClass(key, level) {
  if (key === 'lgbtq_content' || key === 'other_themes') return 'stamp-info';
  return { none: 'stamp-clear', mild: 'stamp-mild', moderate: 'stamp-moderate', strong: 'stamp-strong' }[level] || 'stamp-info';
}

function renderContentAlert(categories) {
  const priorityKeys = ['sexual_content', 'language', 'violence', 'substance_use', 'self_harm_suicide'];
  const flagged = priorityKeys
    .filter((key) => {
      const level = categories[key]?.level;
      return level === 'strong' || (key === 'self_harm_suicide' && level === 'moderate');
    })
    .map((key) => CATEGORY_LABELS[key]);
  if (!flagged.length) return '';
  return `
    <div class="content-alert" role="alert">
      <strong>Strong content flagged</strong>
      <span>${escapeHtml(flagged.join(', '))}</span>
      <p>This book may not be suitable for children or younger teens. Review the notes below before deciding.</p>
    </div>`;
}

function renderAnalysis(result) {
  const card = document.getElementById('analysis-card');
  const cats = result.categories || {};

  const stamps = Object.keys(CATEGORY_LABELS).map((key) => {
    const cat = cats[key] || { level: 'none', notes: '' };
    const cls = stampClass(key, cat.level);
    return `
      <div class="stamp ${cls}">
        <span class="stamp-category">${CATEGORY_LABELS[key]}</span>
        <span class="stamp-level">${escapeHtml(cat.level || 'none')}</span>
        ${cat.notes ? `<span class="stamp-notes">${escapeHtml(cat.notes)}</span>` : ''}
      </div>`;
  }).join('');

  const sources = (result.sources || []).map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a></li>`).join('');

  card.innerHTML = `
    <p class="card-label">Content summary — confidence: ${escapeHtml(result.confidence || 'unknown')}</p>
    ${renderContentAlert(cats)}
    <p class="analysis-summary">${escapeHtml(result.summary || '')}</p>
    ${renderKidVerdicts(cats)}
    <details class="severity-key">
      <summary>What do mild, moderate, and strong mean?</summary>
      <div class="severity-key-body">
        <p><strong>Mild</strong> — brief, lower-intensity, or lightly referenced content.</p>
        <p><strong>Moderate</strong> — clearer, more explicit, recurring, or more intense content.</p>
        <p><strong>Strong</strong> — graphic, intense, central, or especially distressing content.</p>
        <p class="hint">These are guidance levels, not universal ratings. Read the notes and sources alongside them.</p>
      </div>
    </details>
    <div class="stamp-grid">${stamps}</div>
    ${result.age_guidance ? `<p class="meta-line">Suggested age: ${escapeHtml(result.age_guidance)}</p>` : ''}
    ${result.caveat ? `<div class="caveat-box">${escapeHtml(result.caveat)}</div>` : ''}
    ${sources ? `<ul class="sources">${sources}</ul>` : ''}
    <label for="notes-field">Your notes (optional)</label>
    <textarea id="notes-field" class="notes-field" placeholder="Anything you want to remember about this one..."></textarea>
    <button id="btn-save" class="btn btn-primary btn-block">Save to library</button>
  `;
  show('analysis-card');

  document.getElementById('btn-save').addEventListener('click', saveCurrentBook);
}

async function saveCurrentBook() {
  const notes = document.getElementById('notes-field')?.value || '';
  const entry = {
    ...currentBook,
    analysis: currentAnalysis,
    parentNotes: notes,
  };
  const btn = document.getElementById('btn-save');
  btn.textContent = 'Saving...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error('Save failed');
    btn.textContent = 'Saved ✓';
  } catch (err) {
    btn.textContent = 'Could not save — try again';
    btn.disabled = false;
  }
}

// ---------- library ----------
let libraryCache = [];
let activeGenre = null;

async function loadLibrary() {
  const res = await fetch('/api/library');
  libraryCache = await res.json();
  renderGenreChips();
  applyLibraryFilters();
}

document.getElementById('library-search').addEventListener('input', applyLibraryFilters);

// Google Books categories often come as paths like "Juvenile Fiction / Fantasy & Magic" -
// use the most specific segment as the genre label, skipping generic trailing segments
// like "General" that Google Books sometimes appends after the real genre.
const GENERIC_GENRE_SEGMENTS = new Set(['general', 'other']);
function genreLabel(raw) {
  const parts = raw.split('/').map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (!GENERIC_GENRE_SEGMENTS.has(parts[i].toLowerCase())) return parts[i];
  }
  return parts[parts.length - 1] || raw;
}

function renderGenreChips() {
  const container = document.getElementById('genre-chips');
  const labels = new Set();
  libraryCache.forEach((b) => (b.categories || []).forEach((c) => labels.add(genreLabel(c))));
  const sorted = [...labels].sort((a, b) => a.localeCompare(b));

  if (sorted.length === 0) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = sorted.map((g) => `<button class="genre-chip ${g === activeGenre ? 'active' : ''}" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('');

  container.querySelectorAll('.genre-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      activeGenre = activeGenre === chip.dataset.genre ? null : chip.dataset.genre;
      renderGenreChips();
      applyLibraryFilters();
    });
  });
}

function applyLibraryFilters() {
  const q = document.getElementById('library-search').value.toLowerCase();
  const filtered = libraryCache.filter((b) => {
    const matchesText = !q
      || (b.title || '').toLowerCase().includes(q)
      || (b.authors || []).join(' ').toLowerCase().includes(q)
      || (b.categories || []).join(' ').toLowerCase().includes(q);
    const matchesGenre = !activeGenre || (b.categories || []).some((c) => genreLabel(c) === activeGenre);
    return matchesText && matchesGenre;
  });
  renderLibrary(filtered);
}

function renderLibrary(entries) {
  const list = document.getElementById('library-list');
  const empty = document.getElementById('library-empty');
  if (entries.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = libraryCache.length === 0
      ? 'No books saved yet. Scan one to get started.'
      : 'No saved books match that search.';
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = entries.map((entry, i) => {
    const cats = entry.analysis?.categories || {};
    const badges = Object.keys(CATEGORY_LABELS)
      .filter((key) => cats[key] && cats[key].level && cats[key].level !== 'none')
      .map((key) => `<span class="mini-badge ${stampClass(key, cats[key].level)}">${CATEGORY_LABELS[key]}</span>`)
      .join('');
    const genre = entry.categories?.length ? genreLabel(entry.categories[0]) : '';

    return `
      <div class="card library-item" data-index="${i}">
        <img class="book-thumb" src="${escapeHtml(entry.thumbnail || '')}" alt="" style="${entry.thumbnail ? '' : 'visibility:hidden'}" />
        <div style="flex:1">
          <p class="library-item-title">${escapeHtml(entry.title || 'Untitled')}</p>
          <p class="muted small">${escapeHtml((entry.authors || []).join(', '))}${genre ? ` · ${escapeHtml(genre)}` : ''}</p>
          <div class="library-item-badges">${badges || '<span class="mini-badge stamp-clear">No flags</span>'}</div>
          <div class="library-item-detail hidden">
            ${entry.analysis?.summary ? `<p class="small">${escapeHtml(entry.analysis.summary)}</p>` : ''}
            ${renderKidVerdicts(entry.analysis?.categories || {})}
            ${entry.parentNotes ? `<p class="small"><em>${escapeHtml(entry.parentNotes)}</em></p>` : ''}
            <div class="library-actions">
              <button class="btn-delete" data-key="${escapeHtml(entry.isbn || entry.title)}">Remove</button>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.library-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-delete')) return;
      el.querySelector('.library-item-detail').classList.toggle('hidden');
    });
  });

  list.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/library/${encodeURIComponent(btn.dataset.key)}`, { method: 'DELETE' });
      loadLibrary();
    });
  });
}

// ---------- family: kid profiles + age thresholds ----------

const SEVERITY_LEVELS = ['mild', 'moderate', 'strong'];
const THEME_LEVELS = ['minor', 'central'];
const THEME_KEYS = new Set(['lgbtq_content', 'other_themes']);
// Kid ages are capped at 18, so a threshold at or above this always flags, at any age -
// used as the stored value when a parent chooses "Always flag" for a level.
const NEVER_OK_VALUE = 99;

async function loadFamily() {
  const [kidsRes, thresholdsRes] = await Promise.all([fetch('/api/kids'), fetch('/api/thresholds')]);
  kidsCache = await kidsRes.json();
  thresholdsCache = await thresholdsRes.json();
  renderKidsList();
  renderThresholdsForm();
}

function renderKidsList() {
  const list = document.getElementById('kids-list');
  if (!list) return;
  if (!kidsCache.length) {
    list.innerHTML = '<p class="hint">No kids added yet — add one below to start seeing personalized verdicts.</p>';
    return;
  }
  list.innerHTML = kidsCache.map((kid) => `
    <div class="kid-row">
      <span>${escapeHtml(kid.name)} · age ${kid.age}</span>
      <button class="btn-delete" data-id="${kid.id}">Remove</button>
    </div>`).join('');

  list.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/kids/${btn.dataset.id}`, { method: 'DELETE' });
      loadFamily();
    });
  });
}

document.getElementById('form-add-kid').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('input-kid-name').value.trim();
  const age = Number(document.getElementById('input-kid-age').value);
  if (!name || Number.isNaN(age)) return;
  await fetch('/api/kids', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, age }),
  });
  document.getElementById('input-kid-name').value = '';
  document.getElementById('input-kid-age').value = '';
  loadFamily();
});

function renderThresholdsForm() {
  const container = document.getElementById('thresholds-form');
  if (!container) return;
  container.innerHTML = Object.keys(CATEGORY_LABELS).map((key) => {
    const levels = THEME_KEYS.has(key) ? THEME_LEVELS : SEVERITY_LEVELS;
    const inputs = levels.map((lvl) => {
      const val = thresholdsCache[key]?.[lvl] ?? 0;
      const neverOk = val >= NEVER_OK_VALUE;
      return `
        <div class="threshold-level">
          <span class="threshold-level-name">${lvl}</span>
          <label class="threshold-age-label">
            from age
            <input type="number" min="0" max="18" class="threshold-age-input ${neverOk ? 'hidden' : ''}"
              data-cat="${key}" data-level="${lvl}" value="${neverOk ? '' : val}" placeholder="age" aria-label="${lvl} comfortable from age" />
          </label>
          <label class="never-ok-label">
            <input type="checkbox" class="never-ok-checkbox" data-cat="${key}" data-level="${lvl}" ${neverOk ? 'checked' : ''} />
            Never recommend
          </label>
        </div>`;
    }).join('');
    return `<div class="threshold-row"><p class="threshold-cat-label">${CATEGORY_LABELS[key]}</p><div class="threshold-inputs">${inputs}</div></div>`;
  }).join('');

  container.querySelectorAll('.never-ok-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      const numInput = cb.closest('.threshold-level').querySelector('.threshold-age-input');
      if (cb.checked) {
        numInput.dataset.prevValue = numInput.value || '0';
        numInput.value = '';
        numInput.classList.add('hidden');
      } else {
        numInput.classList.remove('hidden');
        numInput.value = numInput.dataset.prevValue || '0';
      }
    });
  });
}

document.getElementById('btn-save-thresholds').addEventListener('click', async () => {
  const newThresholds = {};
  document.querySelectorAll('.threshold-level').forEach((row) => {
    const checkbox = row.querySelector('.never-ok-checkbox');
    const numInput = row.querySelector('.threshold-age-input');
    const { cat, level } = checkbox.dataset;
    if (!newThresholds[cat]) newThresholds[cat] = {};
    newThresholds[cat][level] = checkbox.checked ? NEVER_OK_VALUE : (Number(numInput.value) || 0);
  });
  const res = await fetch('/api/thresholds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newThresholds),
  });
  thresholdsCache = await res.json();
  const saved = document.getElementById('thresholds-saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 2000);
});

// A category only counts against a kid if a threshold age is set (> 0) for that level -
// lgbtq_content/other_themes default to 0, so they're informational only until a parent opts in.
function computeVerdict(categories, kid, thresholds) {
  const flagged = [];
  Object.keys(CATEGORY_LABELS).forEach((key) => {
    const cat = categories[key];
    if (!cat || !cat.level || cat.level === 'none') return;
    const requiredAge = thresholds[key]?.[cat.level];
    if (typeof requiredAge === 'number' && requiredAge > 0 && kid.age < requiredAge) {
      flagged.push(key);
    }
  });
  return { ok: flagged.length === 0, flagged };
}

function renderKidVerdicts(categories) {
  if (!kidsCache.length) return '';
  const rows = kidsCache.map((kid) => {
    const { ok, flagged } = computeVerdict(categories, kid, thresholdsCache);
    const cls = ok ? 'stamp-clear' : 'stamp-mild';
    const hardFlagged = flagged.filter((key) => thresholdsCache[key]?.[categories[key]?.level] >= NEVER_OK_VALUE);
    const label = ok
      ? 'Within your settings'
      : hardFlagged.length
        ? 'Never recommend'
        : 'Review first for this age';
    const detail = flagged.length ? ` — ${flagged.map((k) => CATEGORY_LABELS[k]).join(', ')}` : '';
    return `<div class="kid-verdict"><span class="kid-name">${escapeHtml(kid.name)} (${kid.age})</span><span class="kid-verdict-label ${cls}">${escapeHtml(label + detail)}</span></div>`;
  }).join('');
  return `<div class="kid-verdicts"><p class="card-label">Family decision</p><p class="hint">Based on the boundaries you set for each child.</p>${rows}</div>`;
}

// ---------- helpers ----------
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
