const express = require('express');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|svg)(\?[^]*)?$/i;
const VIDEO_EXT = /\.(mp4|webm|ogg|mov)(\?[^]*)?$/i;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function go(url, opts = {}) {
  return fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': UA, ...opts.headers },
    ...opts
  });
}

function getEmbedId(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace('www.', '');
    if (h === 'youtu.be') return { site: 'youtube', id: u.pathname.slice(1).split('?')[0] };
    if (h === 'youtube.com') {
      if (u.pathname === '/watch') return { site: 'youtube', id: u.searchParams.get('v') };
      if (u.pathname.startsWith('/shorts/')) return { site: 'youtube', id: u.pathname.split('/')[2] };
      if (u.pathname.startsWith('/embed/')) return { site: 'youtube', id: u.pathname.split('/')[2] };
    }
    if (h === 'vimeo.com') {
      const m = u.pathname.match(/^\/(\d+)/);
      if (m) return { site: 'vimeo', id: m[1] };
    }
  } catch {}
  return null;
}

async function extractFromUrl(url) {
  if (IMAGE_EXT.test(url)) return [{ type: 'image', url, title: '' }];
  if (VIDEO_EXT.test(url)) return [{ type: 'video', url, title: '' }];

  const embed = getEmbedId(url);
  if (embed?.site === 'youtube' && embed.id) {
    return [{
      type: 'iframe',
      url: `https://www.youtube.com/embed/${embed.id}?autoplay=1&rel=0`,
      thumb: `https://img.youtube.com/vi/${embed.id}/mqdefault.jpg`,
      title: ''
    }];
  }
  if (embed?.site === 'vimeo' && embed.id) {
    return [{
      type: 'iframe',
      url: `https://player.vimeo.com/video/${embed.id}?autoplay=1`,
      thumb: '',
      title: ''
    }];
  }

  if (/reddit\.com/.test(url)) return extractReddit(url);
  return extractGeneric(url);
}

async function extractReddit(url) {
  const jsonUrl = url.replace(/\/$/, '').split('?')[0] + '.json';
  const res = await go(jsonUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);

  const [listing] = await res.json();
  const post = listing.data.children[0].data;
  const items = [];

  if (post.is_gallery && post.media_metadata) {
    const ids = post.gallery_data?.items?.map(i => i.media_id) ?? Object.keys(post.media_metadata);
    for (const id of ids) {
      const meta = post.media_metadata[id];
      if (meta?.status !== 'valid') continue;
      const ext = (meta.m ?? 'image/jpeg').split('/')[1];
      items.push({ type: 'image', url: `https://i.redd.it/${id}.${ext}`, title: post.title });
    }
  } else if (post.is_video && post.media?.reddit_video?.fallback_url) {
    items.push({ type: 'video', url: post.media.reddit_video.fallback_url, title: post.title });
  } else if (post.url && IMAGE_EXT.test(post.url)) {
    items.push({ type: 'image', url: post.url, title: post.title });
  } else if (post.preview?.images?.[0]) {
    const src = post.preview.images[0].source.url.replace(/&amp;/g, '&');
    items.push({ type: 'image', url: src, title: post.title });
  }

  return items;
}

async function extractGeneric(url) {
  const res = await go(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const ct = res.headers.get('content-type') ?? '';
  if (ct.startsWith('image/')) return [{ type: 'image', url, title: '' }];
  if (ct.startsWith('video/')) return [{ type: 'video', url, title: '' }];

  const html = await res.text();
  const baseUrl = res.url;
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').text().trim() || '';

  const imgMeta =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[name="twitter:image:src"]').attr('content');

  if (imgMeta) {
    return [{ type: 'image', url: new URL(imgMeta, baseUrl).href, title }];
  }
  return [];
}

app.post('/api/extract', async (req, res) => {
  const { url } = req.body ?? {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const items = await extractFromUrl(url);
    res.json({ items });
  } catch (err) {
    console.error('[extract]', url, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url required');
  try {
    const r = await go(url);
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  PREZENTACE  →  ${url}\n`);
  const { default: open } = await import('open');
  open(url);
});
