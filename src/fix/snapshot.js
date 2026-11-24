// Turns what the browser read (extract.js) into the files the fix writes: the static text block for index.html,
// Organization data, robots.txt, sitemap.xml and llms.txt. Every word comes from the site itself; nothing is invented.

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NOT_CONTENT = /^\/(login|log-in|signin|sign-in|signup|sign-up|register|auth|admin|dashboard|account|settings|profile|cart|checkout|app|api|logout)(\/|$|-)/i;
const FILE_LIKE = /\.[a-z0-9]{2,5}$/i;
const words = (s) => (String(s || '').trim() ? String(s).trim().split(/\s+/).length : 0);
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The site's name: og:site_name, else the part of the title that matches the host name, else the first part of the title. */
export function brandName({ siteName, title, origin }) {
  if (siteName) return siteName;
  const parts = String(title || '').split(/\s+[-|–—·:]\s+|\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) {
    try { return new URL(origin).hostname.replace(/^www\./, ''); } catch { return ''; }
  }
  let label = '';
  try { label = squash(new URL(origin).hostname.replace(/^www\./, '').split('.')[0]); } catch { /* keep '' */ }
  return parts.find((p) => label && (squash(p) === label || label.includes(squash(p)) || squash(p).includes(label))) || parts[0];
}

export function isContentPath(path) {
  return typeof path === 'string' && path.startsWith('/') && path !== '/' && !path.includes(':') && !path.includes('*') && !NOT_CONTENT.test(path) && !FILE_LIKE.test(path);
}

/** Routes to read besides the home page: the ones the home page links, then the ones named in the router source. */
export function pickRoutes(home, sourceRoutes = [], max = 8) {
  const out = [];
  const add = (path, text) => {
    const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
    if (!isContentPath(p)) return;
    const found = out.find((r) => r.path === p);
    if (found) { if (!found.text && text) found.text = text; return; }
    out.push({ path: p, text: text || '' });
  };
  for (const l of home.links || []) add(l.path, l.text);
  for (const p of sourceRoutes) add(p.startsWith('/') ? p : `/${p}`, '');
  return out.slice(0, max);
}

/** A route that answers with the app's "not found" screen is not a page. */
export function looksNotFound(page) {
  const head = (page.blocks || []).slice(0, 4).map((b) => b.text).join(' ');
  return page.renderedWords < 80 && /\b404\b|not found|page introuvable|nicht gefunden|no encontrada/i.test(`${page.title} ${head}`);
}

function renderBlocks(blocks, { demote = false } = {}) {
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push(`<ul>\n${list.map((l) => `  <li>${l}</li>`).join('\n')}\n</ul>`); list = []; } };
  for (const b of blocks) {
    const inner = b.href ? `<a href="${esc(b.href)}">${esc(b.text)}</a>` : esc(b.text);
    if (b.tag === 'li') { list.push(inner); continue; }
    flush();
    let tag = b.tag;
    if (demote && /^h[1-6]$/.test(tag)) tag = `h${Math.min(6, Math.max(3, Number(tag[1]) + 1))}`;
    out.push(`<${tag}>${inner}</${tag}>`);
  }
  flush();
  return out;
}

/**
 * The static block. home: the home page as read; routes: [{ path, text, page }] for the other pages that were read.
 * Returns { html, routeSections } where html goes inside <div id="citedby-static">.
 */
