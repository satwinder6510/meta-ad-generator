// ─────────────────────────────────────────────
// Meta Ad Generator — app.js
// Multi-scene pipeline: per-scene (Flux + Seedance) → Canvas stitch → R2 upload → Claude copy
// ─────────────────────────────────────────────

// ── State ────────────────────────────────────

let scenes = [];
let falClient = null;
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

// ── Creative Director system prompt ───────────

const BRIEF_SYSTEM_PROMPT = `You are a Creative Director specializing in Meta/Facebook video ads. You understand Facebook's algorithm priorities:

- **3-second rule**: The first 3 seconds determine whether a user stops scrolling. Scene 1 MUST have a visually striking image and bold overlay text that creates curiosity or urgency.
- **Sound-off optimization**: 85%+ of Facebook video is watched without sound. Every scene MUST have overlay text that tells the story visually.
- **Hook-first structure**: Lead with the most compelling visual/claim. Don't save the best for last.
- **Emotional arc**: Scene 1 = attention/curiosity, Scene 2 = problem/desire, Scene 3 = solution/proof, Scene 4 (if present) = CTA/urgency.
- **Short attention spans**: Keep each scene punchy. Prefer 5s scenes for Stories/Reels formats.
- **Platform-native feel**: Match the format context (vertical = Stories/Reels energy, landscape = Feed polish, square = versatile).

Given the business info, audience, objective, format, and scene count, generate a complete ad brief as a JSON array.`;

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

window.onerror = function(msg, src, line) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:12px 16px;background:#dc2626;color:#fff;font-size:13px;z-index:9999';
  el.textContent = 'JS Error: ' + msg + ' (line ' + line + ')';
  document.body.prepend(el);
};

