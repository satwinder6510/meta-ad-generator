# River Cruise Ad Generator

AI-powered Meta ad creative tool. Generates a complete Facebook video ad in ~3 minutes for under $0.20.

## Pipeline

```
Brief → Flux Dev (image) → Seedance Lite (video) → Canvas (text overlay) → Claude (copy)
```

## What it produces

- A 5-second MP4 video with text overlays burned in
- Facebook ad copy: primary text, headline, description, CTA, scroll-stop hook
- Cost per ad: ~$0.18 (image + video via fal.ai)

## Setup

### API Keys needed

| Key | Get it from |
|-----|-------------|
| fal.ai | https://fal.ai/dashboard/keys |
| Anthropic | https://console.anthropic.com/keys |

Keys are entered in the browser at runtime — never stored, never committed.

## Deploy to Cloudflare Pages

1. Push this repo to GitHub
2. Go to Cloudflare Pages → Create application → Connect to Git
3. Select this repo
4. Build settings:
   - Framework preset: **None**
   - Build command: *(leave blank)*
   - Build output directory: `/`
5. Click Save and Deploy

That's it — Cloudflare Pages serves static HTML with no build step needed.

## Local development

```bash
# Python (no install needed)
python -m http.server 8080
# Then open http://localhost:8080

# Or Node
npx serve .
```

Do NOT open index.html directly as a file:// URL — browsers block API calls from local files.

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI layout and styles |
| `app.js` | Pipeline logic — fal.ai, canvas overlay, Claude copy |
| `README.md` | This file |

## Customisation

### Change the video model
In `app.js`, find `fal-ai/bytedance/seedance/v1/lite/image-to-video` and replace with:
- `fal-ai/bytedance/seedance/v1/pro/image-to-video` — higher quality, ~$0.62/video
- `fal-ai/kling-video/v2.1/pro/image-to-video` — cinematic quality, ~$0.49/video

### Change the image model
In `app.js`, find `fal-ai/flux/dev` and replace with:
- `fal-ai/flux/schnell` — faster, slightly lower quality, cheaper

### Add more destinations
The destination field is freetext — any river/location works.
Prompt engineering is in `app.js` in the `startPipeline()` function.

### Overlay timing
Currently: line1 = 0–2s, line2 = 2–4s, line3 = 4–5s.
To change, edit the `drawTextOverlay` calls in `burnTextIntoVideo()` in `app.js`.

## Notes

- Output format is WebM (browser-native). Facebook accepts WebM.
- For MP4 conversion use cloudconvert.com (free tier available)
- MediaRecorder renders in real time — overlay step takes ~10–15 seconds