export function staticHtml({ home, routes = [], routeWords = 60 }) {
  const name = brandName(home);
  const lines = [];
  const seen = new Set((home.blocks || []).map((b) => b.text.toLowerCase()));
  const labelOf = (r) => {
    const h1 = r.page && (r.page.blocks || []).find((b) => b.tag === 'h1' && b.region !== 'nav' && !seen.has(b.text.toLowerCase()));
    return r.text || (h1 && h1.text) || r.path.replace(/^\//, '').replace(/[-_/]+/g, ' ');
  };

  if (routes.length) {
    lines.push('<nav aria-label="Pages">', '<ul>', `  <li><a href="/">${esc(name || 'Home')}</a></li>`);
    for (const r of routes) lines.push(`  <li><a href="${esc(r.path)}">${esc(labelOf(r))}</a></li>`);
    lines.push('</ul>', '</nav>');
  }

  const routePaths = new Set(routes.map((r) => r.path));
  const body = (home.blocks || []).filter((b) => !(b.region === 'nav' && b.href && (b.href === '/' || routePaths.has(b.href.split('?')[0].replace(/(.)\/+$/, '$1')))));
  const main = body.filter((b) => b.region !== 'footer');
  const footer = body.filter((b) => b.region === 'footer');
  lines.push('<main>');
  if (!main.some((b) => b.tag === 'h1') && home.title) lines.push(`<h1>${esc(home.title)}</h1>`);
  lines.push(...renderBlocks(main));

  // Per route: its own heading and the lines right under it (the intro), not its lists or live data.
  const routeSections = [];
  const isHeading = (b) => /^h[1-6]$/.test(b.tag);
  for (const r of routes) {
    if (!r.page) continue;
    const own = (r.page.blocks || []).filter((b) => b.region === 'main' && !seen.has(b.text.toLowerCase()));
    const h = own.findIndex((b) => b.tag === 'h1');
    const title = h >= 0 && h <= 3 ? own[h].text : null;
    const kept = [];
    let n = 0;
    for (let i = title ? h + 1 : 0; i < own.length; i += 1) {
      if (isHeading(own[i]) || n >= routeWords) break;
      kept.push(own[i]);
      n += words(own[i].text);
    }
    if (!title && !kept.length) continue;
    for (const b of kept) seen.add(b.text.toLowerCase());
    if (title) seen.add(title.toLowerCase());
    const label = title || labelOf(r);
    routeSections.push({ path: r.path, label, words: n });
    lines.push('<section>', `<h2><a href="${esc(r.path)}">${esc(label)}</a></h2>`, ...renderBlocks(kept), '</section>');
  }
  lines.push('</main>');
  if (footer.length) lines.push('<footer>', ...renderBlocks(footer, { demote: true }), '</footer>');
  return { html: lines.join('\n'), routeSections, name, kept: [...main, ...footer] };
}

/** The description to use: the meta description when it says something, else the first full sentence of the page. */
export function describe(home) {
  const meta = home.description || '';
  if (meta.length >= 50) return { text: meta, from: 'meta description' };
  const first = (home.blocks || []).find((b) => b.tag === 'p' && b.region === 'main' && words(b.text) >= 8);
  if (first) return { text: first.text, from: 'first paragraph of the home page' };
  return meta ? { text: meta, from: 'meta description' } : { text: '', from: '' };
}

const DEFAULT_ICON = /\/(vite\.svg|placeholder\.svg|favicon\.ico)$/i;
const SHARE_LINK = /\/(share|sharer|intent)\b|[?&](u|url|text)=/i;

/** A link to the organisation's own profile, not to a video, a post or somebody's repository. */
export function isProfileUrl(href) {
  let u;
  try { u = new URL(href); } catch { return false; }
  if (SHARE_LINK.test(href)) return false;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  if (!seg.length) return false;
  if (host === 'youtube.com') return seg[0].startsWith('@') || (['channel', 'c', 'user'].includes(seg[0]) && seg.length === 2);
  if (host === 'linkedin.com') return ['company', 'in', 'school', 'showcase'].includes(seg[0]) && seg.length === 2;
  if (host === 'producthunt.com') return (seg[0] === 'products' && seg.length === 2) || seg[0].startsWith('@');
  if (host === 'discord.com') return seg[0] === 'invite' && seg.length === 2;
  return seg.length === 1 && !/^(watch|embed|share|search|explore|hashtag|home|login|signup|p|reel|status)$/i.test(seg[0]);
}

const CHECK_LINE = /\b(sample|samples|demo data|lorem|placeholder|coming soon|open now|closed now|in stock|out of stock|sold out|today|yesterday|tomorrow)\b|\b\d+\s*(units?|left|online|viewers?)\b|\b\d+\s*(min|mins|minutes|hours?|days?)\s+ago\b/i;

/** Lines in the copy that look like live or sample data: the owner should look at these before merging. */
export function linesToCheck(blocks, max = 8) {
  const out = [];
  for (const b of blocks || []) {
    if (CHECK_LINE.test(b.text) && !out.includes(b.text)) out.push(b.text);
    if (out.length >= max) break;
  }
  return out;
}

const PLATFORM_HOST = /\.(vercel\.app|netlify\.app|lovable\.app|lovableproject\.com|pages\.dev|web\.app|github\.io|bolt\.host|v0\.app|onrender\.com)$/i;
export const isPlatformHost = (origin) => { try { return PLATFORM_HOST.test(new URL(origin).hostname); } catch { return false; } };

export function orgJsonLd({ home, origin }) {
  const name = brandName(home);
  const url = `${origin}/`;
  const desc = describe(home).text;
  const icon = (home.icons || []).find((i) => !DEFAULT_ICON.test(i.href) && i.href.startsWith(origin));
  const sameAs = (home.sameAs || []).filter(isProfileUrl).map((u) => u.split('?')[0]).filter((u, i, a) => a.indexOf(u) === i);
  const org = { '@type': 'Organization', '@id': `${url}#organization`, name, url };
  if (desc) org.description = desc;
  if (icon) org.logo = icon.href;
  if (home.email) org.email = home.email;
  if (home.phone) org.telephone = home.phone;
  if (sameAs.length) org.sameAs = sameAs;
  const site = { '@type': 'WebSite', '@id': `${url}#website`, url, name, publisher: { '@id': org['@id'] } };
  if (home.lang) site.inLanguage = home.lang;
  return { '@context': 'https://schema.org', '@graph': [org, site] };
}

export function robotsTxt(origin, withSitemap = true) {
  return `User-agent: *\nAllow: /\n${withSitemap ? `\nSitemap: ${origin}/sitemap.xml\n` : ''}`;
}

export function sitemapXml(origin, paths) {
  const urls = ['/', ...paths.filter((p) => p !== '/')].map((p) => `  <url><loc>${esc(origin + p)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

export function llmsTxt({ home, origin, routes = [], routeSections = [] }) {
  const name = brandName(home);
  const desc = describe(home).text;
  const lines = [`# ${name}`, ''];
  if (desc) lines.push(`> ${desc}`, '');
  lines.push('## Pages', '', `- [${name}](${origin}/)`);
  for (const r of routes) {
    const sec = routeSections.find((s) => s.path === r.path);
    lines.push(`- [${(sec && sec.label) || r.text || r.path}](${origin}${r.path})`);
  }
  return `${lines.join('\n')}\n`;
}
