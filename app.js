// ─────────────────────────────────────────────
// Meta Ad Generator — app.js
// Multi-scene pipeline: per-scene (Flux + Seedance) → Canvas stitch → R2 upload → Claude copy
// ─────────────────────────────────────────────

// ── Logging ──────────────────────────────────

const _logs = [];
let _logErrorCount = 0;

function _ts() {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function log(level, ...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
  const entry = { time: _ts(), level, msg };
  _logs.push(entry);
  if (level === 'error') _logErrorCount++;

  // Console mirror
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${entry.time}] [${level.toUpperCase()}]`, ...args);

  // DOM update
  const body = document.getElementById('logBody');
  if (body) {
    const div = document.createElement('div');
    div.className = `log-entry log-${level}`;
    div.innerHTML = `<span class="log-time">${entry.time}</span>${escapeHtml(msg)}`;
    body.appendChild(div);
    div.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }
  const countEl = document.getElementById('logCount');
  if (countEl) countEl.textContent = _logs.length;
  const errEl = document.getElementById('logErrorCount');
  if (errEl) {
    errEl.textContent = _logErrorCount;
    errEl.style.display = _logErrorCount > 0 ? 'inline' : 'none';
  }
  // Auto-open on errors
  if (level === 'error') {
    const b = document.getElementById('logBody');
    if (b && !b.classList.contains('open')) b.classList.add('open');
  }
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toggleLogPanel() {
  const body = document.getElementById('logBody');
  if (body) body.classList.toggle('open');
}

function copyLogs() {
  const text = _logs.map(e => `[${e.time}] [${e.level.toUpperCase()}] ${e.msg}`).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector('#logPanel .log-actions .btn-sm');
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); }
  });
}

function clearLogs() {
  _logs.length = 0;
  _logErrorCount = 0;
  const body = document.getElementById('logBody');
  if (body) body.innerHTML = '';
  const countEl = document.getElementById('logCount');
  if (countEl) countEl.textContent = '0';
  const errEl = document.getElementById('logErrorCount');
  if (errEl) { errEl.textContent = '0'; errEl.style.display = 'none'; }
}

function maskKey(key) {
  if (!key || key.length < 10) return '***';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

// ── ESM import helper (Safari cross-origin workaround) ──

async function importEsm(url) {
  try {
    return await import(url);
  } catch {
    // Safari blocks cross-origin dynamic import — fetch source and import via blob URL
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch module: ${url} (${res.status})`);
    const src = await res.text();
    const blob = new Blob([src], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await import(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
}

// ── State ────────────────────────────────────

let scenes = [];
let productImages = []; // Array of { file: File, previewUrl: string, falUrl: string|null }
const MIN_SCENES = 3;
const MAX_SCENES = 4;
const CROSSFADE_DURATION = 0.5; // seconds

// ── Overlay style presets ──────────────────────
const OVERLAY_STYLES = {
  clean:     { weight: 600, color: '#ffffff',              bg: 'pill',     bgColor: 'rgba(0,0,0,0.5)',  shadow: 'subtle',  spacing: '0px',     transform: 'none' },
  bold:      { weight: 800, color: '#ffffff',              bg: 'none',     bgColor: null,               shadow: 'outline', spacing: '0.02em',  transform: 'uppercase' },
  cinematic: { weight: 600, color: '#ffffff',              bg: 'gradient', bgColor: null,               shadow: 'none',    spacing: '0.12em',  transform: 'uppercase' },
  minimal:   { weight: 400, color: 'rgba(255,255,255,0.9)', bg: 'none',   bgColor: null,               shadow: 'subtle',  spacing: '0.04em',  transform: 'none' },
  highlight: { weight: 700, color: '#ffffff',              bg: 'pill',     bgColor: '#4f7df9',          shadow: 'none',    spacing: '0px',     transform: 'none' },
  subtitle:  { weight: 500, color: '#ffffff',              bg: 'bar',      bgColor: 'rgba(0,0,0,0.65)', shadow: 'none',    spacing: '0px',     transform: 'none' },
};

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// ── Two-step brief prompts ───────────────────

const ANALYSIS_SYSTEM_PROMPT = `You are a senior brand strategist specializing in Meta/Facebook advertising. Analyse business information and create a brand profile and ad strategy.

CRITICAL: Base your analysis ONLY on information provided. Do NOT invent products, services, or brand attributes that aren't explicitly described. If limited information is given, keep your analysis focused on what you know.`;

const SCENE_BRIEF_SYSTEM_PROMPT = `You are a Creative Director specializing in Meta/Facebook video ads. You receive a brand analysis and must create scene-by-scene briefs.

CRITICAL RULE: Every scene description MUST be about the SPECIFIC business, their ACTUAL products/services, and their REAL customers. Use the brand profile provided — do NOT invent anything beyond it.

Facebook algorithm priorities:
- **3-second rule**: Scene 1 must stop the scroll with a striking visual OF THE ACTUAL PRODUCT/SERVICE.
- **Sound-off**: 85%+ watched muted. Overlay text tells the story.
- **Hook-first**: Lead with the most compelling product visual or customer benefit.
- **Emotional arc**: Scene 1 = attention (show the product), Scene 2 = desire (show the benefit), Scene 3 = proof (show results/social proof), Scene 4 (if present) = CTA/urgency.`;

// ── Format-aware defaults ─────────────────────

const FORMAT_DEFAULTS = {
  '9:16': { pos: 'bottom', style: 'bold',      size: 'large',  duration: '5',  anim: 'slide-up' },
  '16:9': { pos: 'centre', style: 'clean',     size: 'medium', duration: '5',  anim: 'fade' },
  '1:1':  { pos: 'centre', style: 'clean',     size: 'medium', duration: '5',  anim: 'fade' },
  '21:9': { pos: 'bottom', style: 'cinematic', size: 'medium', duration: '8',  anim: 'fade' },
  '4:3':  { pos: 'centre', style: 'clean',     size: 'medium', duration: '5',  anim: 'fade' },
  '3:4':  { pos: 'bottom', style: 'bold',      size: 'large',  duration: '5',  anim: 'slide-up' },
};
const HOOK_SCENE_OVERRIDE = { style: 'bold', size: 'large' };

// ── Hook templates library ────────────────────

const HOOK_TEMPLATES = {
  question: {
    label: 'Question Hooks',
    templates: [
      'Did you know {fact}?',
      'What if you could {benefit}?',
      'Still doing {old way}?',
      'Want to {desire}?',
      'Tired of {pain point}?',
    ]
  },
  number: {
    label: 'Number Hooks',
    templates: [
      '3 reasons why {topic}',
      'The #1 mistake in {area}',
      '97% of people get this wrong',
      '{number}x faster results',
      'In just {timeframe}...',
    ]
  },
  challenge: {
    label: 'Challenge Hooks',
    templates: [
      'Stop doing {bad habit}',
      'You\'re wrong about {topic}',
      'Nobody talks about this',
      'This changes everything',
      'Watch before you {action}',
    ]
  },
  benefit: {
    label: 'Benefit Hooks',
    templates: [
      'How to {result} in {time}',
      'The secret to {benefit}',
      'Finally, a way to {desire}',
      'From {before} to {after}',
      '{Result} without {sacrifice}',
    ]
  },
};

// ── Error handler ────────────────────────────

window.onerror = function(msg, src, line, col, err) {
  log('error', `Uncaught: ${msg} at line ${line}:${col}${err?.stack ? '\n' + err.stack : ''}`);
};

window.onunhandledrejection = function(e) {
  log('error', `Unhandled promise rejection: ${e.reason?.message || e.reason}${e.reason?.stack ? '\n' + e.reason.stack : ''}`);
};

// ── Init ─────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  log('info', 'Meta Ad Generator initialised');
  try {
    const saved = localStorage.getItem('meta-ad-worker-url');
    if (saved) {
      document.getElementById('workerUrl').value = saved;
      log('debug', `Restored Worker URL: ${saved}`);
    }
  } catch(e) { log('warn', 'localStorage unavailable — private mode?'); }

  for (let i = 0; i < MIN_SCENES; i++) addScene();

  document.getElementById('adFormat').addEventListener('change', function() {
    log('info', `Format changed → ${this.value}`);
    applyFormatDefaults(this.value);
  });

  document.getElementById('productImageInput').addEventListener('change', handleProductImageUpload);

  log('info', `Browser: ${navigator.userAgent.split(') ').pop()}`);
  log('info', `MediaRecorder VP9: ${MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'yes' : 'no'}`);
});

// ── Scene management ─────────────────────────

function addScene() {
  if (scenes.length >= MAX_SCENES) return;
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  scenes.push({ id });
  renderScenes();
  applyFormatDefaults(document.getElementById('adFormat').value);
}

function removeScene(id) {
  if (scenes.length <= MIN_SCENES) return;
  scenes = scenes.filter(s => s.id !== id);
  renderScenes();
}

