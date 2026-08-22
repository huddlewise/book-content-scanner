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
loadAccount();

// ---------- account ----------
async function loadAccount() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return;
    const account = await res.json();

    document.getElementById('account-trigger').textContent = account.email[0]?.toUpperCase() || '?';
    document.getElementById('account-email').textContent = account.email;
    document.getElementById('account-usage').textContent = account.analysesLimit
      ? `${account.analysesUsed}/${account.analysesLimit} free analyses this month`
      : 'KinRead Family plan';
    show('account-badge');

    const billingBtn = document.getElementById('btn-billing');
    billingBtn.textContent = account.plan === 'paid' ? 'Manage billing' : 'Upgrade';
    billingBtn.classList.remove('hidden');
    billingBtn.onclick = () => {
      document.getElementById('account-dropdown').classList.add('hidden');
      startBillingFlow(account.plan === 'paid' ? 'portal' : 'checkout');
    };
    return account;
  } catch {
    // not fatal - the menu just stays hidden
    return null;
  }
}

document.getElementById('account-trigger').addEventListener('click', (e) => {
  e.stopPropagation();
  const dropdown = document.getElementById('account-dropdown');
  const nowOpen = dropdown.classList.toggle('hidden') === false;
  document.getElementById('account-trigger').setAttribute('aria-expanded', String(nowOpen));
});
document.addEventListener('click', (e) => {
  const menu = document.getElementById('account-badge');
  if (!menu.contains(e.target)) {
    document.getElementById('account-dropdown').classList.add('hidden');
    document.getElementById('account-trigger').setAttribute('aria-expanded', 'false');
  }
});

async function startBillingFlow(kind) {
  const endpoint = kind === 'portal' ? '/api/billing/create-portal-session' : '/api/billing/create-checkout-session';
  try {
    const res = await fetch(endpoint, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.url) throw new Error(data.error || 'Could not open billing.');
    window.location.href = data.url;
  } catch {
    // Billing isn't wired up to Stripe yet - show the pricing preview instead of a raw error.
    show('upgrade-modal');
  }
}

document.getElementById('btn-close-upgrade').addEventListener('click', () => hide('upgrade-modal'));
document.getElementById('btn-close-upgrade-2').addEventListener('click', () => hide('upgrade-modal'));
document.getElementById('upgrade-modal').addEventListener('click', (e) => {
  if (e.target.id === 'upgrade-modal') hide('upgrade-modal');
});

// Coming back from a successful Stripe Checkout redirects here with ?upgraded=1
if (new URLSearchParams(location.search).get('upgraded') === '1') {
  window.history.replaceState({}, '', location.pathname);
  window.addEventListener('DOMContentLoaded', async () => {
    const hint = document.createElement('p');
    hint.className = 'hint centered';
    hint.textContent = 'Confirming your KinRead Family plan...';
    document.querySelector('main')?.prepend(hint);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const account = await loadAccount();
      if (account?.plan === 'paid') {
        hint.textContent = 'Your KinRead Family plan is active. Thank you!';
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    hint.textContent = 'Payment received. Your plan is still updating; refresh in a moment.';
  });
}

document.getElementById('btn-logout').addEventListener('click', async () => {
  const btn = document.getElementById('btn-logout');
  btn.disabled = true;
  btn.textContent = 'Logging out...';
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    // Redirect even if the server is temporarily unreachable; the login page is the safe local state.
  } finally {
    window.location.href = '/login';
  }
});

// ---------- account deletion ----------
document.getElementById('btn-open-delete').addEventListener('click', () => show('delete-account-modal'));
document.getElementById('btn-close-delete').addEventListener('click', () => hide('delete-account-modal'));

document.getElementById('input-delete-confirm').addEventListener('input', (e) => {
  document.getElementById('btn-confirm-delete').disabled = e.target.value.trim() !== 'DELETE';
});

document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
  const btn = document.getElementById('btn-confirm-delete');
  const errorEl = document.getElementById('delete-error');
  errorEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  try {
    const res = await fetch('/api/account', { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not delete account.');
    window.location.href = '/login';
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Delete my account permanently';
  }
});

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

// ---------- search by lesson/idea (mental model discovery) ----------
document.getElementById('btn-toggle-lesson').addEventListener('click', (e) => {
  document.getElementById('form-lesson').classList.toggle('hidden');
  const nowVisible = !document.getElementById('form-lesson').classList.contains('hidden');
  e.target.textContent = nowVisible ? 'Hide idea search' : 'Looking for a lesson, not a book? Search by idea instead';
});

document.getElementById('form-lesson').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = document.getElementById('input-lesson').value.trim();
  if (!query) return;

  hide('lesson-results');
  hide('book-card');
  hide('analysis-card');
  show('lesson-loading');

  try {
    const res = await fetch('/api/discover-by-lesson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 402) {
        document.getElementById('lesson-results').innerHTML = `
          <p class="error">${escapeHtml(data.error)}</p>
          <button id="btn-upgrade-cta-lesson" class="btn btn-primary btn-block">Upgrade to KinRead Family</button>`;
        document.getElementById('btn-upgrade-cta-lesson').addEventListener('click', () => startBillingFlow('checkout'));
        show('lesson-results');
        return;
      }
      throw new Error(data.error || 'Search failed');
    }
    renderLessonResults(data.books || [], query);
    if (!data.cached) loadAccount(); // this search costs the same as an analysis, so it counts too
  } catch (err) {
    document.getElementById('lesson-results').innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    show('lesson-results');
  } finally {
    hide('lesson-loading');
  }
});