// ── Init ─────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  try {
    // Restore worker URL from localStorage
    const saved = localStorage.getItem('meta-ad-worker-url');
    if (saved) document.getElementById('workerUrl').value = saved;
  } catch(e) { /* localStorage may be blocked in private mode */ }

  // Start with 3 default scenes
  for (let i = 0; i < MIN_SCENES; i++) addScene();

  // Format change → apply smart defaults
  document.getElementById('adFormat').addEventListener('change', function() {
    applyFormatDefaults(this.value);
  });

  // Product image upload
  document.getElementById('productImageInput').addEventListener('change', handleProductImageUpload);
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

  const targetAudience = document.getElementById('targetAudience').value.trim() || 'general audience';
  const adObjective = document.getElementById('adObjective').value;
  const adFormat = document.getElementById('adFormat').value;
  const offer = document.getElementById('offerHook').value.trim();
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
      const proxyRes = await fetch(`${workerUrl.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(brandUrl)}`);
      if (proxyRes.ok) {
        const proxyData = await proxyRes.json();
        if (proxyData.text && !proxyData.error) {
          brandContext = `\nBrand Website Context (from ${proxyData.title || brandUrl}):\n${proxyData.text}\n\nUse this to match the brand's tone, vocabulary, and positioning in scene descriptions and overlay text.\n`;
        }
      }
    } catch (e) {
      // Silently skip — don't block brief generation
    }
  }

  statusEl.textContent = 'Claude is planning your ad...';

  // Product image awareness
  let productContext = '';
  if (productImages.length > 0) {
    productContext = `\nYou have ${productImages.length} product image(s) available. You can assign product images to scenes by adding "useProduct": true and "productIndex": <0-based index> to scene objects.\nProduct scenes should have motion prompts that are very subtle (the product must not be altered). Do NOT include a "description" for product scenes — the real product photo is used instead.\n`;
  }

  const userPrompt = `Generate a ${sceneCount}-scene video ad brief.

Business/Product: ${businessName}
Target Audience: ${targetAudience}
Ad Objective: ${adObjective}
Format: ${adFormat} — ${formatContext[adFormat] || 'Standard'}
${offer ? `Offer/Hook: ${offer}` : 'No specific offer — create a compelling hook'}
${brandContext}${productContext}
Return ONLY a valid JSON array with exactly ${sceneCount} objects. Each object must have:
{
  "description": "Detailed image generation prompt (what Flux AI should render — be specific about composition, lighting, mood, subject, colors)",
  "motion": "Camera/motion prompt for video animation (e.g. 'slow zoom in with gentle parallax', 'smooth pan right revealing product')",
  "overlay": "Overlay text for this scene (concise, impactful, readable at a glance)",
  "overlayPos": "top" | "centre" | "bottom",
  "overlayStyle": "clean" | "bold" | "cinematic" | "minimal" | "highlight" | "subtitle",
  "overlaySize": "small" | "medium" | "large",
  "overlayAnim": "fade" | "slide-up" | "typewriter",
  "duration": "5" | "8" | "10"
}

Rules:
- Scene 1 is the HOOK scene: use bold/highlight style, large size, bottom position for vertical or centre for landscape
- Scene descriptions should be photorealistic, no text in the image (text comes from overlay)
- Motion prompts should be subtle and cinematic, not jarring
- Overlay text must work with sound off — tell the complete story through text
- Keep overlay text to 6 words max per scene for readability
- Duration: prefer 5s for ${adFormat === '9:16' ? 'Stories/Reels' : 'most formats'}, 8s only for establishing shots`;

  try {
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
        max_tokens: 1200,
        system: BRIEF_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) throw new Error('Claude API error ' + res.status);
    const data = await res.json();
    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    const brief = JSON.parse(text);

    if (!Array.isArray(brief) || brief.length !== sceneCount) {
      throw new Error(`Expected ${sceneCount} scenes, got ${Array.isArray(brief) ? brief.length : 'non-array'}`);
    }

    applyBrief(brief);
    statusEl.textContent = 'Brief applied! Review and edit before generating.';
    statusEl.style.color = 'var(--green)';
    setTimeout(() => { statusEl.style.display = 'none'; statusEl.style.color = 'var(--text-muted)'; }, 4000);

  } catch (e) {
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

// ── fal.ai client ────────────────────────────

async function getFalClient(apiKey) {
  if (!falClient) {
    const mod = await import('https://esm.sh/@fal-ai/client');
    falClient = mod.fal;
  }
  falClient.config({ credentials: apiKey });
  return falClient;
}

async function falRun(endpoint, input, apiKey, onProgress) {
  const fal = await getFalClient(apiKey);
  let attempt = 0;
  const result = await fal.subscribe(endpoint, {
    input,
    pollInterval: 3000,
    onQueueUpdate: () => {
      attempt++;
      if (onProgress) onProgress(Math.min(15 + attempt * 3, 88));
    }
  });
  return result;
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
  // Resize/crop to target dimensions if dims provided
  const prepared = dims ? await prepareImage(file, dims.w, dims.h) : file;
  const fal = await getFalClient(apiKey);
  return await fal.storage.upload(prepared);
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
  // clipData: array of { blobUrl, overlay, overlayPos, duration }
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

  // Set up MediaRecorder
  const stream = canvas.captureStream(30);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6000000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  return new Promise((resolve, reject) => {
    recorder.onstop = () => {
      clipData.forEach(c => URL.revokeObjectURL(c.blobUrl));
      resolve(new Blob(chunks, { type: mimeType }));
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

// ── R2 Upload ────────────────────────────────

async function uploadToR2(blob, workerUrl) {
  if (!workerUrl) return null;

  setStage('Upload', 'running', 'Uploading to R2...', 30);

  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const res = await fetch(workerUrl.replace(/\/$/, '') + '/upload', {
    method: 'POST',
    headers: {
      'Content-Type': blob.type,
      'X-Filename': `ad-${Date.now()}.${ext}`,
    },
    body: blob,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  setStage('Upload', 'done', 'Uploaded to R2', 100);
  return data.url;
}

// ── Claude ad copy ───────────────────────────

async function generateCopy(businessName, targetAudience, adObjective, offer, sceneDescriptions, anthropicKey) {
  const offerLine = offer ? `\nOffer/Hook: ${offer}` : '';
  const scenesText = sceneDescriptions.map((d, i) => `Scene ${i + 1}: ${d}`).join('\n');

  const prompt = `You are an expert Facebook ad copywriter.

Write Facebook ad copy for this video ad:

Business/Product: ${businessName}
Target Audience: ${targetAudience}
Ad Objective: ${adObjective}${offerLine}

The video ad has these scenes:
${scenesText}

Return ONLY valid JSON — no markdown, no preamble:
{
  "primaryText": "Main ad copy, 2-3 sentences, emotional, ends with soft CTA",
  "headline": "Punchy headline, max 7 words",
  "description": "One benefit line, max 12 words",
  "cta": "One of: Book Now, Learn More, Shop Now, Sign Up, Get Offer, Contact Us",
  "hook": "Opening 3-4 words that stop the scroll"
}`;

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

  if (!res.ok) throw new Error('Claude API error ' + res.status);
  const data = await res.json();
  const text = data.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(text);
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
  sceneData: [],   // collected inputs from scene cards
  imageUrls: [],   // image URL per scene (from Flux or upload)
  clipData: [],    // { blobUrl, overlay, overlayPos, duration, description } per scene
  dims: null,      // format dimensions
  totalCost: 0,
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

  if (scene.isProduct) {
    setImgStage(i, 'running', 'Preparing product image...', 20);
    const pi = productImages[scene.productIndex];
    if (!pi) throw new Error('Product image not found');
    if (!pi.falUrl) {
      pi.falUrl = await uploadImageToFal(pi.file, falKey, dims);
    }
    pipeline.imageUrls[i] = pi.falUrl;
    setImgStage(i, 'done', 'Product image ready', 100);
    showImagePreview(i, pi.falUrl);
  } else if (scene.isUpload) {
    setImgStage(i, 'running', 'Resizing & uploading...', 20);
    const url = await uploadImageToFal(scene.file, falKey, dims);
    pipeline.imageUrls[i] = url;
    setImgStage(i, 'done', 'Image uploaded', 100);
    showImagePreview(i, url);
  } else {
    setImgStage(i, 'running', 'Generating image...', 10);
    const result = await falRun('fal-ai/flux/schnell', {
      prompt: scene.description,
      image_size: dims.image_size,
      num_inference_steps: 4,
      num_images: 1,
      enable_safety_checker: true,
    }, falKey, p => setImgStage(i, 'running', 'Generating...', p));

    const url = result?.data?.images?.[0]?.url || result?.images?.[0]?.url;
    if (!url) throw new Error('No image URL returned');
    pipeline.imageUrls[i] = url;
    pipeline.totalCost += 0.003;
    setImgStage(i, 'done', 'Image ready', 100);
    showImagePreview(i, url);
  }
}

async function generateImages() {
  const falKey = document.getElementById('falKey').value.trim();
  if (!falKey) { alert('Please enter your fal.ai API key'); return; }

  // Save worker URL
  const workerUrl = document.getElementById('workerUrl').value.trim();
  if (workerUrl) try { localStorage.setItem('meta-ad-worker-url', workerUrl); } catch(e) {}

  // Collect and validate
  pipeline.sceneData = collectSceneData();
  pipeline.dims = getFormatDims(document.getElementById('adFormat').value);
  pipeline.imageUrls = new Array(pipeline.sceneData.length).fill(null);
  pipeline.clipData = [];
  pipeline.totalCost = 0;

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

  // Check for failures
  let allOk = true;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      setImgStage(i, 'error', r.reason?.message || 'Failed', 0);
      allOk = false;
    }
  });

  // Update cost display
  document.getElementById('costValue').textContent = `~$${pipeline.totalCost.toFixed(2)}`;
  document.getElementById('costBar').style.display = 'flex';

  if (allOk) {
    // Show approval gate
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

  // Re-read motion prompt from scene card (user may have edited)
  const id = scene.id;
  scene.motion = document.getElementById(`motion-${id}`)?.value?.trim() || scene.motion;
  scene.overlay = document.getElementById(`overlay-${id}`)?.value?.trim() || scene.overlay;
  scene.overlayPos = document.getElementById(`overlayPos-${id}`)?.value || scene.overlayPos;
  scene.overlayStyle = document.getElementById(`overlayStyle-${id}`)?.value || scene.overlayStyle || 'clean';
  scene.overlaySize = document.getElementById(`overlaySize-${id}`)?.value || scene.overlaySize || 'medium';
  scene.overlayAnim = document.getElementById(`overlayAnim-${id}`)?.value || scene.overlayAnim || 'fade';
  scene.duration = document.getElementById(`duration-${id}`)?.value || scene.duration;

  // Product scenes get conservative motion to preserve product integrity
  const motionPrompt = scene.isProduct
    ? 'static product shot, very subtle lighting shift, no morphing or deformation'
    : scene.motion;

  setVidStage(i, 'running', scene.isProduct ? 'Animating (conservative)...' : 'Animating...', 10);
  const vidResult = await falRun('fal-ai/bytedance/seedance/v1/lite/image-to-video', {
    image_url: imageUrl,
    prompt: motionPrompt,
    aspect_ratio: dims.aspect_ratio,
    duration: parseInt(scene.duration),
  }, falKey, p => setVidStage(i, 'running', scene.isProduct ? 'Animating (conservative)...' : 'Animating...', p));

  const videoUrl = vidResult?.data?.video?.url || vidResult?.video?.url;
  if (!videoUrl) throw new Error('No video URL returned');
  pipeline.totalCost += 0.18;

  setVidStage(i, 'running', 'Downloading clip...', 92);
  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error('Failed to download clip');
  const blob = await response.blob();
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
  document.getElementById('approveImagesBtn').style.display = 'none';

  // Build video stage cards
  const container = document.getElementById('videoStages');
  container.innerHTML = pipeline.sceneData.map((_, i) => createVideoStageHTML(i)).join('');
  container.style.display = 'block';

  pipeline.clipData = new Array(pipeline.sceneData.length).fill(null);

  // Generate all videos in parallel
  const results = await Promise.allSettled(
    pipeline.sceneData.map((_, i) => generateOneVideo(i))
  );

  let allOk = true;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      setVidStage(i, 'error', r.reason?.message || 'Failed', 0);
      allOk = false;
    }
  });

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
  document.getElementById('approveClipsBtn').style.display = 'none';
  document.getElementById('finalStages').style.display = 'block';

  const dims = pipeline.dims;
  const clips = pipeline.clipData.filter(Boolean);
  const workerUrl = document.getElementById('workerUrl').value.trim();
  const anthropicKey = document.getElementById('anthropicKey').value.trim();
  const businessName = document.getElementById('businessName').value.trim();
  const targetAudience = document.getElementById('targetAudience').value.trim();
  const adObjective = document.getElementById('adObjective').value;
  const offer = document.getElementById('offerHook').value.trim();

  // Reset stages
  setStage('Stitch', 'wait', 'Starting...', 0);
  setStage('Upload', 'wait', 'Waiting for stitching', 0);
  setStage('Copy', 'wait', 'Waiting', 0);
  document.getElementById('copyPanel').style.display = 'none';

  const stitchTask = (async () => {
    try {
      const finalBlob = await stitchScenes(clips, dims);
      const finalUrl = URL.createObjectURL(finalBlob);

      document.getElementById('outputSection').style.display = 'block';
      document.getElementById('previewVideo').src = finalUrl;
      document.getElementById('previewVideo').style.display = 'block';

      const ext = finalBlob.type.includes('mp4') ? 'mp4' : 'webm';
      document.getElementById('downloadFinal').href = finalUrl;
      document.getElementById('downloadFinal').setAttribute('download', `meta-ad-${Date.now()}.${ext}`);
      document.getElementById('downloadWrap').style.display = 'block';

      setStage('Stitch', 'done', `Stitched ${clips.length} scenes`, 100);

      if (workerUrl) {
        try {
          const r2Url = await uploadToR2(finalBlob, workerUrl);
          if (r2Url) {
            const dlLink = document.getElementById('downloadWorker');
            dlLink.href = r2Url;
            dlLink.style.display = 'block';
          }
        } catch (e) {
          setStage('Upload', 'error', e.message, 0);
        }
      } else {
        setStage('Upload', 'done', 'No Worker URL — skipped', 100);
      }
    } catch (e) {
      setStage('Stitch', 'error', e.message, 0);
    }
  })();

  const copyTask = (async () => {
    if (!anthropicKey) {
      setStage('Copy', 'done', 'No Anthropic key — skipped', 100);
      return;
    }
    if (!businessName) {
      setStage('Copy', 'error', 'Business name required for copy generation', 0);
      return;
    }
    try {
      setStage('Copy', 'running', 'Writing ad copy...', 30);
      const descriptions = clips.map(c => c.description);
      const copy = await generateCopy(businessName, targetAudience, adObjective, offer, descriptions, anthropicKey);
      renderCopy(copy);
      setStage('Copy', 'done', 'Ad copy ready', 100);
      pipeline.totalCost += 0.003;
    } catch (e) {
      setStage('Copy', 'error', e.message, 0);
    }
  })();

  await Promise.all([stitchTask, copyTask]);

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

  document.getElementById('pipeline').style.display = 'none';
  document.getElementById('generateBtn').disabled = false;
  document.getElementById('generateBtn').textContent = 'Generate Images';
}