function renderScenes() {
  const container = document.getElementById('scenesContainer');
  container.innerHTML = scenes.map((scene, i) => `
    <div class="scene-card" data-scene-id="${scene.id}">
      <div class="scene-header">
        <span class="scene-number">Scene ${i + 1}</span>
        <div class="scene-actions">
          ${i > 0 ? `<button class="btn-sm btn-outline" onclick="moveScene('${scene.id}',-1)">&#9650;</button>` : ''}
          ${i < scenes.length - 1 ? `<button class="btn-sm btn-outline" onclick="moveScene('${scene.id}',1)">&#9660;</button>` : ''}
          ${scenes.length > MIN_SCENES ? `<button class="btn-sm btn-danger" onclick="removeScene('${scene.id}')">Remove</button>` : ''}
        </div>
      </div>

      <div class="radio-group">
        <label>
          <input type="radio" name="imgSrc-${scene.id}" value="ai" checked onchange="toggleSceneSource('${scene.id}')"> Generate with AI
        </label>
        <label>
          <input type="radio" name="imgSrc-${scene.id}" value="upload" onchange="toggleSceneSource('${scene.id}')"> Upload image
        </label>
        ${productImages.length > 0 ? `<label>
          <input type="radio" name="imgSrc-${scene.id}" value="product" onchange="toggleSceneSource('${scene.id}')"> Use product image
        </label>` : ''}
      </div>

      <div id="aiFields-${scene.id}">
        <div class="field">
          <label>Scene Description</label>
          <textarea id="desc-${scene.id}" placeholder="Describe what this scene should show, e.g. 'A person using the product outdoors, bright natural lighting'"></textarea>
        </div>
      </div>

      <div id="uploadField-${scene.id}" style="display:none">
        <div class="field">
          <label>Upload Image</label>
          <input type="file" id="file-${scene.id}" accept="image/jpeg,image/png,image/webp" style="padding:0.5rem 0.9rem;cursor:pointer" />
        </div>
      </div>

      <div id="productField-${scene.id}" style="display:none">
        <div class="field">
          <label>Select Product Image</label>
          <select id="productSelect-${scene.id}">
            ${productImages.map((p, j) => `<option value="${j}">Product ${j + 1}</option>`).join('')}
          </select>
        </div>
        <div class="tip">This image will be used exactly as-is. Motion will be minimal to preserve product accuracy.</div>
      </div>

      <div class="field">
        <label>Motion Prompt</label>
        <input type="text" id="motion-${scene.id}" placeholder="e.g. slow zoom in, gentle camera pan right, particles floating" />
      </div>

      <div class="grid-2">
        <div class="field">
          <label>Overlay Text${i === 0 ? ' <span style="color:var(--orange);font-weight:400;text-transform:none;letter-spacing:0">(Hook Scene)</span>' : ''}</label>
          <div style="display:flex;gap:6px;align-items:start">
            <input type="text" id="overlay-${scene.id}" placeholder="${i === 0 ? 'Your scroll-stopping hook...' : 'Text shown during this scene'}" oninput="markOverlayDirty('${scene.id}')" style="flex:1" />
            ${i === 0 ? `<button class="btn-sm btn-outline" onclick="toggleHookPicker('${scene.id}')" style="white-space:nowrap;flex-shrink:0" title="Hook Templates">Hooks</button>` : ''}
          </div>
          ${i === 0 ? `<div id="hookPicker-${scene.id}" class="hook-picker" style="display:none"></div>` : ''}
        </div>
        <div class="field">
          <label>Overlay Position</label>
          <select id="overlayPos-${scene.id}">
            <option value="top">Top</option>
            <option value="centre" selected>Centre</option>
            <option value="bottom">Bottom</option>
          </select>
        </div>
      </div>

      <div class="grid-3">
        <div class="field">
          <label>Overlay Style</label>
          <select id="overlayStyle-${scene.id}">
            <option value="clean" selected>Clean</option>
            <option value="bold">Bold</option>
            <option value="cinematic">Cinematic</option>
            <option value="minimal">Minimal</option>
            <option value="highlight">Highlight</option>
            <option value="subtitle">Subtitle</option>
          </select>
        </div>
        <div class="field">
          <label>Font Size</label>
          <select id="overlaySize-${scene.id}">
            <option value="small">Small</option>
            <option value="medium" selected>Medium</option>
            <option value="large">Large</option>
          </select>
        </div>
        <div class="field">
          <label>Text Animation</label>
          <select id="overlayAnim-${scene.id}">
            <option value="fade" selected>Fade</option>
            <option value="slide-up">Slide Up</option>
            <option value="typewriter">Typewriter</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Scene Duration</label>
        <select id="duration-${scene.id}">
          <option value="5" selected>5 seconds</option>
          <option value="8">8 seconds</option>
          <option value="10">10 seconds</option>
        </select>
      </div>
    </div>
  `).join('');

  document.getElementById('addSceneBtn').disabled = scenes.length >= MAX_SCENES;
}

function moveScene(id, direction) {
  const idx = scenes.findIndex(s => s.id === id);
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= scenes.length) return;

  // Save current values before re-render
  const values = collectAllSceneValues();
  [scenes[idx], scenes[newIdx]] = [scenes[newIdx], scenes[idx]];
  // Swap the saved values too
  [values[idx], values[newIdx]] = [values[newIdx], values[idx]];
  renderScenes();
  restoreAllSceneValues(values);
}

function toggleSceneSource(id) {
  const mode = document.querySelector(`input[name="imgSrc-${id}"]:checked`)?.value || 'ai';
  document.getElementById(`aiFields-${id}`).style.display = mode === 'ai' ? 'block' : 'none';
  document.getElementById(`uploadField-${id}`).style.display = mode === 'upload' ? 'block' : 'none';
  const productField = document.getElementById(`productField-${id}`);
  if (productField) productField.style.display = mode === 'product' ? 'block' : 'none';
}

function collectAllSceneValues() {
  return scenes.map(scene => {
    const id = scene.id;
    const mode = document.querySelector(`input[name="imgSrc-${id}"]:checked`)?.value || 'ai';
    return {
      isUpload: mode === 'upload',
      isProduct: mode === 'product',
      productIndex: mode === 'product' ? parseInt(document.getElementById(`productSelect-${id}`)?.value || '0') : null,
      description: document.getElementById(`desc-${id}`)?.value || '',
      motion: document.getElementById(`motion-${id}`)?.value || '',
      overlay: document.getElementById(`overlay-${id}`)?.value || '',
      overlayPos: document.getElementById(`overlayPos-${id}`)?.value || 'centre',
      overlayStyle: document.getElementById(`overlayStyle-${id}`)?.value || 'clean',
      overlaySize: document.getElementById(`overlaySize-${id}`)?.value || 'medium',
      overlayAnim: document.getElementById(`overlayAnim-${id}`)?.value || 'fade',
      duration: document.getElementById(`duration-${id}`)?.value || '5',
    };
  });
}

function restoreAllSceneValues(values) {
  scenes.forEach((scene, i) => {
    if (!values[i]) return;
    const id = scene.id;
    const v = values[i];
    if (document.getElementById(`desc-${id}`)) document.getElementById(`desc-${id}`).value = v.description;
    if (document.getElementById(`motion-${id}`)) document.getElementById(`motion-${id}`).value = v.motion;
    if (document.getElementById(`overlay-${id}`)) document.getElementById(`overlay-${id}`).value = v.overlay;
    if (document.getElementById(`overlayPos-${id}`)) document.getElementById(`overlayPos-${id}`).value = v.overlayPos;
    if (document.getElementById(`overlayStyle-${id}`)) document.getElementById(`overlayStyle-${id}`).value = v.overlayStyle || 'clean';
    if (document.getElementById(`overlaySize-${id}`)) document.getElementById(`overlaySize-${id}`).value = v.overlaySize || 'medium';
    if (document.getElementById(`overlayAnim-${id}`)) document.getElementById(`overlayAnim-${id}`).value = v.overlayAnim || 'fade';
    if (document.getElementById(`duration-${id}`)) document.getElementById(`duration-${id}`).value = v.duration;
    if (v.isProduct) {
      const radio = document.querySelector(`input[name="imgSrc-${id}"][value="product"]`);
      if (radio) { radio.checked = true; toggleSceneSource(id); }
      const sel = document.getElementById(`productSelect-${id}`);
      if (sel && v.productIndex != null) sel.value = v.productIndex;
    } else if (v.isUpload) {
      const radio = document.querySelector(`input[name="imgSrc-${id}"][value="upload"]`);
      if (radio) { radio.checked = true; toggleSceneSource(id); }
    }
  });
}

// ── Product Images ───────────────────────────

function handleProductImageUpload(e) {
  const files = Array.from(e.target.files || []);
  const remaining = 4 - productImages.length;
  const toAdd = files.slice(0, remaining);
  toAdd.forEach(file => {
    productImages.push({ file, previewUrl: URL.createObjectURL(file), falUrl: null });
  });
  renderProductImages();
  renderScenes(); // re-render to show/hide product radio option
  e.target.value = ''; // reset input
}

function renderProductImages() {
  const list = document.getElementById('productImagesList');
  if (productImages.length === 0) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = productImages.map((p, i) => `
    <div class="product-thumb-wrap">
      <img src="${p.previewUrl}" class="product-thumb" alt="Product ${i + 1}" />
      <button class="product-thumb-remove" onclick="removeProductImage(${i})" title="Remove">&times;</button>
    </div>
  `).join('') + `<span style="font-size:11px;color:var(--text-muted);align-self:center">${productImages.length} of 4</span>`;
}

function removeProductImage(index) {
  const removed = productImages.splice(index, 1);
  if (removed[0]?.previewUrl) URL.revokeObjectURL(removed[0].previewUrl);
  renderProductImages();
  renderScenes(); // re-render to update product radio visibility
}

// ── Creative Director: Generate Brief ─────────

async function generateBrief() {
  const anthropicKey = document.getElementById('anthropicKey').value.trim();
  const businessName = document.getElementById('businessName').value.trim();
  if (!anthropicKey) { alert('Please enter your Anthropic API key to generate a brief'); return; }
  if (!businessName) { alert('Please enter a business/product name to generate a brief'); return; }

  const targetAudience = document.getElementById('targetAudience').value.trim();
  const adObjective = document.getElementById('adObjective').value;
  const adFormat = document.getElementById('adFormat').value;
  const offer = document.getElementById('offerHook').value.trim();
  const whatYouSell = document.getElementById('whatYouSell').value.trim();
  const brandTone = document.getElementById('brandTone').value.trim();
  const brandColors = document.getElementById('brandColors').value.trim();
  const sellingPoints = document.getElementById('sellingPoints').value.trim();
  const sceneCount = scenes.length;

  const formatContext = {
    '16:9': 'Facebook/Instagram Feed (landscape, polished, editorial feel)',
    '9:16': 'Instagram Stories/Reels (vertical, fast-paced, native energy, mobile-first)',
    '1:1':  'Facebook/Instagram Feed (square, versatile, works in both feeds)',
    '4:3':  'Facebook Feed (classic landscape, slightly taller than 16:9)',
    '3:4':  'Instagram Feed (portrait, more vertical space for text)',
    '21:9': 'Facebook Feed (ultra-wide cinematic, immersive, minimal text space)',
  };

  const brandUrl = document.getElementById('brandUrl').value.trim();
  const workerUrl = document.getElementById('workerUrl').value.trim();

  const btn = document.getElementById('generateBriefBtn');
  const statusEl = document.getElementById('briefStatus');
  btn.disabled = true;
  btn.textContent = 'Generating Brief...';
  statusEl.style.display = 'inline';
  statusEl.style.color = 'var(--text-muted)';

  // Fetch brand website context if URL provided
  let brandContext = '';
  if (brandUrl && workerUrl) {
    try {
      statusEl.textContent = 'Reading brand website...';
      log('info', `Fetching brand website via proxy: ${brandUrl}`);
      const proxyRes = await fetch(`${workerUrl.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(brandUrl)}`);
      if (proxyRes.ok) {
        const proxyData = await proxyRes.json();
        if (proxyData.text && !proxyData.error) {
          brandContext = proxyData.text;
          pipeline.brandContext = brandContext;
          log('success', `Brand website scraped: "${proxyData.title}" (${proxyData.text.length} chars)`);
        } else {
          log('warn', `Brand proxy returned empty/error: ${proxyData.error || 'no text'}`);
        }
      } else {
        log('warn', `Brand proxy HTTP ${proxyRes.status}`);
      }
    } catch (e) {
      log('warn', `Brand website fetch failed (non-blocking): ${e.message}`);
    }
  }

  // ── Step 1: Brand Analysis ──────────────────
  statusEl.textContent = 'Analysing brand...';

  // Build conditional prompt sections
  const analysisLines = [`Analyse this business for a Meta ad campaign:\n\nBusiness: ${businessName}`];
  if (whatYouSell)     analysisLines.push(`Products/Services: ${whatYouSell}`);
  if (targetAudience)  analysisLines.push(`Target Audience: ${targetAudience}`);
  if (adObjective)     analysisLines.push(`Campaign Objective: ${adObjective}`);
  if (offer)           analysisLines.push(`Current Offer: ${offer}`);
  if (brandTone)       analysisLines.push(`Brand Tone: ${brandTone}`);
  if (brandColors)     analysisLines.push(`Brand Colors: ${brandColors}`);
  if (sellingPoints)   analysisLines.push(`Key Selling Points:\n${sellingPoints}`);
  if (brandContext)    analysisLines.push(`Website Content:\n${brandContext}`);

  analysisLines.push(`\nReturn ONLY valid JSON — no markdown, no preamble:
{
  "businessSummary": "What this business does in 1-2 sentences",
  "products": ["list of specific products/services to feature"],
  "audience": "Refined target audience description",
  "tone": "Brand voice description (adjectives)",
  "visualStyle": "How scenes should look (colors, mood, lighting, setting)",
  "differentiators": ["What makes them unique"],
  "adStrategy": "Recommended approach for ${adObjective} objective in 2-3 sentences",
  "hookAngle": "The single most compelling angle for Scene 1"
}`);

  const analysisPrompt = analysisLines.join('\n');

  try {
    // Step 1 call
    log('info', `Claude brand analysis → model=claude-sonnet-4-20250514, key=${maskKey(anthropicKey)}`);
    const t0 = performance.now();
    const res1 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: ANALYSIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: analysisPrompt }],
      }),
    });

    const dur1 = ((performance.now() - t0) / 1000).toFixed(1);
    if (!res1.ok) {
      const errBody = await res1.text();
      log('error', `Claude brand analysis ← HTTP ${res1.status} after ${dur1}s: ${errBody}`);
      throw new Error('Claude API error ' + res1.status);
    }
    const data1 = await res1.json();
    log('success', `Claude brand analysis ← ${dur1}s, usage: ${JSON.stringify(data1.usage || {})}`);
    const text1 = data1.content[0].text.replace(/```json|```/g, '').trim();
    log('debug', `Brand analysis raw:\n${text1.slice(0, 600)}${text1.length > 600 ? '...' : ''}`);

    let brandProfile;
    try {
      brandProfile = JSON.parse(text1);
    } catch (parseErr) {
      log('error', `Brand analysis JSON parse failed: ${parseErr.message}\nRaw: ${text1}`);
      throw parseErr;
    }

    // Store brand analysis for use in copy generation
    pipeline.brandAnalysis = brandProfile;
    log('success', `Brand analysis: "${brandProfile.businessSummary?.slice(0, 80)}..."`);

    // ── Step 2: Scene Brief ──────────────────
    statusEl.textContent = 'Planning scenes...';

    // Product image awareness
    let productContext = '';
    if (productImages.length > 0) {
      productContext = `\nYou have ${productImages.length} product image(s) available. You can assign product images to scenes by adding "useProduct": true and "productIndex": <0-based index> to scene objects.\nProduct scenes should have motion prompts that are very subtle (the product must not be altered). Do NOT include a "description" for product scenes — the real product photo is used instead.\n`;
    }

    const sceneBriefPrompt = `Generate a ${sceneCount}-scene video ad brief using this brand profile:

=== BRAND PROFILE ===
${JSON.stringify(brandProfile, null, 2)}

=== FORMAT ===
${adFormat} — ${formatContext[adFormat] || 'Standard'}
${productContext}
Return ONLY a valid JSON array with exactly ${sceneCount} objects. Each object must have:
{
  "description": "Photorealistic image prompt showing THIS business's actual product/service. Be specific: what product, what setting, what customer. No text in the image. Use the visual style from the brand profile.",
  "motion": "Camera/motion prompt for video animation (e.g. 'slow zoom in with gentle parallax', 'smooth pan right revealing product')",
  "overlay": "Overlay text for this scene (concise, impactful, about THIS business)",
  "overlayPos": "top" | "centre" | "bottom",
  "overlayStyle": "clean" | "bold" | "cinematic" | "minimal" | "highlight" | "subtitle",
  "overlaySize": "small" | "medium" | "large",
  "overlayAnim": "fade" | "slide-up" | "typewriter",
  "duration": "5" | "8" | "10"
}

Rules:
- Use the hook angle from the brand profile for Scene 1
- Scene 1 is the HOOK scene: bold/highlight style, large size, show the hero product
- Use the brand's visual style (colors, mood, lighting) in every scene description
- Feature specific products from the brand profile, not generic imagery
- Overlay text: works with sound off, max 6 words, tells THIS brand's story
- Motion prompts: subtle and cinematic, not jarring
- Duration: prefer 5s for ${adFormat === '9:16' ? 'Stories/Reels' : 'most formats'}, 8s only for establishing shots`;

    log('info', `Claude scene brief → model=claude-sonnet-4-20250514, scenes=${sceneCount}`);
    const t1 = performance.now();
    const res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system: SCENE_BRIEF_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: sceneBriefPrompt }],
      }),
    });

    const dur2 = ((performance.now() - t1) / 1000).toFixed(1);
    if (!res2.ok) {
      const errBody = await res2.text();
      log('error', `Claude scene brief ← HTTP ${res2.status} after ${dur2}s: ${errBody}`);
      throw new Error('Claude API error ' + res2.status);
    }
    const data2 = await res2.json();
    log('success', `Claude scene brief ← ${dur2}s, usage: ${JSON.stringify(data2.usage || {})}`);
    const text2 = data2.content[0].text.replace(/```json|```/g, '').trim();
    log('debug', `Scene brief raw:\n${text2.slice(0, 500)}${text2.length > 500 ? '...' : ''}`);

    let brief;
    try {
      brief = JSON.parse(text2);
    } catch (parseErr) {
      log('error', `Scene brief JSON parse failed: ${parseErr.message}\nRaw: ${text2}`);
      throw parseErr;
    }

    if (!Array.isArray(brief) || brief.length !== sceneCount) {
      log('error', `Brief shape mismatch: expected array[${sceneCount}], got ${typeof brief}${Array.isArray(brief) ? '[' + brief.length + ']' : ''}`);
      throw new Error(`Expected ${sceneCount} scenes, got ${Array.isArray(brief) ? brief.length : 'non-array'}`);
    }

    applyBrief(brief);
    const totalDur = ((performance.now() - t0) / 1000).toFixed(1);
    log('success', `Brief applied (${totalDur}s total): ${brief.map((s, i) => `S${i + 1}: "${(s.overlay || '').slice(0, 30)}"`).join(', ')}`);
    statusEl.textContent = 'Brief applied! Review and edit before generating.';
    statusEl.style.color = 'var(--green)';
    setTimeout(() => { statusEl.style.display = 'none'; statusEl.style.color = 'var(--text-muted)'; }, 4000);

  } catch (e) {
    log('error', `generateBrief failed: ${e.message}`);
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.style.color = 'var(--error)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Ad Brief';
  }
}

function applyBrief(brief) {
  scenes.forEach((scene, i) => {
    if (!brief[i]) return;
    const id = scene.id;
    const b = brief[i];

    // Handle product scenes from brief
    if (b.useProduct && productImages.length > 0) {
      const productRadio = document.querySelector(`input[name="imgSrc-${id}"][value="product"]`);
      if (productRadio) {
        productRadio.checked = true;
        toggleSceneSource(id);
        const sel = document.getElementById(`productSelect-${id}`);
        if (sel) sel.value = Math.min(b.productIndex || 0, productImages.length - 1);
      }
    } else {
      // Ensure "Generate with AI" is selected
      const aiRadio = document.querySelector(`input[name="imgSrc-${id}"][value="ai"]`);
      if (aiRadio) { aiRadio.checked = true; toggleSceneSource(id); }
    }

    if (document.getElementById(`desc-${id}`))         document.getElementById(`desc-${id}`).value = b.description || '';
    if (document.getElementById(`motion-${id}`))       document.getElementById(`motion-${id}`).value = b.useProduct ? 'static product shot, very subtle lighting shift, no morphing or deformation' : (b.motion || '');
    if (document.getElementById(`overlay-${id}`))      document.getElementById(`overlay-${id}`).value = b.overlay || '';
    if (document.getElementById(`overlayPos-${id}`))   document.getElementById(`overlayPos-${id}`).value = b.overlayPos || 'centre';
    if (document.getElementById(`overlayStyle-${id}`)) document.getElementById(`overlayStyle-${id}`).value = b.overlayStyle || 'clean';
    if (document.getElementById(`overlaySize-${id}`))  document.getElementById(`overlaySize-${id}`).value = b.overlaySize || 'medium';
    if (document.getElementById(`overlayAnim-${id}`))  document.getElementById(`overlayAnim-${id}`).value = b.overlayAnim || 'fade';
    if (document.getElementById(`duration-${id}`))     document.getElementById(`duration-${id}`).value = b.duration || '5';

    scene._overlayDirty = true;
  });
}

// ── Format-aware smart defaults ───────────────

function applyFormatDefaults(format) {
  const defaults = FORMAT_DEFAULTS[format];
  if (!defaults) return;

  scenes.forEach((scene, i) => {
    const id = scene.id;
    const overlayField = document.getElementById(`overlay-${id}`);

    // Skip if user/brief has already set overlay content
    if (overlayField && overlayField.value.trim() !== '' && scene._overlayDirty) return;

    if (document.getElementById(`overlayPos-${id}`))   document.getElementById(`overlayPos-${id}`).value = defaults.pos;
    if (document.getElementById(`overlayStyle-${id}`))  document.getElementById(`overlayStyle-${id}`).value = defaults.style;
    if (document.getElementById(`overlaySize-${id}`))   document.getElementById(`overlaySize-${id}`).value = defaults.size;
    if (document.getElementById(`overlayAnim-${id}`))   document.getElementById(`overlayAnim-${id}`).value = defaults.anim;
    if (document.getElementById(`duration-${id}`))      document.getElementById(`duration-${id}`).value = defaults.duration;

    // Scene 1 always gets hook treatment
    if (i === 0) {
      if (document.getElementById(`overlayStyle-${id}`)) document.getElementById(`overlayStyle-${id}`).value = HOOK_SCENE_OVERRIDE.style;
      if (document.getElementById(`overlaySize-${id}`))  document.getElementById(`overlaySize-${id}`).value = HOOK_SCENE_OVERRIDE.size;
    }
  });
}

function markOverlayDirty(sceneId) {
  const scene = scenes.find(s => s.id === sceneId);
  if (scene) scene._overlayDirty = true;
}

// ── Hook templates picker ─────────────────────

function toggleHookPicker(sceneId) {
  const picker = document.getElementById(`hookPicker-${sceneId}`);
  if (!picker) return;

  if (picker.style.display === 'none') {
    // Lazy-render templates on first open
    if (!picker.innerHTML) {
      let html = '';
      for (const [catKey, cat] of Object.entries(HOOK_TEMPLATES)) {
        html += `<div class="hook-category">${cat.label}</div>`;
        cat.templates.forEach(t => {
          const escaped = t.replace(/'/g, "\\'");
          html += `<div class="hook-option" onclick="selectHook('${sceneId}','${escaped}')">${t}</div>`;
        });
      }
      picker.innerHTML = html;
    }
    picker.style.display = 'block';
  } else {
    picker.style.display = 'none';
  }
}

function selectHook(sceneId, template) {
  const field = document.getElementById(`overlay-${sceneId}`);
  if (field) {
    field.value = template;
    field.focus();
    // Auto-select first {placeholder} for immediate editing
    const match = template.match(/\{[^}]+\}/);
    if (match) {
      const start = template.indexOf(match[0]);
      field.setSelectionRange(start, start + match[0].length);
    }
    markOverlayDirty(sceneId);
  }
  const picker = document.getElementById(`hookPicker-${sceneId}`);
  if (picker) picker.style.display = 'none';
}

// ── Helpers ───────────────────────────────────

function getFormatDims(fmt) {
  // image_size = Flux Schnell preset, aspect_ratio = Seedance Lite param
  // w/h = canvas dimensions for stitching
  const formats = {
    '16:9': { image_size: 'landscape_16_9',  aspect_ratio: '16:9', w: 1280, h: 720  },
    '9:16': { image_size: 'portrait_16_9',   aspect_ratio: '9:16', w: 720,  h: 1280 },
    '1:1':  { image_size: 'square_hd',       aspect_ratio: '1:1',  w: 1080, h: 1080 },
    '4:3':  { image_size: 'landscape_4_3',   aspect_ratio: '4:3',  w: 1024, h: 768  },
    '3:4':  { image_size: 'portrait_4_3',    aspect_ratio: '3:4',  w: 768,  h: 1024 },
    '21:9': { image_size: { width: 1344, height: 576 }, aspect_ratio: '21:9', w: 1344, h: 576 },
  };
  return formats[fmt] || formats['16:9'];
}

function setStage(id, status, msg, progress) {
  const labels = { wait: 'Waiting', running: 'Running', done: 'Done', error: 'Error' };
  const badge = document.getElementById('badge' + id);
  const msgEl = document.getElementById('msg' + id);
  const prog = document.getElementById('prog' + id);
  if (badge) { badge.className = 'badge badge-' + status; badge.textContent = labels[status]; }
  if (msgEl) msgEl.textContent = msg;
  if (prog) prog.style.width = progress + '%';
}

// ── fal.ai REST client (no external dependency) ──

// Route fal.ai requests through worker proxy to avoid CORS restrictions
function falFetch(url, options) {
  const workerUrl = (document.getElementById('workerUrl').value || '').trim().replace(/\/$/, '');
  if (workerUrl) {
    const proxyUrl = workerUrl + '/fal-proxy';
    return fetch(proxyUrl, {
      ...options,
      headers: { ...options.headers, 'x-fal-target-url': url }
    });
  }
  return fetch(url, options);
}

async function falRun(endpoint, input, apiKey, onProgress) {
  const inputSummary = { ...input };
  if (inputSummary.image_url) inputSummary.image_url = inputSummary.image_url.slice(0, 60) + '...';
  log('info', `fal.ai → ${endpoint}`, inputSummary);
  const t0 = performance.now();
  let attempt = 0;

  const headers = {
    'Authorization': `Key ${apiKey}`,
    'Content-Type': 'application/json'
  };

  try {
    // Submit to queue
    const submitRes = await falFetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input)
    });
    if (!submitRes.ok) {
      const err = await submitRes.json().catch(() => ({}));
      throw new Error(err.detail || `Submit failed: ${submitRes.status}`);
    }
    const { request_id } = await submitRes.json();
    log('debug', `fal.ai queued: ${request_id}`);

    // Poll for completion
    while (true) {
      await new Promise(r => setTimeout(r, 3000));
      attempt++;
      const statusRes = await falFetch(
        `https://queue.fal.run/${endpoint}/requests/${request_id}/status`,
        { headers }
      );
      if (!statusRes.ok) throw new Error(`Status poll failed: ${statusRes.status}`);
      const status = await statusRes.json();
      log('debug', `fal.ai poll #${attempt} for ${endpoint}: ${status.status}`);
      if (onProgress) onProgress(Math.min(15 + attempt * 3, 88));

      if (status.status === 'COMPLETED') break;
      if (status.status === 'FAILED') {
        throw new Error(status.error || 'fal.ai job failed');
      }
    }

    // Fetch result
    const resultRes = await falFetch(
      `https://queue.fal.run/${endpoint}/requests/${request_id}`,
      { headers }
    );
    if (!resultRes.ok) throw new Error(`Result fetch failed: ${resultRes.status}`);
    const result = await resultRes.json();

    const dur = ((performance.now() - t0) / 1000).toFixed(1);
    log('success', `fal.ai ← ${endpoint} done in ${dur}s`);
    return result;
  } catch (e) {
    const dur = ((performance.now() - t0) / 1000).toFixed(1);
    log('error', `fal.ai ← ${endpoint} FAILED after ${dur}s: ${e.message}`);
    throw e;
  }
}

