// ─────────────────────────────────────────────
// Meta Ad Generator — app.js
// Multi-scene pipeline: per-scene (Flux + Seedance) → Canvas stitch → R2 upload → Claude copy
// ─────────────────────────────────────────────

// ── State ────────────────────────────────────

let scenes = [];
let falClient = null;
const MIN_SCENES = 3;
const MAX_SCENES = 4;
const CROSSFADE_DURATION = 0.5; // seconds

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
});

// ── Scene management ─────────────────────────

function addScene() {
  if (scenes.length >= MAX_SCENES) return;
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  scenes.push({ id });
  renderScenes();
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

      <div class="field">
        <label>Motion Prompt</label>
        <input type="text" id="motion-${scene.id}" placeholder="e.g. slow zoom in, gentle camera pan right, particles floating" />
      </div>

      <div class="grid-2">
        <div class="field">
          <label>Overlay Text</label>
          <input type="text" id="overlay-${scene.id}" placeholder="Text shown during this scene" />
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
  const isUpload = document.querySelector(`input[name="imgSrc-${id}"][value="upload"]`).checked;
  document.getElementById(`uploadField-${id}`).style.display = isUpload ? 'block' : 'none';
  document.getElementById(`aiFields-${id}`).style.display = isUpload ? 'none' : 'block';
}

