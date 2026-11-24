// Reads a Vite + React repository (a Lovable, Bolt or v0 export) and writes the fix into it.
// It touches index.html and adds files under public/. It never overwrites a file the owner already has.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HEAD_START = '<!-- citedby-static:head:start -->';
export const HEAD_END = '<!-- citedby-static:head:end -->';
export const BODY_START = '<!-- citedby-static:start';
export const BODY_END = '<!-- citedby-static:end -->';

const ROOT_OPEN = /<div\b[^>]*\bid=["']root["'][^>]*>/i;
const ENTRIES = ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx'];

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function sourceFiles(dir, out = [], depth = 0) {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) sourceFiles(p, out, depth + 1);
    else if (/\.(tsx|jsx|ts|js)$/.test(name) && st.size < 400000) out.push(p);
  }
  return out;
}

/** Static paths named in <Route path="..."> in the source ("/pricing", not "/user/:id" or "*"). */
export function routesInSource(text) {
  const out = [];
  for (const m of String(text).matchAll(/<Route\b[^>]*?\bpath=\{?["'`]([^"'`]+)["'`]/g)) {
    const p = m[1].startsWith('/') ? m[1] : `/${m[1]}`;
    if (!p.includes(':') && !p.includes('*') && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * What the fix needs to know about the repository. problems: reasons it cannot be applied (empty = it can).
 */
export function inspectRepo(dir) {
  const problems = [];
  const pkg = readJson(join(dir, 'package.json'));
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  const indexPath = join(dir, 'index.html');
  const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
  if (!pkg) problems.push('No package.json here. Give the folder that holds the app (the one with package.json and index.html).');
  else {
    if (!deps.vite) problems.push('This is not a Vite app (no "vite" in package.json). The fix is written for Vite + React exports.');
    if (!deps.react) problems.push('No "react" in package.json. The fix is written for Vite + React exports.');
  }
  if (indexHtml === null) problems.push('No index.html beside package.json.');
  else if (!ROOT_OPEN.test(indexHtml)) problems.push('index.html has no <div id="root">, so there is no known place the app replaces.');
  const entry = ENTRIES.map((e) => join(dir, e)).find((p) => existsSync(p));
  const entryText = entry ? readFileSync(entry, 'utf8') : '';
  if (/\bhydrateRoot\s*\(|\.hydrate\s*\(/.test(entryText)) problems.push('The app hydrates server-rendered HTML (hydrateRoot). Text added to index.html would not match it, so this fix does not apply.');
  const routes = [];
  for (const f of sourceFiles(join(dir, 'src'))) {
    const t = readFileSync(f, 'utf8');
    if (t.includes('<Route')) for (const r of routesInSource(t)) if (!routes.includes(r)) routes.push(r);
  }
  const pub = join(dir, 'public');
  const has = (name) => existsSync(join(pub, name));
  return {
    dir, problems, indexHtml, routes,
    stack: { vite: Boolean(deps.vite), react: Boolean(deps.react), lovable: Boolean(deps['lovable-tagger']) || /gptengineer\.js|lovable/i.test(indexHtml || '') },
    files: { robots: has('robots.txt'), sitemap: has('sitemap.xml'), llms: has('llms.txt') },
    robotsText: has('robots.txt') ? readFileSync(join(pub, 'robots.txt'), 'utf8') : '',
  };
}

function stripBetween(html, start, end) {
  let out = html;
  for (;;) {
    const a = out.indexOf(start);
    if (a < 0) return out;
    const b = out.indexOf(end, a);
    if (b < 0) return out;
    const lineStart = out.lastIndexOf('\n', a) + 1;
    const from = out.slice(lineStart, a).trim() === '' ? lineStart : a;
    let to = b + end.length;
    if (out[to] === '\r') to += 1;
    if (out[to] === '\n') to += 1;
    out = out.slice(0, from) + out.slice(to);
  }
}

const NO_FLASH = [
  '<script>document.documentElement.classList.add("citedby-js")</script>',
  '<style>#citedby-static{max-width:44rem;margin:0 auto;padding:1.5rem;font:16px/1.6 system-ui,sans-serif}.citedby-js #citedby-static{visibility:hidden;animation:citedby-show 0s 6s forwards}@keyframes citedby-show{to{visibility:visible}}</style>',
];

/**
 * Puts the static text inside <div id="root"> and the head block before </head>. Running it again replaces the earlier blocks.
 * staticInner: HTML for the block; jsonLd: object or null; note: one line for the comment (where and when the text was read).
 */
export function patchIndexHtml(html, { staticInner, jsonLd = null, note = '' }) {
  let out = stripBetween(stripBetween(html, HEAD_START, HEAD_END), BODY_START, BODY_END);
  const nl = out.includes('\r\n') ? '\r\n' : '\n';
  const indent = (s, pad) => s.split('\n').map((l) => (l ? pad + l : l)).join(nl);
  const head = [HEAD_START, ...NO_FLASH];
  if (jsonLd) head.push(`<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`);
  head.push(HEAD_END);
  const headClose = out.search(/<\/head\s*>/i);
  if (headClose < 0) throw new Error('index.html has no </head>.');
  const headLineStart = out.lastIndexOf('\n', headClose) + 1;
  const headPad = out.slice(headLineStart, headClose).trim() === '' ? out.slice(headLineStart, headClose) : '';
  out = out.slice(0, headLineStart) + (headPad ? '' : out.slice(headLineStart, headClose) + nl) + indent(head.join('\n'), `${headPad}  `) + nl + headPad + out.slice(headClose);

  const m = ROOT_OPEN.exec(out);
  if (!m) throw new Error('index.html has no <div id="root">.');
  const at = m.index + m[0].length;
  const rootLineStart = out.lastIndexOf('\n', m.index) + 1;
  const rootPad = out.slice(rootLineStart, m.index).trim() === '' ? out.slice(rootLineStart, m.index) : '';
  const safeNote = String(note).replace(/--+/g, '-').replace(/>/g, '');
  const body = [`${BODY_START} ${safeNote} -->`, '<div id="citedby-static">', staticInner, '</div>', BODY_END].join('\n');
  const rest = out.slice(at);
  const ws = /^[ \t\r\n]*/.exec(rest)[0];
  const tailPad = ws.includes('\n') ? ws.slice(ws.lastIndexOf('\n') + 1) : rootPad;
  out = out.slice(0, at) + nl + indent(body, `${rootPad}  `) + nl + tailPad + rest.slice(ws.includes('\n') ? ws.length : 0);
  return out;
}

/** AI-search crawlers the owner's robots.txt shuts out of the whole site (a plain reading of "User-agent" groups with "Disallow: /"). */
export function blockedBots(robotsText, bots = ['OAI-SearchBot', 'GPTBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Bingbot']) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(robotsText || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], disallowAll: false, allowRoot: false }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === 'disallow' && val === '/') cur.disallowAll = true;
      if (key === 'allow' && val === '/') cur.allowRoot = true;
    }
  }
  const star = groups.find((g) => g.agents.includes('*'));
  return bots.filter((b) => {
    const g = groups.find((x) => x.agents.includes(b.toLowerCase())) || star;
    return Boolean(g && g.disallowAll && !g.allowRoot);
  });
}

/**
 * The files to write. texts: { indexHtml, robots, sitemap, llms } (robots, sitemap and llms are written only where the repository has none).
 * Returns [{ path, action: 'change' | 'add' | 'keep', content?, why }].
 */
export function planFiles(info, texts, origin) {
  const plan = [{ path: 'index.html', action: 'change', content: texts.indexHtml, why: 'the text of the site inside `<div id="root">`, and Organization data in the head' }];
  if (info.files.sitemap) plan.push({ path: 'public/sitemap.xml', action: 'keep', why: 'already there' });
  else plan.push({ path: 'public/sitemap.xml', action: 'add', content: texts.sitemap, why: 'the pages of the site, for crawlers' });
  if (!info.files.robots) plan.push({ path: 'public/robots.txt', action: 'add', content: texts.robots, why: 'lets every crawler in and names the sitemap' });
  else if (!/^\s*sitemap\s*:/im.test(info.robotsText) && !info.files.sitemap) {
    plan.push({ path: 'public/robots.txt', action: 'change', content: `${info.robotsText.replace(/\s*$/, '')}\n\nSitemap: ${origin}/sitemap.xml\n`, why: 'your rules are kept; one line names the new sitemap' });
  } else plan.push({ path: 'public/robots.txt', action: 'keep', why: 'already there' });
  if (info.files.llms) plan.push({ path: 'public/llms.txt', action: 'keep', why: 'already there' });
  else plan.push({ path: 'public/llms.txt', action: 'add', content: texts.llms, why: 'a short plain-text list of the pages (optional file)' });
  return plan;
}

export function applyPlan(dir, plan) {
  const written = [];
  for (const f of plan) {
    if (f.action === 'keep') continue;
    const p = join(dir, f.path);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, f.content);
    written.push(f.path);
  }
  return written;
}
