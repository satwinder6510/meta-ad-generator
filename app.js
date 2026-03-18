// ─────────────────────────────────────────────
// River Cruise Ad Generator — app.js
// Pipeline: Flux (image) → Seedance (video) → Canvas (text overlay) → Claude (copy)
// Docs: See README.md for API key setup and deployment instructions
// v3 — uses fal.ai JS client (esm.sh) to avoid CORS issues on GitHub Pages
// ─────────────────────────────────────────────

// ── Key persistence (localStorage) ───────────

const LS_FAL = 'cruise_ad_fal_key';
const LS_ANT = 'cruise_ad_anthropic_key';

function loadSavedKeys() {
  const falKey  = localStorage.getItem(LS_FAL);
  const antKey  = localStorage.getItem(LS_ANT);
  if (falKey)  document.getElementById('falKey').value       = falKey;
  if (antKey)  document.getElementById('anthropicKey').value = antKey;
  if (falKey || antKey) document.getElementById('rememberKeys').checked = true;
}

function handleRememberToggle() {
  if (!document.getElementById('rememberKeys').checked) {
    localStorage.removeItem(LS_FAL);
    localStorage.removeItem(LS_ANT);
    document.getElementById('rememberNote').textContent = 'Keys cleared from browser storage.';
    setTimeout(() => document.getElementById('rememberNote').textContent = 'Stored in browser only — never sent to any server.', 2500);
  } else {
    saveKeysIfRequired();
  }
}

function saveKeysIfRequired() {
  if (!document.getElementById('rememberKeys').checked) return;
  const fk = document.getElementById('falKey').value.trim();
  const ak = document.getElementById('anthropicKey').value.trim();
  if (fk) localStorage.setItem(LS_FAL, fk);
  if (ak) localStorage.setItem(LS_ANT, ak);
}

document.addEventListener('DOMContentLoaded', loadSavedKeys);

// ── Helpers ───────────────────────────────────

function getFormatDims(fmt) {
  if (fmt === '9:16') return { image_size: 'portrait_16_9',  aspect_ratio: '9:16', w: 720,  h: 1280 };
  if (fmt === '1:1')  return { image_size: 'square_hd',      aspect_ratio: '1:1',  w: 1080, h: 1080 };
  return               { image_size: 'landscape_16_9', aspect_ratio: '16:9', w: 1280, h: 720  };
}

function setStage(id, status, msg, progress) {
  const labels = { wait: 'Waiting', running: 'Running', done: 'Done', error: 'Error' };
  document.getElementById('badge' + id).className  = 'badge badge-' + status;
  document.getElementById('badge' + id).textContent = labels[status];
  document.getElementById('msg'   + id).textContent = msg;
  document.getElementById('prog'  + id).style.width = progress + '%';
}

// ── fal.ai client (loaded once via ESM) ───────

let falClient = null;

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
    onQueueUpdate: (update) => {
      attempt++;
      if (onProgress) onProgress(Math.min(15 + attempt * 3, 88));
    }
  });
  return result;
}

// ── Canvas text overlay ───────────────────────

