# Meta Ad Generator — Technical Specification

## Overview

A general-purpose multi-scene Facebook/Meta video ad generator. Produces a single stitched video (15-20 seconds) from 3-4 animated scenes with per-scene text overlays and Facebook ad copy.

**Not tied to any industry, product, or vertical.** All inputs are freeform text.

## What It Produces

- A 15-20 second video ad made of 3-4 scenes with crossfade transitions
- Per-scene text overlays burned into the video (readable with sound off)
- Facebook ad copy: primary text, headline, description, CTA button text, scroll-stop hook
- Video uploaded to R2 with a signed download URL

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser (GitHub Pages — static HTML/JS, no build step)  │
│                                                          │
│  1. User fills in global settings + 3-4 scene cards      │
│  2. Per scene: Flux Schnell (image) → Seedance (video)   │
│  3. Canvas stitching: play clips sequentially with        │
│     crossfade transitions, burn text overlays             │
│  4. MediaRecorder captures final composite video          │
│  5. Upload final blob to CF Worker → R2                   │
│  6. Anthropic API call for Facebook ad copy (direct)      │
└────────────────────┬─────────────────────────────────────┘
                     │ POST /upload (video blob)
                     ▼
┌──────────────────────────────────────────────────────────┐
│  Cloudflare Worker (lightweight — no video processing)   │
│                                                          │
│  - Receives video blob via POST                          │
│  - Stores in R2 bucket                                   │
│  - Returns signed download URL (24h expiry)              │
│  - CORS headers for GitHub Pages origin                  │
└──────────────────────────────────────────────────────────┘
```

### Why Client-Side Stitching?

FFmpeg WASM does not work in Cloudflare Workers (no Web Workers API, no SharedArrayBuffer, 128MB memory limit). The browser's Canvas + MediaRecorder API handles stitching, crossfade, and text overlay rendering natively with zero extra dependencies.

## Pipeline (Step by Step)

### Phase 1 — Scene Generation (parallel per scene)

For each of the 3-4 scenes:

1. **Image**: Either user uploads an image, or generate via fal.ai Flux Schnell (`fal-ai/flux/schnell`)
2. **Video**: Animate the image via fal.ai Seedance Lite (`fal-ai/bytedance/seedance/v1/lite/image-to-video`) using the user's motion prompt
3. Result: one video clip URL per scene (5s each)

All scenes are generated in parallel to minimize total wait time.

### Phase 2 — Client-Side Stitching

1. Fetch all scene clip blobs from fal.ai URLs
2. Create hidden `<video>` elements for each clip
3. Set up a `<canvas>` at the target resolution
4. Play clips sequentially on the canvas:
   - Each clip plays for its full duration
   - During the last 0.5s of clip N and first 0.5s of clip N+1, blend both frames (crossfade)
   - Draw the scene's text overlay at its configured position with fade-in/fade-out
5. `MediaRecorder` captures the canvas stream at 30fps
6. Output: a single video blob (WebM VP9 or MP4 if browser supports)

### Phase 3 — Upload & Copy (parallel)

1. **Upload**: POST the video blob to the CF Worker → R2 → signed URL returned
2. **Ad Copy**: Call Anthropic API directly from browser with all scene descriptions → structured JSON response

## Frontend Specification

### Global Settings Card

| Field | Type | Notes |
|-------|------|-------|
| fal.ai API Key | password input | Session-only, never stored |
| Anthropic API Key | password input | Session-only, optional (skips copy if empty) |
| Business/Product Name | text input | Free text, used in copy generation |
| Target Audience | text input | Free text, e.g. "small business owners aged 25-45" |
| Ad Objective | select | Awareness / Consideration / Conversion |
| Offer or Hook | text input | Optional, e.g. "50% off first month" |
| Ad Format | select | 16:9 (Landscape) / 9:16 (Stories/Reels) / 1:1 (Square) |
| Worker URL | text input | URL of deployed CF Worker, persisted in localStorage |

### Scene Cards (3-4, dynamic)

Each scene card has:

| Field | Type | Notes |
|-------|------|-------|
| Image Source | radio | "Generate with AI" / "Upload image" |
| Scene Description | textarea | What the image should show (used as Flux prompt when generating) |
| Upload Image | file input | Shown when "Upload image" selected |
| Motion Prompt | text input | How the scene should move, e.g. "slow zoom in, particles floating" |
| Overlay Text | text input | Text burned into this scene's portion of the video |
| Overlay Position | select | Top / Centre / Bottom |
| Duration | select | 5s / 8s / 10s per scene |

- Minimum 3 scenes, maximum 4
- "Add Scene" button (disabled at 4)
- "Remove" button on each card (disabled at 3)
- Scenes are numbered and can be reordered (drag handle or up/down buttons)

### Pipeline Progress UI

One progress stage per scene (Image → Video), then:
- Stitching stage (canvas render progress %)
- Upload stage (R2)
- Ad Copy stage (Claude)

Each stage shows: name, status badge (Waiting/Running/Done/Error), progress bar, status message.

### Output Section

- Video preview player
- Download button (final video with overlays)
- Download raw clips button (individual scene clips without overlay)
- Ad copy blocks (primary text, headline, description, CTA, hook) each with copy button
- Estimated cost breakdown

## Cloudflare Worker Specification

### Endpoint: `POST /upload`

**Request:**
- Content-Type: `video/webm` or `video/mp4` (raw body = video blob)
- Header `X-Filename`: optional filename hint

**Response:**
```json
{
  "url": "https://r2-bucket.example.com/ads/abc123.webm?X-Amz-...",
  "key": "ads/abc123.webm",
  "expiresIn": 86400
}
```

**Logic:**
1. Generate a unique key: `ads/{timestamp}-{random}.{ext}`
2. PUT the blob into R2
3. Generate a presigned GET URL (24h expiry)
4. Return the URL

### Endpoint: `GET /health`

Returns `{ "ok": true }` for smoke testing.

### CORS

- `Access-Control-Allow-Origin`: configured via environment variable (GitHub Pages URL)
- `Access-Control-Allow-Methods`: `POST, GET, OPTIONS`
- `Access-Control-Allow-Headers`: `Content-Type, X-Filename`
- Preflight handling for OPTIONS requests

### Environment / Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `AD_VIDEOS` | R2 Bucket | Stores output videos |
| `ALLOWED_ORIGIN` | Variable | GitHub Pages URL for CORS |

### wrangler.toml

```toml
name = "meta-ad-worker"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "AD_VIDEOS"
bucket_name = "meta-ad-videos"