// Resize and crop uploaded image to target dimensions before uploading.
// Ensures Seedance gets a sharp, correctly-proportioned input image.
function prepareImage(file, targetW, targetH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');

      // Cover crop: scale image to fill target, then center-crop
      const srcRatio = img.width / img.height;
      const tgtRatio = targetW / targetH;
      let sx, sy, sw, sh;
      if (srcRatio > tgtRatio) {
        // Source is wider — crop sides
        sh = img.height;
        sw = img.height * tgtRatio;
        sx = (img.width - sw) / 2;
        sy = 0;
      } else {
        // Source is taller — crop top/bottom
        sw = img.width;
        sh = img.width / tgtRatio;
        sx = 0;
        sy = (img.height - sh) / 2;
      }

      // Use high-quality smoothing for upscaling
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);

      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('Failed to export resized image'));
        // Preserve original filename with .png extension
        const name = file.name.replace(/\.[^.]+$/, '') + '-resized.png';
        resolve(new File([blob], name, { type: 'image/png' }));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('Failed to load uploaded image'));
    img.src = URL.createObjectURL(file);
  });
}

async function uploadImageToFal(file, apiKey, dims) {
  const prepared = dims ? await prepareImage(file, dims.w, dims.h) : file;
  log('info', `fal.ai storage upload: ${prepared.name} (${(prepared.size / 1024).toFixed(0)}KB)`);
  const fal = await getFalClient(apiKey);
  try {
    const url = await fal.storage.upload(prepared);
    log('success', `fal.ai storage ← ${url.slice(0, 60)}...`);
    return url;
  } catch (e) {
    log('error', `fal.ai storage upload failed: ${e.message}`);
    throw e;
  }
}