function drawTextOverlay(ctx, text, currentTime, startTime, endTime, cW, cH, position) {
  if (currentTime < startTime || currentTime >= endTime) return;
  const fade = 0.3;
  let alpha = 1;
  if (currentTime < startTime + fade) alpha = (currentTime - startTime) / fade;
  if (currentTime > endTime   - fade) alpha = (endTime - currentTime)   / fade;
  alpha = Math.max(0, Math.min(1, alpha));

  const fontSize = Math.round(cW * 0.055);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.font = `600 ${fontSize}px 'DM Sans', Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = text.split('\n');
  const lineH = fontSize * 1.4;
  let yBase;
  if      (position === 'top')    yBase = cH * 0.14;
  else if (position === 'bottom') yBase = cH * 0.86;
  else                            yBase = cH * 0.5;

  const maxW = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
  const padX = 32, padY = 14;
  const boxW = maxW + padX * 2;
  const boxH = lines.length * lineH + padY * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(cW / 2 - boxW / 2, yBase - boxH / 2, boxW, boxH, 8);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  lines.forEach((line, i) => {
    ctx.fillText(line, cW / 2, yBase - ((lines.length - 1) / 2 - i) * lineH);
  });
  ctx.restore();
}

async function burnTextIntoVideo(videoUrl, overlays, dims) {
  setStage('Overlay', 'running', 'Fetching video file...', 8);
  const blob    = await fetch(videoUrl).then(r => {
    if (!r.ok) throw new Error('Could not fetch video: ' + r.status);
    return r.blob();
  });
  const blobUrl = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const video   = document.createElement('video');
    video.src     = blobUrl;
    video.muted   = true;
    video.preload = 'auto';

    video.onloadedmetadata = () => {
      const canvas  = document.getElementById('overlayCanvas');
      canvas.width  = video.videoWidth  || dims.w;
      canvas.height = video.videoHeight || dims.h;
      const ctx = canvas.getContext('2d');

      const stream   = canvas.captureStream(30);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
      const chunks   = [];

      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        URL.revokeObjectURL(blobUrl);
        resolve(new Blob(chunks, { type: mimeType }));
      };

      const duration = video.duration || 5;

      function renderFrame() {
        if (video.ended || video.currentTime >= duration - 0.05) {
          recorder.stop();
          setStage('Overlay', 'running', 'Encoding — almost done...', 92);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const t = video.currentTime;
        if (overlays[0]) drawTextOverlay(ctx, overlays[0], t, 0, 2,        canvas.width, canvas.height, 'top');
        if (overlays[1]) drawTextOverlay(ctx, overlays[1], t, 2, 4,        canvas.width, canvas.height, 'middle');
        if (overlays[2]) drawTextOverlay(ctx, overlays[2], t, 4, duration, canvas.width, canvas.height, 'bottom');
        const pct = Math.round((t / duration) * 100);
        setStage('Overlay', 'running', `Rendering frames: ${pct}%`, 20 + Math.round(pct * 0.7));
        requestAnimationFrame(renderFrame);
      }

      recorder.start();
      video.play().then(() => renderFrame()).catch(reject);
      video.onerror = () => reject(new Error('Video playback error during render'));
    };

    video.onerror = () => reject(new Error('Failed to load video for overlay render'));
    video.load();
  });
}

// ── Claude ad copy ────────────────────────────

async function generateCopy(dest, season, mood, offer, anthropicKey) {
  const offerLine = offer ? `\nOffer to highlight: ${offer}` : '';
  const prompt = `You are an expert Facebook ad copywriter specialising in luxury river cruise travel.

Write Facebook ad copy for:
- Destination/River: ${dest}
- Season: ${season}
- Mood: ${mood}${offerLine}

Return ONLY valid JSON — no markdown, no preamble:
{
  "primaryText": "Main ad copy, 2-3 sentences, emotional, ends with soft CTA",
  "headline": "Punchy headline, max 7 words",
  "description": "One benefit line, max 12 words",
  "cta": "One of: Book Now, Learn More, Get Quote, See More",
  "hook": "Opening 3-4 words that stop the scroll"
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error('Claude API error ' + res.status);
  const data = await res.json();
  const text = data.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

function renderCopy(copy) {
  const panel  = document.getElementById('copyPanel');
  const fields = [
    { label: 'Primary Text',     key: 'primaryText' },
    { label: 'Headline',         key: 'headline'    },
    { label: 'Description',      key: 'description' },
    { label: 'CTA Button',       key: 'cta'         },
    { label: 'Scroll-stop Hook', key: 'hook'        }
  ];
  panel.innerHTML = fields.map(f => `
    <div class="copy-block">
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div class="copy-label">${f.label}</div>
        <button class="copy-btn-small" onclick="copyText(this,'${(copy[f.key]||'').replace(/'/g,"\\'").replace(/\n/g,'\\n')}')">Copy</button>
      </div>
      <div class="copy-text">${copy[f.key] || ''}</div>
    </div>`).join('');
  panel.style.display = 'block';
}

function copyText(btn, text) {
  navigator.clipboard.writeText(text.replace(/\\n/g, '\n'));
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 2000);
}

// ── Main pipeline ─────────────────────────────

async function startPipeline() {
  const falKey       = document.getElementById('falKey').value.trim();
  const anthropicKey = document.getElementById('anthropicKey').value.trim();
  const destination  = document.getElementById('destination').value.trim() || 'Rhine River, Germany';
  const season       = document.getElementById('season').value;
  const format       = document.getElementById('format').value;
  const mood         = document.getElementById('mood').value;
  const offer        = document.getElementById('offer').value.trim();
  const o1           = document.getElementById('overlay1').value.trim();
  const o2           = document.getElementById('overlay2').value.trim();
  const o3           = document.getElementById('overlay3').value.trim();

  if (!falKey) { alert('Please enter your fal.ai API key'); return; }
  saveKeysIfRequired();

  const overlays    = [o1, o2, o3];
  const hasOverlays = overlays.some(o => o.length > 0);
  const dims        = getFormatDims(format);

  // Reset UI
  document.getElementById('generateBtn').disabled = true;
  document.getElementById('pipeline').style.display = 'block';
  document.getElementById('costBar').style.display = 'none';
  document.getElementById('previewImage').style.display = 'none';
  document.getElementById('previewVideo').style.display = 'none';
  document.getElementById('downloadWrap').style.display = 'none';
  document.getElementById('copyPanel').style.display = 'none';
  document.getElementById('overlayPreview').style.display = 'none';
  ['Image','Video','Overlay','Copy'].forEach(s => setStage(s, 'wait', s === 'Image' ? 'Ready' : 'Waiting', 0));

  // Show overlay timing preview
  if (hasOverlays) {
    document.getElementById('overlayTiming').innerHTML = [
      o1 ? `<div class="timing-row"><span class="timing-stamp">0s–2s</span><span>${o1}</span></div>` : '',
      o2 ? `<div class="timing-row"><span class="timing-stamp">2s–4s</span><span>${o2}</span></div>` : '',
      o3 ? `<div class="timing-row"><span class="timing-stamp">4s–5s</span><span>${o3}</span></div>` : ''
    ].join('');
    document.getElementById('overlayPreview').style.display = 'block';
  }

  let totalCost   = 0.003;
  let rawVideoUrl = null;

  // ── Stage 1: Image via Flux Dev ──────────────
  let imageUrl;
  try {
    setStage('Image', 'running', 'Submitting to Flux Dev...', 10);
    const imgResult = await falRun('fal-ai/flux/dev', {
      prompt: `luxury river cruise ship on the ${destination}, ${season}, ${mood}, passengers visible on deck, ultra-photorealistic travel photography, cinematic wide shot, 8k, --style raw, no illustration, no painting`,
      image_size: dims.image_size,
      num_inference_steps: 28,
      guidance_scale: 3.5,
      num_images: 1,
      enable_safety_checker: true
    }, falKey, p => setStage('Image', 'running', 'Generating...', p));

    imageUrl = imgResult.images?.[0]?.url;
    if (!imageUrl) throw new Error('No image URL returned from Flux');
    document.getElementById('previewImage').src = imageUrl;
    document.getElementById('previewImage').style.display = 'block';
    setStage('Image', 'done', 'Image generated', 100);
  } catch (e) {
    setStage('Image', 'error', e.message, 0);
    document.getElementById('generateBtn').disabled = false;
    return;
  }

  // ── Stage 2: Video via Seedance Lite ──────────
  try {
    setStage('Video', 'running', 'Submitting to Seedance Lite...', 10);
    const vidResult = await falRun('fal-ai/bytedance/seedance/v1/lite/image-to-video', {
      image_url: imageUrl,
      prompt: `camera slowly pans across the ${destination}, water gently rippling, soft ${season} light, smooth cinematic motion, peaceful`,
      aspect_ratio: dims.aspect_ratio,
      duration: 5
    }, falKey, p => setStage('Video', 'running', 'Animating...', p));

    rawVideoUrl = vidResult.video?.url;
    if (!rawVideoUrl) throw new Error('No video URL returned from Seedance');
    setStage('Video', 'done', '5-second video generated', 100);
    totalCost += 0.18;
  } catch (e) {
    setStage('Video', 'error', e.message, 0);
    document.getElementById('generateBtn').disabled = false;
    return;
  }

  // ── Stages 3 & 4 in parallel ─────────────────

  const overlayTask = (async () => {
    if (!hasOverlays) {
      document.getElementById('previewVideo').src = rawVideoUrl;
      document.getElementById('previewVideo').style.display = 'block';
      document.getElementById('downloadRaw').href = rawVideoUrl;
      document.getElementById('downloadWrap').style.display = 'block';
      setStage('Overlay', 'done', 'No overlays set — raw video ready', 100);
      return;
    }
    try {
      setStage('Overlay', 'running', 'Starting overlay render...', 5);
      const finalBlob = await burnTextIntoVideo(rawVideoUrl, overlays, dims);
      const finalUrl  = URL.createObjectURL(finalBlob);
      const ext = finalBlob.type.includes('mp4') ? 'mp4' : 'webm';
      document.getElementById('previewVideo').src = finalUrl;
      document.getElementById('previewVideo').style.display = 'block';
      document.getElementById('downloadFinal').href = finalUrl;
      document.getElementById('downloadFinal').setAttribute('download', `river-cruise-ad.${ext}`);
      document.getElementById('downloadRaw').href = rawVideoUrl;
      document.getElementById('downloadWrap').style.display = 'block';
      setStage('Overlay', 'done', 'Text burned in — ready to upload to Facebook', 100);
    } catch (e) {
      setStage('Overlay', 'error', e.message + ' — raw video available below', 0);
      document.getElementById('previewVideo').src = rawVideoUrl;
      document.getElementById('previewVideo').style.display = 'block';
      document.getElementById('downloadRaw').href = rawVideoUrl;
      document.getElementById('downloadWrap').style.display = 'block';
    }
  })();

  const copyTask = (async () => {
    if (!anthropicKey) {
      setStage('Copy', 'error', 'No Anthropic key provided — skipped', 0);
      return;
    }
    try {
      setStage('Copy', 'running', 'Writing ad copy with Claude...', 30);
      const copy = await generateCopy(destination, season, mood, offer, anthropicKey);
      renderCopy(copy);
      setStage('Copy', 'done', 'Copy ready', 100);
    } catch (e) {
      setStage('Copy', 'error', e.message, 0);
    }
  })();

  await Promise.all([overlayTask, copyTask]);

  document.getElementById('costValue').textContent = `~$${totalCost.toFixed(2)}`;
  document.getElementById('costBar').style.display = 'flex';
  document.getElementById('generateBtn').disabled = false;
}


// ── Expose functions to global scope (required for onclick handlers with type=module) ──
window.startPipeline     = startPipeline;
window.handleRememberToggle = handleRememberToggle;
window.copyText          = copyText;