[vars]
ALLOWED_ORIGIN = "https://satwinder6510.github.io"
```

## Video Stitching — Technical Detail

### Canvas Rendering Loop

```
Timeline (3 scenes × 5s each, 0.5s crossfade overlap):

Scene 1: |████████████████████|·····
Scene 2:                 ·····|████████████████████|·····
Scene 3:                                      ·····|████████████████████|

Total:   14s (15s minus two 0.5s overlaps)

Crossfade regions: blend alpha of outgoing/incoming frames
Text overlays: per-scene, fade in over first 0.5s, fade out over last 0.5s
```

### Resolution Mapping

| Format | Canvas Size | Flux `image_size` | Seedance `aspect_ratio` |
|--------|-------------|-------------------|------------------------|
| 16:9 | 1280×720 | landscape_16_9 | 16:9 |
| 9:16 | 720×1280 | portrait_16_9 | 9:16 |
| 1:1 | 1080×1080 | square_hd | 1:1 |

### Text Overlay Rendering

- Font: system sans-serif, bold, size = canvas width × 0.05
- Semi-transparent dark background pill behind text
- Positions: top (14% from top), centre (50%), bottom (86% from top)
- Fade in/out: 0.3s alpha transition at start/end of each scene
- White text with dark shadow for readability on any background

## Facebook Ad Copy Generation

### Prompt Template

```
You are an expert Facebook ad copywriter.

Write Facebook ad copy for this video ad:

Business/Product: {businessName}
Target Audience: {targetAudience}
Ad Objective: {adObjective}
Offer/Hook: {offer}

The video ad has these scenes:
Scene 1: {scene1Description}
Scene 2: {scene2Description}
Scene 3: {scene3Description}
[Scene 4: {scene4Description}]

Return ONLY valid JSON:
{
  "primaryText": "Main ad copy, 2-3 sentences, emotional, ends with CTA",
  "headline": "Punchy headline, max 7 words",
  "description": "One benefit line, max 12 words",
  "cta": "One of: Book Now, Learn More, Shop Now, Sign Up, Get Offer, Contact Us",
  "hook": "Opening 3-4 words that stop the scroll"
}
```

### API Call

- Model: `claude-sonnet-4-20250514`
- Max tokens: 600
- Called directly from browser (user's own API key)

## Cost Estimate Per Ad

| Item | Cost |
|------|------|
| Flux Schnell × 3-4 images | ~$0.01 total |
| Seedance Lite × 3-4 clips | ~$0.54-0.72 (at ~$0.18/clip) |
| Claude Sonnet (copy) | ~$0.003 |
| Canvas stitching | Free (client-side) |
| R2 storage | Free tier covers thousands of ads |
| **Total per ad** | **~$0.55-0.73** |

## Repo Structure

```
/
├── index.html          # UI — all markup and styles
├── app.js              # Frontend logic — pipeline, canvas stitching, fal.ai, Claude
├── worker/
│   ├── src/
│   │   └── index.ts    # CF Worker — R2 upload + signed URL
│   ├── wrangler.toml   # Worker config with R2 binding
│   ├── package.json    # Worker dependencies (wrangler only)
│   └── tsconfig.json   # TypeScript config
├── SPEC.md             # This file
└── README.md           # Setup and deployment guide
```

## Setup Requirements

### Prerequisites

1. **fal.ai account** — API key from https://fal.ai/dashboard/keys
2. **Anthropic account** — API key from https://console.anthropic.com/keys (optional, for copy)
3. **Cloudflare account** — free tier is sufficient
4. **GitHub account** — for hosting the frontend via GitHub Pages

### Deployment Steps

1. **Create R2 bucket**: `wrangler r2 bucket create meta-ad-videos`
2. **Deploy Worker**: `cd worker && npm install && npx wrangler deploy`
3. **Set ALLOWED_ORIGIN**: Update `wrangler.toml` with your GitHub Pages URL
4. **Enable GitHub Pages**: Repo Settings → Pages → Source: main branch, root directory
5. **Enter Worker URL**: In the app's settings, paste the deployed Worker URL

### Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `ALLOWED_ORIGIN` | wrangler.toml [vars] | CORS origin for GitHub Pages |
| R2 bucket binding | wrangler.toml [[r2_buckets]] | Storage for output videos |

No secrets needed on the Worker — all API keys live in the browser session only.