function renderLessonResults(books, query) {
  const container = document.getElementById('lesson-results');
  if (!books.length) {
    container.innerHTML = `<p class="hint">Couldn't find confident matches for "${escapeHtml(query)}". Try rephrasing, or search for a specific title instead.</p>`;
    show('lesson-results');
    return;
  }
  const bookIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>';
  container.innerHTML = `
    <p class="card-label">Stories that explore "${escapeHtml(query)}"</p>
    ${books.map((b) => {
      if (!b?.title) return '';
      return `
        <div class="comparable-title">
          <span class="comparable-icon" aria-hidden="true">${bookIcon}</span>
          <div>
            <p class="comparable-title-name">${escapeHtml(b.title)}${b.author ? ` <span class="muted">- ${escapeHtml(b.author)}</span>` : ''}</p>
            ${b.ageRange ? `<p class="muted small">Ages ${escapeHtml(b.ageRange)}</p>` : ''}
            ${b.why ? `<p class="comparable-title-why">${escapeHtml(b.why)}</p>` : ''}
            <button class="link-btn lesson-lookup-btn" data-title="${escapeHtml(b.title)}" data-author="${escapeHtml(b.author || '')}">Look up this book</button>
          </div>
        </div>`;
    }).filter(Boolean).join('')}
  `;
  container.querySelectorAll('.lesson-lookup-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = `${btn.dataset.title} ${btn.dataset.author}`.trim();
      document.getElementById('input-title-search').value = q;
      lookupBook({ q });
      document.getElementById('book-card')?.scrollIntoView({ behavior: 'smooth' });
    });
  });
  show('lesson-results');
}

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
// Rotating status lines during analysis - real research takes a while, so cycling
// through what's actually happening keeps the wait from feeling stuck or broken.
const ANALYSIS_LOADING_STAGES = [
  'Checking reviews and content sources',
  'Cross-referencing what other parents found',
  'Looking for age guidance and content warnings',
  'Weighing up themes and mental models',
  'Putting together your summary',
];
let loadingStageTimer = null;

function startLoadingStages() {
  const statusEl = document.getElementById('loading-status');
  let i = 0;
  statusEl.textContent = ANALYSIS_LOADING_STAGES[0];
  loadingStageTimer = setInterval(() => {
    i = (i + 1) % ANALYSIS_LOADING_STAGES.length;
    statusEl.textContent = ANALYSIS_LOADING_STAGES[i];
  }, 4500);
}

function stopLoadingStages() {
  clearInterval(loadingStageTimer);
}