// ── Canvas text overlay ──────────────────────

function drawTextOverlay(ctx, text, alpha, cW, cH, position, styleName, sizeName, animation, progress) {
  if (alpha <= 0 || !text) return;
  alpha = Math.max(0, Math.min(1, alpha));
  if (typeof progress !== 'number') progress = 1;

  const style = OVERLAY_STYLES[styleName] || OVERLAY_STYLES.clean;

  // Font size
  const sizeMap = { small: 0.032, medium: 0.048, large: 0.068 };
  const fontSize = Math.round(cW * (sizeMap[sizeName] || sizeMap.medium));

  // Apply text transform
  let displayText = text;
  if (style.transform === 'uppercase') displayText = text.toUpperCase();

  // Typewriter: truncate text based on progress
  if (animation === 'typewriter' && progress < 1) {
    const charCount = Math.floor(displayText.length * progress);
    displayText = displayText.substring(0, charCount);
  }

  ctx.save();

  // Slide-up animation: blend alpha with eased progress
  if (animation === 'slide-up' && progress < 1) {
    const eased = easeOutCubic(progress);
    ctx.globalAlpha = alpha * eased;
    ctx.translate(0, 40 * (1 - eased));
  } else {
    ctx.globalAlpha = alpha;
  }

  ctx.font = `${style.weight} ${fontSize}px 'Inter', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (typeof ctx.letterSpacing !== 'undefined') {
    ctx.letterSpacing = style.spacing;
  }

  const lines = displayText.split('\\n');
  const lineH = fontSize * 1.4;
  let yBase;
  if (position === 'top') yBase = cH * 0.14;
  else if (position === 'bottom') yBase = cH * 0.86;
  else yBase = cH * 0.5;

  const maxW = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
  const padX = 28, padY = 12;
  const boxW = maxW + padX * 2;
  const boxH = lines.length * lineH + padY * 2;

  // Clear any inherited shadow before drawing background
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Draw background
  if (style.bg === 'pill') {
    ctx.fillStyle = style.bgColor;
    ctx.beginPath();
    ctx.roundRect(cW / 2 - boxW / 2, yBase - boxH / 2, boxW, boxH, 8);
    ctx.fill();
  } else if (style.bg === 'bar') {
    ctx.fillStyle = style.bgColor;
    ctx.fillRect(0, yBase - boxH / 2, cW, boxH);
  } else if (style.bg === 'gradient') {
    const gradH = boxH * 2.5;
    const grad = ctx.createLinearGradient(0, yBase - gradH / 2, 0, yBase + gradH / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.3, 'rgba(0,0,0,0.7)');
    grad.addColorStop(0.7, 'rgba(0,0,0,0.7)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, yBase - gradH / 2, cW, gradH);
  }
  // 'none' — no background

  // Set up text shadow
  if (style.shadow === 'subtle') {
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
  }

  // Draw outline stroke for 'outline' shadow style
  if (style.shadow === 'outline') {
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    lines.forEach((line, i) => {
      ctx.strokeText(line, cW / 2, yBase - ((lines.length - 1) / 2 - i) * lineH);
    });
  }

  // Draw text fill
  ctx.fillStyle = style.color;
  lines.forEach((line, i) => {
    ctx.fillText(line, cW / 2, yBase - ((lines.length - 1) / 2 - i) * lineH);
  });

  ctx.restore();
}

// ── Canvas stitching engine ──────────────────

async function stitchScenes(clipData, dims) {
  log('info', `=== STITCHING START: ${clipData.length} clips, ${dims.w}x${dims.h} ===`);
  setStage('Stitch', 'running', 'Loading clips...', 5);

  // Load all clips as video elements
  const videos = await Promise.all(clipData.map((clip, i) => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.src = clip.blobUrl;
      video.muted = true;
      video.preload = 'auto';
      video.playsInline = true;
      video.onloadeddata = () => resolve(video);
      video.onerror = () => reject(new Error(`Failed to load clip ${i + 1}`));
      video.load();
    });
  }));

  setStage('Stitch', 'running', 'Preparing canvas...', 10);

  const canvas = document.getElementById('stitchCanvas');
  canvas.width = dims.w;
  canvas.height = dims.h;
  const ctx = canvas.getContext('2d');

  // Calculate total timeline duration
  const crossfadeDur = CROSSFADE_DURATION;
  const sceneDurations = clipData.map(c => parseFloat(c.duration));
  // Total = sum of durations minus overlaps between consecutive scenes
  const totalDuration = sceneDurations.reduce((a, b) => a + b, 0) - crossfadeDur * (clipData.length - 1);

  // Build timeline: each scene has a start and end time in the global timeline
  const timeline = [];
  let cursor = 0;
  for (let i = 0; i < clipData.length; i++) {
    const start = cursor;
    const end = cursor + sceneDurations[i];
    timeline.push({ start, end, idx: i });
    cursor = end - crossfadeDur; // next scene starts crossfadeDur before this one ends
  }

  const stream = canvas.captureStream(30);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';
  log('info', `MediaRecorder: ${mimeType}, 6Mbps, ${dims.w}x${dims.h}@30fps`);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6000000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  return new Promise((resolve, reject) => {
    recorder.onstop = () => {
      clipData.forEach(c => URL.revokeObjectURL(c.blobUrl));
      const finalBlob = new Blob(chunks, { type: mimeType });
      log('success', `=== STITCHING COMPLETE: ${(finalBlob.size / 1024 / 1024).toFixed(1)}MB, ${mimeType} ===`);
      resolve(finalBlob);
    };

    recorder.onerror = (e) => {
      log('error', `MediaRecorder error: ${e.error?.message || e.error || 'unknown'}`);
    };

    let globalTime = 0;
    let lastTimestamp = null;

    // Pause all videos and seek to start
    videos.forEach(v => { v.pause(); v.currentTime = 0; });

    recorder.start();
    setStage('Stitch', 'running', 'Rendering scenes...', 15);

    function render(timestamp) {
      if (lastTimestamp === null) lastTimestamp = timestamp;
      const dt = (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;
      globalTime += dt;

      if (globalTime >= totalDuration) {
        recorder.stop();
        setStage('Stitch', 'running', 'Encoding...', 95);
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < timeline.length; i++) {
        const t = timeline[i];
        if (globalTime < t.start || globalTime >= t.end) continue;

        const localTime = globalTime - t.start;
        const sceneDur = sceneDurations[i];
        const video = videos[i];

        // Seek video to match global timeline position
        video.currentTime = Math.min(localTime, video.duration - 0.01);

        // Calculate crossfade alpha
        let alpha = 1;
        if (i > 0 && localTime < crossfadeDur) {
          alpha = localTime / crossfadeDur;
        }
        if (i < timeline.length - 1 && localTime > sceneDur - crossfadeDur) {
          alpha = (sceneDur - localTime) / crossfadeDur;
        }
        alpha = Math.max(0, Math.min(1, alpha));

        ctx.globalAlpha = alpha;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;

        // Text overlay
        if (clipData[i].overlay) {
          const overlayFade = 0.3;
          const animInDur = 0.5;
          let textAlpha = 1;
          if (localTime < overlayFade) textAlpha = localTime / overlayFade;
          if (localTime > sceneDur - overlayFade) textAlpha = (sceneDur - localTime) / overlayFade;
          textAlpha = Math.min(textAlpha, alpha);

          // Animation progress: 0→1 over first 0.5s of the scene
          const progress = Math.min(localTime / animInDur, 1);

          drawTextOverlay(ctx, clipData[i].overlay, textAlpha, canvas.width, canvas.height,
            clipData[i].overlayPos, clipData[i].overlayStyle, clipData[i].overlaySize, clipData[i].overlayAnim, progress);
        }
      }

      const pct = Math.round((globalTime / totalDuration) * 100);
      setStage('Stitch', 'running', `Rendering: ${pct}%`, 15 + Math.round(pct * 0.8));
      requestAnimationFrame(render);
    }

    requestAnimationFrame(render);
  });
}

// ── FFmpeg WASM: WebM → MP4 conversion ───────

let _ffmpeg = null;

async function loadFFmpeg() {
  if (_ffmpeg) return _ffmpeg;

  log('info', 'Loading FFmpeg WASM (first time only)...');
  setStage('Convert', 'running', 'Loading FFmpeg WASM...', 5);

  const { FFmpeg } = await importEsm('https://esm.sh/@ffmpeg/ffmpeg@0.12.10?bundle');
  const { toBlobURL } = await importEsm('https://esm.sh/@ffmpeg/util@0.12.1?bundle');

  const ffmpeg = new FFmpeg();

  ffmpeg.on('log', ({ message }) => {
    log('debug', `ffmpeg: ${message}`);
  });

  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.round(progress * 100);
    setStage('Convert', 'running', `Converting: ${pct}%`, 10 + Math.round(pct * 0.85));
  });

  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  log('success', 'FFmpeg WASM loaded');
  _ffmpeg = ffmpeg;
  return ffmpeg;
}

async function convertToMp4(webmBlob) {
  setStage('Convert', 'running', 'Loading FFmpeg...', 5);
  const t0 = performance.now();

  try {
    const ffmpeg = await loadFFmpeg();

    // Write WebM to FFmpeg virtual filesystem
    const webmData = new Uint8Array(await webmBlob.arrayBuffer());
    await ffmpeg.writeFile('input.webm', webmData);
    log('info', `FFmpeg input: ${(webmData.length / 1024 / 1024).toFixed(1)}MB WebM`);

    setStage('Convert', 'running', 'Converting to MP4 H.264...', 12);

    // Convert: WebM VP9 → MP4 H.264 + AAC
    await ffmpeg.exec([
      '-i', 'input.webm',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      'output.mp4'
    ]);

    const mp4Data = await ffmpeg.readFile('output.mp4');
    const mp4Blob = new Blob([mp4Data], { type: 'video/mp4' });

    // Clean up virtual filesystem
    await ffmpeg.deleteFile('input.webm');
    await ffmpeg.deleteFile('output.mp4');

    const dur = ((performance.now() - t0) / 1000).toFixed(1);
    log('success', `=== CONVERSION COMPLETE: ${(mp4Blob.size / 1024 / 1024).toFixed(1)}MB MP4 in ${dur}s ===`);
    setStage('Convert', 'done', `MP4 ready (${(mp4Blob.size / 1024 / 1024).toFixed(1)}MB)`, 100);

    return mp4Blob;
  } catch (e) {
    const dur = ((performance.now() - t0) / 1000).toFixed(1);
    log('error', `FFmpeg conversion failed after ${dur}s: ${e.message}${e.stack ? '\n' + e.stack : ''}`);
    setStage('Convert', 'error', e.message, 0);
    throw e;
  }
}

// ── R2 Upload ────────────────────────────────

async function uploadToR2(blob, workerUrl) {
  if (!workerUrl) return null;

  const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
  log('info', `R2 upload → ${workerUrl}/upload (${sizeMB}MB, ${blob.type})`);
  setStage('Upload', 'running', 'Uploading to R2...', 30);

  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const t0 = performance.now();
  const res = await fetch(workerUrl.replace(/\/$/, '') + '/upload', {
    method: 'POST',
    headers: {
      'Content-Type': blob.type,
      'X-Filename': `ad-${Date.now()}.${ext}`,
    },
    body: blob,
  });

  const dur = ((performance.now() - t0) / 1000).toFixed(1);
  if (!res.ok) {
    const text = await res.text();
    log('error', `R2 upload ← HTTP ${res.status} after ${dur}s: ${text}`);
    throw new Error(`Upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  log('success', `R2 upload ← ${dur}s, key=${data.key}, url=${data.url?.slice(0, 60)}...`);
  setStage('Upload', 'done', 'Uploaded to R2', 100);
  return data.url;
}

