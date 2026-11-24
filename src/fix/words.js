// What a plain request reads from a page's HTML, counted the way the citedby.eu check counts it
// (comments, script, style, noscript, svg and template are not page text; tags are dropped; the rest is split on spaces).

export function visibleText(html) {
  let h = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function countWords(html) {
  const t = visibleText(html);
  return t ? t.split(' ').length : 0;
}

/** The check's levels for text in the HTML: 200 or more is OK, 50 to 199 is Check, fewer is Fix. */
export function textLevel(words) {
  return words >= 200 ? 'ok' : words >= 50 ? 'check' : 'fix';
}

const ORG_TYPES = new Set(['Organization', 'LocalBusiness', 'Store', 'OnlineStore', 'OnlineBusiness', 'CafeOrCoffeeShop', 'Corporation']);

/** Every @type found in the page's JSON-LD blocks (also inside @graph). A block that is not valid JSON is skipped. */
export function jsonLdTypes(html) {
  const types = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    for (const t of [].concat(x['@type'] ?? [])) if (typeof t === 'string') types.add(t);
    for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) if (k in x) walk(x[k]);
  };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html ?? '').matchAll(re)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* not JSON */ }
  }
  return types;
}

export function hasOrgData(html) {
  for (const t of jsonLdTypes(html)) if (ORG_TYPES.has(t)) return true;
  return false;
}
