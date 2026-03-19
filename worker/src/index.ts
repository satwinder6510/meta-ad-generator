interface Env {
  AD_VIDEOS: R2Bucket;
  ALLOWED_ORIGIN: string;
}

function corsHeaders(origin: string, allowed: string): Record<string, string> {
  const isAllowed = origin === allowed || allowed === '*';
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : '',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Filename',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Health check
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ ok: true }, 200, cors);
    }

    // Proxy: fetch external URL, extract text content
    if (url.pathname === '/proxy' && request.method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl || !targetUrl.startsWith('http')) {
        return jsonResponse({ error: 'Missing or invalid url parameter' }, 400, cors);
      }
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(targetUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MetaAdBot/1.0)' },
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        // Extract title
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : '';
        // Strip scripts, styles, then all tags
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000);
        return jsonResponse({ text, title }, 200, cors);
      } catch (e: any) {
        return jsonResponse({ error: e.message || 'Fetch failed' }, 502, cors);
      }
    }

    // Upload video
    if (url.pathname === '/upload' && request.method === 'POST') {
      const contentType = request.headers.get('Content-Type') || 'video/webm';
      const filenameHint = request.headers.get('X-Filename') || '';

      // Determine extension from content type or filename
      let ext = 'webm';
      if (contentType.includes('mp4') || filenameHint.endsWith('.mp4')) ext = 'mp4';

      // Generate unique key
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 10);
      const key = `ads/${timestamp}-${random}.${ext}`;

      // Read body and upload to R2
      const body = await request.arrayBuffer();
      if (body.byteLength === 0) {
        return jsonResponse({ error: 'Empty body' }, 400, cors);
      }
      if (body.byteLength > 200 * 1024 * 1024) {
        return jsonResponse({ error: 'File too large (max 200MB)' }, 413, cors);
      }

      await env.AD_VIDEOS.put(key, body, {
        httpMetadata: { contentType },
      });

      // Generate a presigned URL (24h expiry) using R2 presigned URL support
      // R2 presign requires the object to exist, which it now does
      // Note: presigned URLs require the bucket to have a custom domain or public access
      // For simplicity, we serve the file through the Worker itself
      const downloadUrl = `${url.origin}/download/${key}`;

      return jsonResponse({ url: downloadUrl, key, expiresIn: 86400 }, 200, cors);
    }

    // Serve downloaded file from R2
    if (url.pathname.startsWith('/download/') && request.method === 'GET') {
      const key = url.pathname.replace('/download/', '');
      const object = await env.AD_VIDEOS.get(key);

      if (!object) {
        return jsonResponse({ error: 'Not found' }, 404, cors);
      }

      return new Response(object.body, {
        headers: {
          'Content-Type': object.httpMetadata?.contentType || 'video/webm',
          'Content-Disposition': `attachment; filename="${key.split('/').pop()}"`,
          'Cache-Control': 'public, max-age=86400',
          ...cors,
        },
      });
    }

    return jsonResponse({ error: 'Not found' }, 404, cors);
  },
};