// ── Claude ad copy ───────────────────────────

async function generateCopy(businessName, targetAudience, adObjective, offer, clips, anthropicKey) {
  const scenesText = clips.map((c, i) => {
    const parts = [`Scene ${i + 1}:`];
    if (c.overlay) parts.push(`Overlay text: "${c.overlay}"`);
    if (c.description && c.description !== 'Uploaded image') parts.push(`Visual: ${c.description}`);
    return parts.join(' ');
  }).join('\n');

  // Use brand analysis if available from two-step brief generation
  const brandAnalysisBlock = pipeline.brandAnalysis
    ? `\n=== BRAND PROFILE (from analysis) ===\n${JSON.stringify(pipeline.brandAnalysis, null, 2)}\n`
    : '';

  const brandUrl = document.getElementById('brandUrl').value.trim();
  const brandLine = !brandAnalysisBlock && brandUrl ? `\nBrand Website: ${brandUrl}` : '';
  const brandContextBlock = !brandAnalysisBlock && pipeline.brandContext
    ? `\nBrand Website Content:\n${pipeline.brandContext}\n`
    : '';

  const prompt = `You are an expert Facebook ad copywriter. Write copy that speaks DIRECTLY to the target audience and sells the specific product/offer described below.

Business/Product: ${businessName}
Target Audience: ${targetAudience || 'general audience'}
Ad Objective: ${adObjective}
${offer ? `Offer/Hook: ${offer}` : 'No specific offer provided — create a compelling value proposition'}${brandLine}${brandAnalysisBlock}${brandContextBlock}

The video ad tells this story:
${scenesText}

IMPORTANT:
- The primary text MUST reference the specific business "${businessName}" and speak to "${targetAudience || 'the target audience'}"
- ${offer ? `Feature the offer "${offer}" prominently` : 'Create a specific, compelling reason to act now'}
- The headline must be about THIS product/business, not generic
- Match the brand's tone${pipeline.brandAnalysis?.tone ? ` (${pipeline.brandAnalysis.tone})` : ' if brand context is provided above'}

Return ONLY valid JSON — no markdown, no preamble:
{
  "primaryText": "2-3 sentences. Speak directly to the target audience. Reference the business by name. End with a clear CTA.",
  "headline": "Punchy headline about THIS business, max 7 words",
  "description": "One specific benefit of THIS product, max 12 words",
  "cta": "One of: Book Now, Learn More, Shop Now, Sign Up, Get Offer, Contact Us",
  "hook": "Opening 3-4 words that stop the scroll for THIS audience"
}`;

  log('info', `Claude ad copy → model=claude-sonnet-4-20250514, key=${maskKey(anthropicKey)}, scenes=${clips.length}`);
  const t0 = performance.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const dur = ((performance.now() - t0) / 1000).toFixed(1);
  if (!res.ok) {
    const errBody = await res.text();
    log('error', `Claude ad copy ← HTTP ${res.status} after ${dur}s: ${errBody}`);
    throw new Error('Claude API error ' + res.status);
  }
  const data = await res.json();
  log('success', `Claude ad copy ← ${dur}s, usage: ${JSON.stringify(data.usage || {})}`);
  const text = data.content[0].text.replace(/```json|```/g, '').trim();
  log('debug', `Claude ad copy raw:\n${text}`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseErr) {
    log('error', `Ad copy JSON parse failed: ${parseErr.message}\nRaw: ${text}`);
    throw parseErr;
  }
  log('success', `Ad copy: headline="${parsed.headline}", cta="${parsed.cta}"`);
  return parsed;
}

