// Runs inside the page (sent to the browser as source text), after the site's own scripts have drawn it.
// Returns the text a visitor sees, in reading order, as plain blocks: headings, paragraphs and list items.
// It must stay self-contained: no imports, no outer variables.

export async function extractPage(opts) {
  const maxBlocks = (opts && opts.maxBlocks) || 400;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const INLINE = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents', 'ruby', 'ruby-text']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'SELECT', 'OPTION', 'TEXTAREA', 'INPUT', 'HEAD', 'OBJECT']);
  const SOCIAL = /(^|\.)(x\.com|twitter\.com|linkedin\.com|instagram\.com|facebook\.com|youtube\.com|tiktok\.com|github\.com|threads\.net|bsky\.app|pinterest\.com|t\.me|discord\.gg|discord\.com|medium\.com|producthunt\.com)$/i;

  const shown = (el) => {
    if (SKIP.has(el.tagName)) return false;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.tagName === 'DIALOG' && !el.hasAttribute('open')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) return false; // screen-reader-only labels
    }
    return true;
  };
  const isBlock = (el) => !INLINE.has(getComputedStyle(el).display);

  // Post-order: does this element hold a block element with text somewhere below it?
  const holdsBlock = new WeakMap();
  const mark = (el) => {
    let any = false;
    for (const c of el.children) {
      if (!shown(c)) continue;
      const below = mark(c);
      if (below || (isBlock(c) && clean(c.innerText))) any = true;
    }
    holdsBlock.set(el, any);
    return any;
  };

  const region = (el) => {
    const r = el.closest('nav,[role="navigation"],footer,[role="contentinfo"],header,[role="banner"]');
    if (!r) return 'main';
    const t = r.tagName.toLowerCase();
    const role = r.getAttribute('role');
    if (t === 'nav' || role === 'navigation') return 'nav';
    if (t === 'footer' || role === 'contentinfo') return 'footer';
    return 'header';
  };
  const tagFor = (el) => {
    const h = el.closest('h1,h2,h3,h4,h5,h6,[role="heading"]');
    if (h) {
      if (/^H[1-6]$/.test(h.tagName)) return h.tagName.toLowerCase();
      const lvl = parseInt(h.getAttribute('aria-level') || '2', 10);
      return 'h' + Math.min(6, Math.max(1, lvl || 2));
    }
    if (el.closest('li')) return 'li';
    return 'p';
  };
  const hrefOf = (a) => {
    try {
      const u = new URL(a.getAttribute('href'), location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch (e) { return null; }
  };

  // Answers a visitor opens with one click (FAQ accordions, <details>) are page text too: open them before reading.
  for (const d of document.querySelectorAll('details:not([open])')) d.open = true;
  const closed = [...document.querySelectorAll('button[aria-expanded="false"][aria-controls]')].filter((b) => b.closest('h1,h2,h3,h4,h5,h6,[data-orientation]') && !b.closest('nav,header,[role="navigation"],[role="menubar"]'));
  for (const b of closed.slice(0, 60)) { try { b.click(); } catch (e) { /* leave it closed */ } }
  if (closed.length) await new Promise((r) => setTimeout(r, 400));

  const blocks = [];
  const seen = new Set();
  const push = (el, text) => {
    for (const line of String(text || '').split('\n')) {
      const t = clean(line);
      if (t.length < 2 || blocks.length >= maxBlocks) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue; // carousels and mobile menus repeat the same line
      seen.add(key);
      const b = { tag: tagFor(el), region: region(el), text: t };
      const inner = el.querySelectorAll('a[href]');
      const a = el.closest('a[href]') || (inner.length === 1 && clean(inner[0].innerText) === t ? inner[0] : null);
      const u = a && hrefOf(a);
      if (u) b.href = u.origin === location.origin ? u.pathname + u.search : u.href;
      blocks.push(b);
    }
  };
  const walk = (el) => {
    if (!shown(el)) return;
    if (/^H[1-6]$/.test(el.tagName)) { push(el, el.innerText); return; }
    // A control with a short label ("Search", "Close", "Read more") is not page text; a whole card that is a button is.
    if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && clean(el.innerText).split(' ').length <= 4) return;
    if (!holdsBlock.get(el)) {
      // A row of links with nothing between them (a menu) is one line per link, not one run-on line.
      const as = el.tagName === 'A' ? [] : [...el.querySelectorAll('a[href]')];
      const bare = (t) => (t || '').replace(/\s+/g, '');
      if (as.length >= 2 && bare(as.map((a) => a.innerText).join('')) === bare(el.innerText)) { for (const a of as) push(a, a.innerText); return; }
      push(el, el.innerText);
      return;
    }
    for (const n of el.childNodes) {
      if (n.nodeType === 1) walk(n);
      else if (n.nodeType === 3 && clean(n.nodeValue)) push(el, n.nodeValue);
    }
  };
  if (document.body) { mark(document.body); walk(document.body); }

  const meta = (sel) => clean((document.querySelector(sel) || {}).content);
  const links = [];
  const sameAs = [];
  let email = '';
  let phone = '';
  for (const a of document.querySelectorAll('a[href]')) {
    const raw = a.getAttribute('href') || '';
    if (/^mailto:/i.test(raw)) { if (!email) email = clean(raw.slice(7).split('?')[0]); continue; }
    if (/^tel:/i.test(raw)) {
      const num = clean(raw.slice(4).replace(/^\/+/, ''));
      if (!phone && num.replace(/\D/g, '').length >= 7) phone = num; // not a short emergency number
      continue;
    }
    const u = hrefOf(a);
    if (!u) continue;
    if (u.origin === location.origin) {
      const text = clean(a.innerText) || clean(a.getAttribute('aria-label')) || clean(a.title);
      links.push({ path: u.pathname, text });
    } else if (SOCIAL.test(u.hostname) && u.pathname.length > 1 && !sameAs.includes(u.href)) {
      sameAs.push(u.href);
    }
  }
  const icons = [...document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]')].map((l) => {
    try { return { rel: l.rel, href: new URL(l.getAttribute('href'), location.href).href, sizes: l.getAttribute('sizes') || '' }; } catch (e) { return null; }
  }).filter(Boolean);
  const bodyText = clean(document.body ? document.body.innerText : '');
  return {
    url: location.href,
    origin: location.origin,
    path: location.pathname,
    title: clean(document.title),
    description: meta('meta[name="description"]'),
    siteName: meta('meta[property="og:site_name"]'),
    ogImage: meta('meta[property="og:image"]'),
    lang: clean(document.documentElement.getAttribute('lang')),
    renderedWords: bodyText ? bodyText.split(' ').length : 0,
    blocks, links, sameAs, email, phone, icons,
  };
}