function collectAllSceneValues() {
  return scenes.map(scene => {
    const id = scene.id;
    const isUpload = document.querySelector(`input[name="imgSrc-${id}"][value="upload"]`)?.checked || false;
    return {
      isUpload,
      description: document.getElementById(`desc-${id}`)?.value || '',
      motion: document.getElementById(`motion-${id}`)?.value || '',
      overlay: document.getElementById(`overlay-${id}`)?.value || '',
      overlayPos: document.getElementById(`overlayPos-${id}`)?.value || 'centre',
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
    if (document.getElementById(`duration-${id}`)) document.getElementById(`duration-${id}`).value = v.duration;
    if (v.isUpload) {
      const radio = document.querySelector(`input[name="imgSrc-${id}"][value="upload"]`);
      if (radio) { radio.checked = true; toggleSceneSource(id); }
    }
  });
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

function drawTextOverlay(ctx, text, alpha, cW, cH, position) {
  if (alpha <= 0 || !text) return;
  alpha = Math.max(0, Math.min(1, alpha));

  const fontSize = Math.round(cW * 0.048);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.font = `600 ${fontSize}px 'Inter', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = text.split('\\n');
  const lineH = fontSize * 1.4;
  let yBase;
  if (position === 'top') yBase = cH * 0.14;
  else if (position === 'bottom') yBase = cH * 0.86;
  else yBase = cH * 0.5;

  const maxW = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
  const padX = 28, padY = 12;
  const boxW = maxW + padX * 2;
  const boxH = lines.length * lineH + padY * 2;

  // Background pill
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.roundRect(cW / 2 - boxW / 2, yBase - boxH / 2, boxW, boxH, 8);
  ctx.fill();

  // Text
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#ffffff';
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
          let textAlpha = 1;
          if (localTime < overlayFade) textAlpha = localTime / overlayFade;
          if (localTime > sceneDur - overlayFade) textAlpha = (sceneDur - localTime) / overlayFade;
          textAlpha = Math.min(textAlpha, alpha);
          drawTextOverlay(ctx, clipData[i].overlay, textAlpha, canvas.width, canvas.height, clipData[i].overlayPos);
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

// ── Pipeline stage HTML generators ───────────

function createSceneStageHTML(sceneIndex, sceneCount) {
  return `
    <div class="stage" id="stageScene${sceneIndex}">
      <div class="stage-header">
        <span class="stage-name">Scene ${sceneIndex + 1} &middot; Image + Video</span>
        <span class="badge badge-wait" id="badgeScene${sceneIndex}">Waiting</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" id="progScene${sceneIndex}" style="width:0%"></div></div>
      <div class="stage-msg" id="msgScene${sceneIndex}">Ready</div>
    </div>`;
}

function setSceneStage(idx, status, msg, progress) {
  setStage('Scene' + idx, status, msg, progress);
}

// ── Main pipeline ────────────────────────────

async function startPipeline() {
  const falKey = document.getElementById('falKey').value.trim();
  const anthropicKey = document.getElementById('anthropicKey').value.trim();
  const businessName = document.getElementById('businessName').value.trim();
  const targetAudience = document.getElementById('targetAudience').value.trim();
  const adObjective = document.getElementById('adObjective').value;
  const adFormat = document.getElementById('adFormat').value;
  const offer = document.getElementById('offerHook').value.trim();
  const workerUrl = document.getElementById('workerUrl').value.trim();

  if (!falKey) { alert('Please enter your fal.ai API key'); return; }

  // Save worker URL
  if (workerUrl) localStorage.setItem('meta-ad-worker-url', workerUrl);

  // Collect scene data
  const sceneData = scenes.map(scene => {
    const id = scene.id;
    const isUpload = document.querySelector(`input[name="imgSrc-${id}"][value="upload"]`)?.checked || false;
    return {
      id,
      isUpload,
      description: document.getElementById(`desc-${id}`)?.value?.trim() || '',
      file: isUpload ? document.getElementById(`file-${id}`)?.files?.[0] : null,
      motion: document.getElementById(`motion-${id}`)?.value?.trim() || 'slow cinematic camera movement',
      overlay: document.getElementById(`overlay-${id}`)?.value?.trim() || '',
      overlayPos: document.getElementById(`overlayPos-${id}`)?.value || 'centre',
      duration: document.getElementById(`duration-${id}`)?.value || '5',
    };
  });

  // Validate
  for (let i = 0; i < sceneData.length; i++) {
    const s = sceneData[i];
    if (s.isUpload && !s.file) { alert(`Scene ${i + 1}: Please select an image to upload`); return; }
    if (!s.isUpload && !s.description) { alert(`Scene ${i + 1}: Please enter a scene description`); return; }
  }

  const dims = getFormatDims(adFormat);

  // Reset UI
  document.getElementById('generateBtn').disabled = true;
  document.getElementById('pipeline').style.display = 'block';
  document.getElementById('costBar').style.display = 'none';
  document.getElementById('previewVideo').style.display = 'none';
  document.getElementById('downloadWrap').style.display = 'none';
  document.getElementById('outputSection').style.display = 'none';
  document.getElementById('copyPanel').style.display = 'none';

  // Build scene stage UI
  const stagesContainer = document.getElementById('sceneStages');
  stagesContainer.innerHTML = sceneData.map((_, i) => createSceneStageHTML(i, sceneData.length)).join('');

  // Reset fixed stages
  setStage('Stitch', 'wait', 'Waiting for all scenes', 0);
  setStage('Upload', 'wait', 'Waiting for stitching', 0);
  setStage('Copy', 'wait', 'Waiting', 0);

  let totalCost = 0;

  // ── Phase 1: Generate all scenes in parallel ──

  const clipResults = await Promise.allSettled(sceneData.map(async (scene, i) => {
    // Step 1: Get image URL
    let imageUrl;
    if (scene.isUpload) {
      setSceneStage(i, 'running', 'Resizing image...', 5);
      imageUrl = await uploadImageToFal(scene.file, falKey, dims);
      setSceneStage(i, 'running', 'Image uploaded, generating video...', 25);
    } else {
      setSceneStage(i, 'running', 'Generating image...', 10);
      const imgResult = await falRun('fal-ai/flux/schnell', {
        prompt: scene.description,
        image_size: dims.image_size,
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      }, falKey, p => setSceneStage(i, 'running', 'Generating image...', Math.round(p * 0.3)));

      imageUrl = imgResult?.data?.images?.[0]?.url || imgResult?.images?.[0]?.url;
      if (!imageUrl) throw new Error('No image URL returned from Flux');
      totalCost += 0.003;
      setSceneStage(i, 'running', 'Image ready, generating video...', 30);
    }

    // Step 2: Animate with Seedance
    const vidResult = await falRun('fal-ai/bytedance/seedance/v1/lite/image-to-video', {
      image_url: imageUrl,
      prompt: scene.motion,
      aspect_ratio: dims.aspect_ratio,
      duration: parseInt(scene.duration),
    }, falKey, p => setSceneStage(i, 'running', 'Animating...', 30 + Math.round(p * 0.6)));

    const videoUrl = vidResult?.data?.video?.url || vidResult?.video?.url;
    if (!videoUrl) throw new Error('No video URL returned from Seedance');
    totalCost += 0.18;

    setSceneStage(i, 'running', 'Downloading clip...', 92);

    // Fetch the clip blob
    const response = await fetch(videoUrl);
    if (!response.ok) throw new Error(`Failed to fetch video clip ${i + 1}`);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    setSceneStage(i, 'done', 'Scene ready', 100);

    return {
      blobUrl,
      overlay: scene.overlay,
      overlayPos: scene.overlayPos,
      duration: scene.duration,
      description: scene.description || 'Uploaded image',
    };
  }));

  // Check for failures
  const clips = [];
  let anyFailed = false;
  for (let i = 0; i < clipResults.length; i++) {
    if (clipResults[i].status === 'rejected') {
      setSceneStage(i, 'error', clipResults[i].reason?.message || 'Failed', 0);
      anyFailed = true;
    } else {
      clips.push(clipResults[i].value);
    }
  }

  if (anyFailed || clips.length < MIN_SCENES) {
    setStage('Stitch', 'error', 'Not enough scenes completed', 0);
    document.getElementById('generateBtn').disabled = false;
    return;
  }

  // ── Phase 2: Stitch + Upload + Copy in parallel ──

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

      // Upload to R2 if worker URL provided
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
      totalCost += 0.003;
    } catch (e) {
      setStage('Copy', 'error', e.message, 0);
    }
  })();

  await Promise.all([stitchTask, copyTask]);

  document.getElementById('costValue').textContent = `~$${totalCost.toFixed(2)}`;
  document.getElementById('costBar').style.display = 'flex';
  document.getElementById('generateBtn').disabled = false;
}