function renderCopy(copy) {
  const panel = document.getElementById('copyPanel');
  const fields = [
    { label: 'Primary Text', key: 'primaryText' },
    { label: 'Headline', key: 'headline' },
    { label: 'Description', key: 'description' },
    { label: 'CTA Button', key: 'cta' },
    { label: 'Scroll-stop Hook', key: 'hook' },
  ];
  panel.innerHTML = fields.map(f => {
    const val = copy[f.key] || '';
    const escaped = val.replace(/'/g, "\\'").replace(/\n/g, '\\n');
    return `
    <div class="copy-block">
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div class="copy-label">${f.label}</div>
        <button class="copy-btn-small" onclick="copyText(this,'${escaped}')">Copy</button>
      </div>
      <div class="copy-text">${val}</div>
    </div>`;
  }).join('');
  panel.style.display = 'block';
}

function copyText(btn, text) {
  navigator.clipboard.writeText(text.replace(/\\n/g, '\n'));
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 2000);
}

// ── Pipeline state ───────────────────────────

const pipeline = {
  sceneData: [],     // collected inputs from scene cards
  imageUrls: [],     // image URL per scene (from Flux or upload)
  clipData: [],      // { blobUrl, overlay, overlayPos, duration, description } per scene
  dims: null,        // format dimensions
  totalCost: 0,
  brandContext: '',   // scraped brand website text, persisted across phases
  brandAnalysis: null, // structured brand profile from step 1, used in copy generation
};

// ── Stage HTML generators ────────────────────

function createImageStageHTML(i) {
  return `
    <div class="stage" id="stageImg${i}">
      <div class="stage-header">
        <span class="stage-name">Scene ${i + 1} &middot; Image</span>
        <span class="badge badge-wait" id="badgeImg${i}">Waiting</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" id="progImg${i}" style="width:0%"></div></div>
      <div class="stage-msg" id="msgImg${i}">Ready</div>
      <div class="stage-preview" id="previewImg${i}" style="display:none"></div>
      <div class="stage-actions" id="actionsImg${i}" style="display:none">
        <button class="btn-regen" onclick="regenerateImage(${i})">Regenerate Image</button>
      </div>
    </div>`;
}

function createVideoStageHTML(i) {
  return `
    <div class="stage" id="stageVid${i}">
      <div class="stage-header">
        <span class="stage-name">Scene ${i + 1} &middot; Video</span>
        <span class="badge badge-wait" id="badgeVid${i}">Waiting</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" id="progVid${i}" style="width:0%"></div></div>
      <div class="stage-msg" id="msgVid${i}">Ready</div>
      <div class="stage-preview" id="previewVid${i}" style="display:none"></div>
      <div class="stage-actions" id="actionsVid${i}" style="display:none">
        <button class="btn-regen" onclick="regenerateVideo(${i})">Regenerate Video</button>
      </div>
    </div>`;
}

function setImgStage(i, status, msg, progress) { setStage('Img' + i, status, msg, progress); }
function setVidStage(i, status, msg, progress) { setStage('Vid' + i, status, msg, progress); }

function showImagePreview(i, url) {
  const container = document.getElementById('previewImg' + i);
  container.innerHTML = `<img src="${url}" alt="Scene ${i + 1}" />`;
  container.style.display = 'block';
  document.getElementById('actionsImg' + i).style.display = 'flex';
}

function showVideoPreview(i, blobUrl) {
  const container = document.getElementById('previewVid' + i);
  container.innerHTML = `<video src="${blobUrl}" controls muted playsinline></video>`;
  container.style.display = 'block';
  document.getElementById('actionsVid' + i).style.display = 'flex';
}

// ── Collect scene inputs ─────────────────────