document.getElementById('btn-analyze').addEventListener('click', async () => {
  if (!currentBook) return;
  hide('analysis-card');
  show('analysis-loading');
  startLoadingStages();

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
    if (!res.ok) {
      if (res.status === 402) {
        document.getElementById('analysis-card').innerHTML = `
          <p class="error">${escapeHtml(data.error)}</p>
          <button id="btn-upgrade-cta" class="btn btn-primary btn-block">Upgrade to KinRead Family</button>`;
        document.getElementById('btn-upgrade-cta').addEventListener('click', () => startBillingFlow('checkout'));
        show('analysis-card');
        return;
      }
      throw new Error(data.error || 'Analysis failed');
    }

    currentAnalysis = data;
    renderAnalysis(data);
    if (!data.cached) loadAccount(); // refresh the usage count shown in the header
  } catch (err) {
    document.getElementById('analysis-card').innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    show('analysis-card');
  } finally {
    stopLoadingStages();
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
      <p>Worth a closer look before you hand this one over. See the specifics below.</p>
    </div>`;
}

function renderMentalModels(models) {
  if (!Array.isArray(models) || models.length === 0) return '';
  const items = models.slice(0, 4).map((model) => {
    if (!model?.name) return '';
    return `
      <article class="mental-model">
        <h3>${escapeHtml(model.name)}</h3>
        ${model.evidence ? `<p class="mental-model-evidence">In the story: ${escapeHtml(model.evidence)}</p>` : ''}
        ${model.takeaway ? `<p>${escapeHtml(model.takeaway)}</p>` : ''}
        ${model.caveat ? `<p class="mental-model-caveat">Keep in mind: ${escapeHtml(model.caveat)}</p>` : ''}
      </article>`;
  }).filter(Boolean).join('');
  if (!items) return '';
  return `<section class="mental-models"><p class="card-label">Ways of thinking this story explores</p>${items}</section>`;
}

function renderComparableTitles(titles) {
  if (!Array.isArray(titles) || titles.length === 0) return '';
  const items = titles.slice(0, 3).map((t) => {
    if (!t?.title) return '';
    return `
      <div class="comparable-title">
        <span class="comparable-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg></span>
        <div>
          <p class="comparable-title-name">${escapeHtml(t.title)}${t.author ? ` <span class="muted">- ${escapeHtml(t.author)}</span>` : ''}</p>
          ${t.why ? `<p class="comparable-title-why">${escapeHtml(t.why)}</p>` : ''}
        </div>
      </div>`;
  }).filter(Boolean).join('');
  if (!items) return '';
  return `<section class="comparable-titles"><p class="card-label">If you know one of these, you'll know what to expect</p>${items}</section>`;
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

  // Age guidance is meant to be a short range (e.g. "8-12") - if the model ever returns a
  // full sentence, truncate rather than let a paragraph-length pill break the chip layout.
  const ageGuidance = result.age_guidance && result.age_guidance.length > 24
    ? `${result.age_guidance.slice(0, 21).trim()}…`
    : result.age_guidance;

  const chips = [
    `<span class="info-chip confidence-${escapeHtml(result.confidence || 'unknown')}">Confidence: ${escapeHtml(result.confidence || 'unknown')}</span>`,
    ageGuidance ? `<span class="info-chip" title="${escapeHtml(result.age_guidance)}">Suggested age: ${escapeHtml(ageGuidance)}</span>` : '',
  ].filter(Boolean).join('');

  card.innerHTML = `
    <p class="card-label">Content summary</p>
    <div class="info-chip-row">${chips}</div>
    ${renderKidVerdicts(cats)}
    ${renderContentAlert(cats)}
    <p class="analysis-summary">${escapeHtml(result.summary || '')}</p>
    <div class="stamp-grid">${stamps}</div>
    ${renderMentalModels(result.mental_models)}
    ${renderComparableTitles(result.comparable_titles)}
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
    btn.textContent = 'Could not save, try again';
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
      ? 'Your library is empty. Scan your first book to start building it.'
      : "No saved books match that search.";
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
          ${renderKidVerdictDots(entry.analysis?.categories || {})}
          <div class="library-item-badges">${badges || '<span class="mini-badge stamp-clear">No flags</span>'}</div>
          <div class="library-item-detail hidden">
            ${entry.analysis?.summary ? `<p class="small">${escapeHtml(entry.analysis.summary)}</p>` : ''}
            ${renderKidVerdicts(entry.analysis?.categories || {})}
            ${renderMentalModels(entry.analysis?.mental_models)}
            ${renderComparableTitles(entry.analysis?.comparable_titles)}
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
    list.innerHTML = '<p class="hint">Add a kid below to start seeing a personalised \'good to go\' verdict for every book.</p>';
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
  const hardFlagged = flagged.filter((key) => thresholds[key]?.[categories[key]?.level] >= NEVER_OK_VALUE);
  const status = flagged.length === 0 ? 'ok' : hardFlagged.length ? 'avoid' : 'review';
  return { ok: flagged.length === 0, flagged, hardFlagged, status };
}

const VERDICT_META = {
  ok: {
    label: 'Good to go',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  },
  review: {
    label: 'Worth discussing first',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
  },
  avoid: {
    label: 'Not a fit for this family',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
  },
};

// Full traffic-light verdict grid: one glanceable card per kid, all shown side by side
// so a household with several kids can see everyone's status for this book at once.
function renderKidVerdicts(categories) {
  if (!kidsCache.length) return '';
  const cards = kidsCache.map((kid) => {
    const { flagged, status } = computeVerdict(categories, kid, thresholdsCache);
    const meta = VERDICT_META[status];
    const detail = flagged.length ? flagged.map((k) => CATEGORY_LABELS[k]).join(', ') : 'No flags for this child';
    return `
      <div class="verdict-card status-${status}">
        <span class="verdict-icon">${meta.icon}</span>
        <div class="verdict-body">
          <span class="verdict-kid-name">${escapeHtml(kid.name)} <span class="verdict-kid-age">(${kid.age})</span></span>
          <span class="verdict-status-label">${escapeHtml(meta.label)}</span>
          <span class="verdict-detail">${escapeHtml(detail)}</span>
        </div>
      </div>`;
  }).join('');
  return `<div class="kid-verdicts"><p class="card-label">Family decision, at a glance</p><div class="verdict-grid">${cards}</div></div>`;
}

// Tiny coloured dots for the collapsed library card - lets a parent scan a whole
// shelf of saved books and instantly see which kids each one is (or isn't) a fit for.
function renderKidVerdictDots(categories) {
  if (!kidsCache.length) return '';
  const dots = kidsCache.map((kid) => {
    const { status } = computeVerdict(categories, kid, thresholdsCache);
    return `<span class="verdict-dot status-${status}" title="${escapeHtml(kid.name)}: ${escapeHtml(VERDICT_META[status].label)}">${escapeHtml(kid.name[0] || '?')}</span>`;
  }).join('');
  return `<div class="verdict-dot-row">${dots}</div>`;
}

// ---------- helpers ----------
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
