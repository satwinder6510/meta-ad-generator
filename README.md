# Meta Ad Generator

Multi-scene video ad generator for Facebook and Instagram. Produces a 15-20 second stitched video from 3-4 AI-generated scenes with text overlays and ad copy.

## What it produces

- A multi-scene video ad with crossfade transitions between scenes
- Per-scene text overlays burned into the video (readable with sound off)
- Facebook ad copy: primary text, headline, description, CTA, scroll-stop hook
- Hosted download link via Cloudflare R2

## Pipeline

```
Per scene:  Flux Schnell (image) → Seedance Lite (animated video)
                              ↓
            Canvas stitching (crossfade transitions + text overlays)
                              ↓
            MediaRecorder → final video blob
                              ↓
            Upload to R2 → signed download URL
            Claude → Facebook ad copy
```

## Cost per ad

| Item | Cost |
|------|------|
| Flux Schnell x 3-4 images | ~$0.01 |
| Seedance Lite x 3-4 clips | ~$0.54-0.72 |
| Claude Sonnet (ad copy) | ~$0.003 |
| Canvas stitching | Free (browser) |
| R2 storage | Free tier |
| **Total** | **~$0.55-0.73** |

## Setup

### 1. API Keys

| Key | Get it from | Required |
|-----|-------------|----------|
| fal.ai | https://fal.ai/dashboard/keys | Yes |
| Anthropic | https://console.anthropic.com/keys | Optional (for ad copy) |

Keys are entered in the browser at runtime. Never stored permanently, never sent anywhere except their respective APIs.

### 2. Create R2 Bucket

```bash
# Install Wrangler if you don't have it
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create the R2 bucket
wrangler r2 bucket create meta-ad-videos
```

### 3. Deploy the Worker

```bash
cd worker
npm install

# Update wrangler.toml:
# - Set ALLOWED_ORIGIN to your GitHub Pages URL
# e.g. "https://yourusername.github.io"

npx wrangler deploy
```

The deploy output will show your Worker URL (e.g. `https://meta-ad-worker.youraccount.workers.dev`).

### 4. Enable GitHub Pages

1. Push this repo to GitHub
2. Go to repo **Settings → Pages**
3. Source: **Deploy from a branch**
4. Branch: **main**, folder: **/ (root)**
5. Click Save

Your site will be live at `https://yourusername.github.io/meta-ad-generator/`.

### 5. Configure the App

Open the app in your browser and enter:
- Your fal.ai API key
- Your Anthropic API key (optional)
- Your Worker URL (from step 3)

The Worker URL is saved in localStorage so you don't need to re-enter it.

## Local Development

```bash
# Python (built-in)
python -m http.server 8080

# Or Node
npx serve .

# Then open http://localhost:8080
```

Do NOT open `index.html` as a `file://` URL — browsers block API calls from local files.

For the Worker:
```bash
cd worker
npx wrangler dev
```

## Environment Variables (Worker)

| Variable | Set in | Purpose |
|----------|--------|---------|
| `ALLOWED_ORIGIN` | `wrangler.toml` [vars] | CORS origin for your GitHub Pages URL |
| `AD_VIDEOS` | `wrangler.toml` [[r2_buckets]] | R2 bucket binding for video storage |

No secrets needed on the Worker. All API keys stay in the browser.

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI — all markup and styles |
| `app.js` | Pipeline logic — fal.ai, canvas stitching, Claude copy |
| `worker/src/index.ts` | Cloudflare Worker — R2 upload + download |
| `worker/wrangler.toml` | Worker configuration |
| `SPEC.md` | Technical specification |
| `README.md` | This file |

## Customisation

### Video models

In `app.js`, find the fal.ai endpoint strings to swap models:

- Image: `fal-ai/flux/schnell` → `fal-ai/flux/dev` (higher quality, slower)
- Video: `fal-ai/bytedance/seedance/v1/lite/image-to-video` → replace with:
  - `fal-ai/bytedance/seedance/v1/pro/image-to-video` (~$0.62/clip)
  - `fal-ai/kling-video/v2.1/pro/image-to-video` (~$0.49/clip)

### Crossfade duration

In `app.js`, change `CROSSFADE_DURATION` (default: 0.5 seconds).

### Ad copy model

In `app.js`, find `claude-sonnet-4-20250514` and replace with any Anthropic model ID.