function collectSceneData() {
  return scenes.map(scene => {
    const id = scene.id;
    const mode = document.querySelector(`input[name="imgSrc-${id}"]:checked`)?.value || 'ai';
    return {
      id,
      isUpload: mode === 'upload',
      isProduct: mode === 'product',
      productIndex: mode === 'product' ? parseInt(document.getElementById(`productSelect-${id}`)?.value || '0') : null,
      description: document.getElementById(`desc-${id}`)?.value?.trim() || '',
      file: mode === 'upload' ? document.getElementById(`file-${id}`)?.files?.[0] : null,
      motion: document.getElementById(`motion-${id}`)?.value?.trim() || 'slow cinematic camera movement',
      overlay: document.getElementById(`overlay-${id}`)?.value?.trim() || '',
      overlayPos: document.getElementById(`overlayPos-${id}`)?.value || 'centre',
      overlayStyle: document.getElementById(`overlayStyle-${id}`)?.value || 'clean',
      overlaySize: document.getElementById(`overlaySize-${id}`)?.value || 'medium',
      overlayAnim: document.getElementById(`overlayAnim-${id}`)?.value || 'fade',
      duration: document.getElementById(`duration-${id}`)?.value || '5',
    };
  });
}

// ── Phase 1: Generate Images ─────────────────

async function generateOneImage(i) {
  const scene = pipeline.sceneData[i];
  const falKey = document.getElementById('falKey').value.trim();
  const dims = pipeline.dims;
  const label = `Scene ${i + 1} image`;

  if (scene.isProduct) {
    log('info', `${label}: using product image #${scene.productIndex}`);
    setImgStage(i, 'running', 'Preparing product image...', 20);
    const pi = productImages[scene.productIndex];
    if (!pi) throw new Error('Product image not found');
    if (!pi.falUrl) {
      log('info', `${label}: uploading product image to fal.ai (${pi.file.name}, ${(pi.file.size / 1024).toFixed(0)}KB)`);
      pi.falUrl = await uploadImageToFal(pi.file, falKey, dims);
      log('success', `${label}: product image uploaded → ${pi.falUrl.slice(0, 60)}...`);
    }
    pipeline.imageUrls[i] = pi.falUrl;
    setImgStage(i, 'done', 'Product image ready', 100);
    showImagePreview(i, pi.falUrl);
  } else if (scene.isUpload) {
    log('info', `${label}: uploading user image (${scene.file.name}, ${(scene.file.size / 1024).toFixed(0)}KB) → resize to ${dims.w}x${dims.h}`);
    setImgStage(i, 'running', 'Resizing & uploading...', 20);
    const url = await uploadImageToFal(scene.file, falKey, dims);
    pipeline.imageUrls[i] = url;
    log('success', `${label}: uploaded → ${url.slice(0, 60)}...`);
    setImgStage(i, 'done', 'Image uploaded', 100);
    showImagePreview(i, url);
  } else {
    log('info', `${label}: generating via Flux Schnell — "${scene.description.slice(0, 80)}${scene.description.length > 80 ? '...' : ''}"`);
    setImgStage(i, 'running', 'Generating image...', 10);
    const result = await falRun('fal-ai/flux/schnell', {
      prompt: scene.description,
      image_size: dims.image_size,
      num_inference_steps: 4,
      num_images: 1,
      enable_safety_checker: true,
    }, falKey, p => setImgStage(i, 'running', 'Generating...', p));

    const url = result?.data?.images?.[0]?.url || result?.images?.[0]?.url;
    if (!url) {
      log('error', `${label}: no image URL in response`, result);
      throw new Error('No image URL returned');
    }
    pipeline.imageUrls[i] = url;
    pipeline.totalCost += 0.003;
    log('success', `${label}: generated → ${url.slice(0, 60)}...`);
    setImgStage(i, 'done', 'Image ready', 100);
    showImagePreview(i, url);
  }
}

async function generateImages() {
  const falKey = document.getElementById('falKey').value.trim();
  if (!falKey) { alert('Please enter your fal.ai API key'); return; }

  const workerUrl = document.getElementById('workerUrl').value.trim();
  if (workerUrl) try { localStorage.setItem('meta-ad-worker-url', workerUrl); } catch(e) {}

  pipeline.sceneData = collectSceneData();
  const format = document.getElementById('adFormat').value;
  pipeline.dims = getFormatDims(format);
  pipeline.imageUrls = new Array(pipeline.sceneData.length).fill(null);
  pipeline.clipData = [];
  pipeline.totalCost = 0;

  log('info', `=== IMAGE GENERATION START ===`);
  log('info', `Format: ${format} (${pipeline.dims.w}x${pipeline.dims.h}), Scenes: ${pipeline.sceneData.length}, fal key: ${maskKey(falKey)}`);
  pipeline.sceneData.forEach((s, i) => {
    const src = s.isProduct ? `product #${s.productIndex}` : s.isUpload ? `upload (${s.file?.name})` : `AI: "${(s.description || '').slice(0, 50)}"`;
    log('debug', `  Scene ${i + 1}: ${src}, overlay="${s.overlay}", pos=${s.overlayPos}, style=${s.overlayStyle}, dur=${s.duration}s`);
  });

  for (let i = 0; i < pipeline.sceneData.length; i++) {
    const s = pipeline.sceneData[i];
    if (s.isProduct) {
      if (!productImages[s.productIndex]) { alert(`Scene ${i + 1}: Selected product image not found`); return; }
    } else if (s.isUpload && !s.file) { alert(`Scene ${i + 1}: Please select an image to upload`); return; }
    else if (!s.isUpload && !s.isProduct && !s.description) { alert(`Scene ${i + 1}: Please enter a scene description`); return; }
  }

  // Set up UI
  document.getElementById('generateBtn').disabled = true;
  document.getElementById('pipeline').style.display = 'block';
  document.getElementById('approveImagesBtn').style.display = 'none';
  document.getElementById('videoStages').style.display = 'none';
  document.getElementById('approveClipsBtn').style.display = 'none';
  document.getElementById('finalStages').style.display = 'none';
  document.getElementById('outputSection').style.display = 'none';
  document.getElementById('costBar').style.display = 'none';
  document.getElementById('startOverBtn').style.display = 'none';

  // Build image stage cards
  document.getElementById('sceneStages').innerHTML =
    pipeline.sceneData.map((_, i) => createImageStageHTML(i)).join('');

  // Generate all images in parallel
  const results = await Promise.allSettled(
    pipeline.sceneData.map((_, i) => generateOneImage(i))
  );

  let allOk = true;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      log('error', `Scene ${i + 1} image FAILED: ${r.reason?.message || 'Unknown error'}${r.reason?.stack ? '\n' + r.reason.stack : ''}`);
      setImgStage(i, 'error', r.reason?.message || 'Failed', 0);
      allOk = false;
    }
  });

  const ok = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.length - ok;
  log(allOk ? 'success' : 'warn', `=== IMAGE GENERATION ${allOk ? 'COMPLETE' : 'PARTIAL'}: ${ok}/${results.length} OK, ${fail} failed, cost ~$${pipeline.totalCost.toFixed(2)} ===`);

  document.getElementById('costValue').textContent = `~$${pipeline.totalCost.toFixed(2)}`;
  document.getElementById('costBar').style.display = 'flex';

  if (allOk) {
    document.getElementById('approveImagesBtn').style.display = 'block';
  } else {
    document.getElementById('generateBtn').disabled = false;
  }
}

async function regenerateImage(i) {
  const btn = document.querySelector(`#actionsImg${i} .btn-regen`);
  btn.disabled = true;
  try {
    // Re-read the description from the scene card (user may have edited it)
    const scene = pipeline.sceneData[i];
    const id = scene.id;
    if (!scene.isUpload) {
      scene.description = document.getElementById(`desc-${id}`)?.value?.trim() || scene.description;
    }
    await generateOneImage(i);
  } catch (e) {
    setImgStage(i, 'error', e.message, 0);
  }
  btn.disabled = false;
  document.getElementById('costValue').textContent = `~$${pipeline.totalCost.toFixed(2)}`;
}

// ── Phase 2: Generate Videos ─────────────────

async function generateOneVideo(i) {
  const scene = pipeline.sceneData[i];
  const falKey = document.getElementById('falKey').value.trim();
  const dims = pipeline.dims;
  const imageUrl = pipeline.imageUrls[i];
  const label = `Scene ${i + 1} video`;

  const id = scene.id;
  scene.motion = document.getElementById(`motion-${id}`)?.value?.trim() || scene.motion;
  scene.overlay = document.getElementById(`overlay-${id}`)?.value?.trim() || scene.overlay;
  scene.overlayPos = document.getElementById(`overlayPos-${id}`)?.value || scene.overlayPos;
  scene.overlayStyle = document.getElementById(`overlayStyle-${id}`)?.value || scene.overlayStyle || 'clean';
  scene.overlaySize = document.getElementById(`overlaySize-${id}`)?.value || scene.overlaySize || 'medium';
  scene.overlayAnim = document.getElementById(`overlayAnim-${id}`)?.value || scene.overlayAnim || 'fade';
  scene.duration = document.getElementById(`duration-${id}`)?.value || scene.duration;

  const motionPrompt = scene.isProduct
    ? 'static product shot, very subtle lighting shift, no morphing or deformation'
    : scene.motion;

  log('info', `${label}: Seedance Lite, duration=${scene.duration}s, motion="${motionPrompt.slice(0, 60)}"`);
  setVidStage(i, 'running', scene.isProduct ? 'Animating (conservative)...' : 'Animating...', 10);
  const vidResult = await falRun('fal-ai/bytedance/seedance/v1/lite/image-to-video', {
    image_url: imageUrl,
    prompt: motionPrompt,
    aspect_ratio: dims.aspect_ratio,
    duration: parseInt(scene.duration),
  }, falKey, p => setVidStage(i, 'running', scene.isProduct ? 'Animating (conservative)...' : 'Animating...', p));

  const videoUrl = vidResult?.data?.video?.url || vidResult?.video?.url;
  if (!videoUrl) {
    log('error', `${label}: no video URL in response`, vidResult);
    throw new Error('No video URL returned');
  }
  pipeline.totalCost += 0.18;

  log('info', `${label}: downloading clip from ${videoUrl.slice(0, 60)}...`);
  setVidStage(i, 'running', 'Downloading clip...', 92);
  const response = await fetch(videoUrl);
  if (!response.ok) {
    log('error', `${label}: clip download failed HTTP ${response.status}`);
    throw new Error('Failed to download clip');
  }
  const blob = await response.blob();
  log('success', `${label}: clip downloaded (${(blob.size / 1024 / 1024).toFixed(1)}MB, ${blob.type})`);
  const blobUrl = URL.createObjectURL(blob);

  pipeline.clipData[i] = {
    blobUrl,
    overlay: scene.overlay,
    overlayPos: scene.overlayPos,
    overlayStyle: scene.overlayStyle || 'clean',
    overlaySize: scene.overlaySize || 'medium',
    overlayAnim: scene.overlayAnim || 'fade',
    duration: scene.duration,
    description: scene.description || 'Uploaded image',
  };

  setVidStage(i, 'done', 'Video ready', 100);
  showVideoPreview(i, blobUrl);
}

async function approveImages() {
  log('info', `=== VIDEO GENERATION START (${pipeline.sceneData.length} scenes) ===`);
  document.getElementById('approveImagesBtn').style.display = 'none';

  const container = document.getElementById('videoStages');
  container.innerHTML = pipeline.sceneData.map((_, i) => createVideoStageHTML(i)).join('');
  container.style.display = 'block';

  pipeline.clipData = new Array(pipeline.sceneData.length).fill(null);

  const results = await Promise.allSettled(
    pipeline.sceneData.map((_, i) => generateOneVideo(i))
  );

  let allOk = true;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      log('error', `Scene ${i + 1} video FAILED: ${r.reason?.message || 'Unknown'}${r.reason?.stack ? '\n' + r.reason.stack : ''}`);
      setVidStage(i, 'error', r.reason?.message || 'Failed', 0);
      allOk = false;
    }
  });

  const ok = results.filter(r => r.status === 'fulfilled').length;
  log(allOk ? 'success' : 'warn', `=== VIDEO GENERATION ${allOk ? 'COMPLETE' : 'PARTIAL'}: ${ok}/${results.length} OK, cost ~$${pipeline.totalCost.toFixed(2)} ===`);

  document.getElementById('costValue').textContent = `~$${pipeline.totalCost.toFixed(2)}`;

  if (allOk) {
    document.getElementById('approveClipsBtn').style.display = 'block';
  }
}

async function regenerateVideo(i) {
  const btn = document.querySelector(`#actionsVid${i} .btn-regen`);
  btn.disabled = true;
  try {
    // Revoke old blob URL
    if (pipeline.clipData[i]?.blobUrl) URL.revokeObjectURL(pipeline.clipData[i].blobUrl);
    await generateOneVideo(i);
  } catch (e) {
    setVidStage(i, 'error', e.message, 0);
  }
  btn.disabled = false;
  document.getElementById('costValue').textContent = `~$${pipeline.totalCost.toFixed(2)}`;
}

// ── Phase 3: Stitch + Upload + Copy ──────────

async function approveClips() {
  log('info', `=== FINAL PHASE START: stitch + upload + copy ===`);
  document.getElementById('approveClipsBtn').style.display = 'none';
  document.getElementById('finalStages').style.display = 'block';

  const dims = pipeline.dims;
  const clips = pipeline.clipData.filter(Boolean);
  log('info', `Clips ready: ${clips.length}, total duration: ${clips.reduce((a, c) => a + parseFloat(c.duration), 0)}s`);
  const workerUrl = document.getElementById('workerUrl').value.trim();
  const anthropicKey = document.getElementById('anthropicKey').value.trim();
  const businessName = document.getElementById('businessName').value.trim();
  const targetAudience = document.getElementById('targetAudience').value.trim();
  const adObjective = document.getElementById('adObjective').value;
  const offer = document.getElementById('offerHook').value.trim();

  // Reset stages
  setStage('Stitch', 'wait', 'Starting...', 0);
  setStage('Convert', 'wait', 'Waiting for stitching', 0);
  setStage('Upload', 'wait', 'Waiting for conversion', 0);
  setStage('Copy', 'wait', 'Waiting', 0);
  document.getElementById('copyPanel').style.display = 'none';

  const stitchTask = (async () => {
    try {
      // Phase 3a: Stitch WebM
      const webmBlob = await stitchScenes(clips, dims);

      // Show WebM preview immediately while conversion runs
      const previewUrl = URL.createObjectURL(webmBlob);
      document.getElementById('outputSection').style.display = 'block';
      document.getElementById('previewVideo').src = previewUrl;
      document.getElementById('previewVideo').style.display = 'block';
      setStage('Stitch', 'done', `Stitched ${clips.length} scenes`, 100);

      // Phase 3b: Convert WebM → MP4
      let finalBlob;
      try {
        finalBlob = await convertToMp4(webmBlob);
        // Update preview to MP4
        const mp4Url = URL.createObjectURL(finalBlob);
        document.getElementById('previewVideo').src = mp4Url;
        URL.revokeObjectURL(previewUrl);
      } catch (convertErr) {
        log('warn', `MP4 conversion failed — falling back to WebM: ${convertErr.message}`);
        finalBlob = webmBlob;
        // Convert stage already marked as error by convertToMp4
      }

      const ext = finalBlob.type.includes('mp4') ? 'mp4' : 'webm';
      const dlUrl = URL.createObjectURL(finalBlob);
      document.getElementById('downloadFinal').href = dlUrl;
      document.getElementById('downloadFinal').setAttribute('download', `meta-ad-${Date.now()}.${ext}`);
      document.getElementById('downloadFinal').textContent = `Download Final Video (${ext.toUpperCase()})`;
      document.getElementById('downloadWrap').style.display = 'block';

      // Phase 3c: Upload to R2
      if (workerUrl) {
        try {
          const r2Url = await uploadToR2(finalBlob, workerUrl);
          if (r2Url) {
            const dlLink = document.getElementById('downloadWorker');
            dlLink.href = r2Url;
            dlLink.style.display = 'block';
          }
        } catch (e) {
          log('error', `R2 upload failed: ${e.message}`);
          setStage('Upload', 'error', e.message, 0);
        }
      } else {
        log('info', 'No Worker URL — R2 upload skipped');
        setStage('Upload', 'done', 'No Worker URL — skipped', 100);
      }
    } catch (e) {
      log('error', `Stitching failed: ${e.message}${e.stack ? '\n' + e.stack : ''}`);
      setStage('Stitch', 'error', e.message, 0);
    }
  })();

  const copyTask = (async () => {
    if (!anthropicKey) {
      log('info', 'No Anthropic key — ad copy skipped');
      setStage('Copy', 'done', 'No Anthropic key — skipped', 100);
      return;
    }
    if (!businessName) {
      log('warn', 'Business name missing — ad copy skipped');
      setStage('Copy', 'error', 'Business name required for copy generation', 0);
      return;
    }
    try {
      setStage('Copy', 'running', 'Writing ad copy...', 30);
      const copy = await generateCopy(businessName, targetAudience, adObjective, offer, clips, anthropicKey);
      renderCopy(copy);
      setStage('Copy', 'done', 'Ad copy ready', 100);
      pipeline.totalCost += 0.003;
    } catch (e) {
      log('error', `Ad copy generation failed: ${e.message}`);
      setStage('Copy', 'error', e.message, 0);
    }
  })();

  await Promise.all([stitchTask, copyTask]);

  log('success', `=== PIPELINE COMPLETE — total cost ~$${pipeline.totalCost.toFixed(2)} ===`);
  document.getElementById('costValue').textContent = `~$${pipeline.totalCost.toFixed(2)}`;
  document.getElementById('startOverBtn').style.display = 'block';
}

// ── Start Over ───────────────────────────────

function startOver() {
  // Clean up blob URLs
  pipeline.clipData.forEach(c => { if (c?.blobUrl) URL.revokeObjectURL(c.blobUrl); });

  pipeline.sceneData = [];
  pipeline.imageUrls = [];
  pipeline.clipData = [];
  pipeline.dims = null;
  pipeline.totalCost = 0;
  pipeline.brandContext = '';
  pipeline.brandAnalysis = null;

  // Reset pipeline UI
  document.getElementById('pipeline').style.display = 'none';
  document.getElementById('sceneStages').innerHTML = '';
  document.getElementById('videoStages').innerHTML = '';
  document.getElementById('videoStages').style.display = 'none';
  document.getElementById('finalStages').style.display = 'none';
  document.getElementById('approveImagesBtn').style.display = 'none';
  document.getElementById('approveClipsBtn').style.display = 'none';
  document.getElementById('outputSection').style.display = 'none';
  document.getElementById('downloadWrap').style.display = 'none';
  document.getElementById('costBar').style.display = 'none';
  document.getElementById('startOverBtn').style.display = 'none';
  document.getElementById('copyPanel').style.display = 'none';

  // Release preview video src
  const previewVideo = document.getElementById('previewVideo');
  if (previewVideo.src) { previewVideo.removeAttribute('src'); previewVideo.load(); }

  // Release download links
  const dlFinal = document.getElementById('downloadFinal');
  if (dlFinal.href) dlFinal.removeAttribute('href');
  const dlWorker = document.getElementById('downloadWorker');
  dlWorker.style.display = 'none';
  if (dlWorker.href) dlWorker.removeAttribute('href');

  // Re-enable buttons
  document.getElementById('generateBtn').disabled = false;
  document.getElementById('generateBtn').textContent = 'Generate Images';
  document.getElementById('generateBriefBtn').disabled = false;
  document.getElementById('generateBriefBtn').textContent = 'Generate Ad Brief';
}
