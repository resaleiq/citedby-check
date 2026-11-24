// citedby-check fix: reads a live site in a headless browser and writes its text into the repository's index.html,
// with robots.txt, sitemap.xml, llms.txt and Organization data where they are missing. Dry run unless --write or --pr.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { REPO_URL, VERSION } from '../check.js';
import { openBrowser } from './chrome.js';
import { openPullRequest, PrError, refusal } from './pr.js';
import { applyPlan, blockedBots, inspectRepo, patchIndexHtml, planFiles, stripFixBlocks } from './repo.js';
import { describe, isPlatformHost, linesToCheck, llmsTxt, looksNotFound, orgJsonLd, pickRoutes, robotsTxt, sitemapXml, staticHtml } from './snapshot.js';
import { countWords, hasOrgData, textLevel } from './words.js';

export const FIX_HELP = `citedby-check fix: put a JavaScript-only site's text where a plain request can read it

Usage: citedby-check fix <folder> --url <live site> [--write | --pr --repo owner/name --consent <ref>]
       citedby-check fix --count <index.html or build folder>

<folder> holds a Vite + React app (a Lovable, Bolt or v0 export): package.json and index.html.
The command opens the live site in a headless Chrome on this machine, reads the text a visitor sees on the
home page and the main routes, and writes it inside <div id="root"> in index.html. React replaces that block
when the app starts. It adds public/robots.txt, public/sitemap.xml and public/llms.txt where the repository has
none, and Organization data (JSON-LD) when index.html has none. Every word comes from the site.

Without --write or --pr nothing is changed: it prints what it read and what it would write.

Options:
  --url <address>     the live site to read (required, except with --count)
  --write             write the files into <folder>
  --pr                write, commit on a new branch, push it and open a pull request (needs git and gh)
  --repo <owner/name> the repository the pull request is opened on; must be this checkout's origin
  --consent <ref>     where the owner said yes to a pull request, or "own" for a repository of your own
  --base <branch>     branch the pull request targets (default: main)
  --branch <name>     branch to create (default: citedby/static-text)
  --routes <n>        how many routes to read besides the home page (default: 8)
  --body-out <file>   also save the pull request text to this file
  --count <path>      only count the words a plain request reads in an HTML file or a build folder
  --json              print the result as JSON
  -h, --help          show this help

Exit codes: 0 done, 1 the fix cannot be applied or the pull request failed, 2 wrong use, 3 the site could not be read.
A browser is needed: Chrome, Chromium or Edge, or CHROME_PATH set to one.
${REPO_URL}
`;

class Usage extends Error {}

export function parseFixArgs(argv) {
  const out = { dir: null, url: null, write: false, pr: false, repo: null, consent: null, base: 'main', branch: 'citedby/static-text', routes: 8, bodyOut: null, count: null, json: false, help: false };
  const args = [...argv];
  const pos = [];
  const value = (flag, inline) => {
    const v = inline !== undefined ? inline : args.shift();
    if (v === undefined || v === '') throw new Usage(`${flag} needs a value.`);
    return v;
  };
  while (args.length) {
    const a = args.shift();
    if (!a.startsWith('-')) { pos.push(a); continue; }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    switch (flag) {
      case '-h': case '--help': out.help = true; break;
      case '--write': out.write = true; break;
      case '--pr': out.pr = true; break;
      case '--json': out.json = true; break;
      case '--url': out.url = value(flag, inline); break;
      case '--repo': out.repo = value(flag, inline); break;
      case '--consent': out.consent = value(flag, inline); break;
      case '--base': out.base = value(flag, inline); break;
      case '--branch': out.branch = value(flag, inline); break;
      case '--body-out': out.bodyOut = value(flag, inline); break;
      case '--count': out.count = value(flag, inline); break;
      case '--routes': {
        const n = Number(value(flag, inline));
        if (!Number.isInteger(n) || n < 0 || n > 30) throw new Usage('--routes takes a whole number from 0 to 30.');
        out.routes = n;
        break;
      }
      default: throw new Usage(`Unknown option ${flag}. Run citedby-check fix --help.`);
    }
  }
  if (out.help || out.count) return out;
  if (pos.length !== 1) throw new Usage('Give one folder: the one that holds package.json and index.html.');
  out.dir = pos[0];
  if (!out.url) throw new Usage('Give the live site to read: --url https://example.com');
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(out.url) ? out.url : `https://${out.url}`); } catch { throw new Usage('--url takes a web address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Usage('--url takes an http or https address.');
  out.url = u.origin + (u.pathname === '/' ? '/' : u.pathname);
  if (out.pr && !/^[A-Za-z0-9._/-]+$/.test(out.branch)) throw new Usage('--branch takes letters, digits, ., _, - and /.');
  return out;
}

const sh = (cmd, args, cwd) => new Promise((res) => {
  execFile(cmd, args, { cwd }, (err, stdout) => res({ code: err ? 1 : 0, stdout: String(stdout || '').trim() }));
});

async function plainRead(url, fetchImpl) {
  try {
    const r = await fetchImpl(url, { headers: { 'user-agent': `citedby-check/${VERSION} fix (+${REPO_URL})` }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { status: r.status, words: countWords(await r.text()) };
  } catch {
    return { status: 0, words: null };
  }
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}\n?/g, (m, k) => {
    if (!(k in values)) return m;
    const v = String(values[k]);
    return m.endsWith('\n') ? (v === '' ? '' : `${v}\n`) : v;
  });
}

/** Builds the whole result from what was read. Pure: no network, no disk writes. */
export function buildFix({ info, home, routes, url, before, date }) {
  const origin = home.origin;
  const { html, routeSections, name, kept } = staticHtml({ home, routes });
  const needsOrg = !hasOrgData(stripFixBlocks(info.indexHtml)); // data an earlier run of the fix wrote is ours to write again
  const jsonLd = needsOrg ? orgJsonLd({ home, origin }) : null;
  const note = `text read from ${origin}/ on ${date} by citedby-check fix; React replaces this block when the app starts. After a text change, run citedby-check fix again (https://github.com/resaleiq/citedby-check)`;
  const indexHtml = patchIndexHtml(info.indexHtml, { staticInner: html, jsonLd, note });
  const texts = {
    indexHtml,
    sitemap: sitemapXml(origin, routes.map((r) => r.path)),
    robots: robotsTxt(origin, true),
    llms: llmsTxt({ home, origin, routes, routeSections }),
  };
  const plan = planFiles(info, texts, origin);
  const after = countWords(indexHtml);
  const blocked = info.files.robots ? blockedBots(info.robotsText) : [];
  const desc = describe(home);
  const notes = [];
  if (blocked.length) notes.push(`- Your robots.txt shuts out ${blocked.join(', ')}. This pull request leaves your rules as they are; those crawlers will not read the new text until you let them in.`);
  if (after < 200) notes.push(`- The site shows ${home.renderedWords} words in a browser. The block holds what is there; it does not add text the site does not have.`);
  const check = linesToCheck(kept);
  const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
  if (check.length) notes.push(`- Lines to look at before you merge, because they read like live or sample data that will not update in the copy: ${check.map(code).join(', ')}. Delete from the block what should not be frozen.`);
  if (isPlatformHost(origin)) notes.push(`- The sitemap, robots.txt and Organization data use the address ${code(`${origin}/`)}. If the site also runs on a domain of your own, run the command with that address instead, so these lines point to it.`);
  const org = jsonLd && jsonLd['@graph'][0];
  const orgFields = org ? [['name', org.name], ['url', org.url], ['description', org.description && `${org.description} (from the ${desc.from})`], ['logo', org.logo], ['email', org.email], ['telephone', org.telephone], ['sameAs', org.sameAs && org.sameAs.join(' , ')]].filter(([, v]) => v) : [];
  const orgLine = jsonLd
    ? `- The head of \`index.html\` gets Organization data (JSON-LD) with these values, all read from the page: ${orgFields.map(([k, v]) => `${k} ${code(v)}`).join('; ')}. Please check each one and correct what is off.`
    : '- `index.html` already has Organization data, so none is added.';
  const files = plan.map((f) => `- \`${f.path}\`: ${f.action === 'keep' ? 'not touched' : f.action === 'add' ? 'new' : 'changed'}, ${f.why}`).join('\n');
  const routeSummary = routes.length ? `${routes.length === 1 ? 'the other page' : `the ${routes.length} other pages`} (${routes.map((r) => `\`${r.path}\``).join(', ')})` : 'no other page, because the site has one';
  const body = fill(readFileSync(new URL('./templates/pr-body.md', import.meta.url), 'utf8'), {
    site: `${origin}/`,
    before: before === null ? 'an unknown number of' : before,
    rendered: home.renderedWords,
    after,
    files,
    date,
    org_line: orgLine,
    example_route: routes.length ? `\`${routes[0].path}\`` : 'any other address',
    route_summary: routeSummary,
    notes: notes.join('\n'),
  });
  return {
    site: `${origin}/`, requested: url, name, date,
    words: { before, rendered: home.renderedWords, after, level: textLevel(after) },
    routes: routes.map((r) => ({ path: r.path, read: Boolean(r.page), words: r.page ? r.page.renderedWords : 0 })),
    orgData: jsonLd ? 'added' : 'already there',
    blockedBots: blocked,
    plan, body,
    title: `Make the site's text readable without JavaScript (${after} words in index.html, was ${before === null ? 'unknown' : before})`,
  };
}

function report(res, { mode, written, pr }) {
  const L = [];
  L.push(`Fix for ${res.site} (${res.name})`, '');
  L.push(`  Plain request today      ${res.words.before === null ? 'could not be read' : `${res.words.before} words`}`);
  L.push(`  In a browser             ${res.words.rendered} words`);
  L.push(`  index.html with the fix  ${res.words.after} words (${res.words.level === 'ok' ? 'OK: 200 or more' : res.words.level === 'check' ? 'Check: 50 to 199' : 'Fix: under 50'})`, '');
  if (res.routes.length) L.push(`  Routes read: ${res.routes.map((r) => `${r.path}${r.read ? '' : ' (no page)'}`).join(', ')}`, '');
  for (const f of res.plan) L.push(`  ${f.action === 'keep' ? 'keep  ' : f.action === 'add' ? 'add   ' : 'change'}  ${f.path}  (${f.why})`);
  L.push('');
  if (res.blockedBots.length) L.push(`  robots.txt shuts out ${res.blockedBots.join(', ')}; the rules are left as they are.`, '');
  if (res.words.after < 200) L.push(`  The site shows ${res.words.rendered} words in a browser; the fix does not add text the site does not have.`, '');
  if (mode === 'dry') L.push('Nothing was changed. Add --write to write the files, or --pr to open a pull request.');
  if (mode === 'write') L.push(`Written: ${written.join(', ')}.`);
  if (mode === 'pr') L.push(`Pull request: ${pr.url}`, `Branch ${pr.branch}, commit ${pr.commit.slice(0, 7)}.`);
  return `${L.join('\n')}\n`;
}

export async function fixMain(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch, browser = openBrowser, pullRequest = openPullRequest, now = () => new Date() } = {}) {
  let a;
  try { a = parseFixArgs(argv); } catch (e) {
    if (!(e instanceof Usage)) throw e;
    stderr.write(`citedby-check fix: ${e.message}\n`);
    return 2;
  }
  if (a.help) { stdout.write(FIX_HELP); return 0; }
  if (a.count) {
    const p = resolve(a.count);
    const file = existsSync(p) && statSync(p).isDirectory() ? join(p, 'index.html') : p;
    if (!existsSync(file)) { stderr.write(`citedby-check fix: ${file} does not exist.\n`); return 2; }
    const html = readFileSync(file, 'utf8');
    const n = countWords(html);
    const res = { file, words: n, level: textLevel(n), orgData: hasOrgData(html), staticBlock: html.includes('id="citedby-static"') };
    stdout.write(a.json ? `${JSON.stringify(res, null, 2)}\n` : `${file}: ${n} words readable without JavaScript (${res.level === 'ok' ? 'OK' : res.level === 'check' ? 'Check' : 'Fix'}); Organization data ${res.orgData ? 'found' : 'not found'}.\n`);
    return 0;
  }

  const dir = resolve(a.dir);
  const info = inspectRepo(dir);
  if (info.problems.length) {
    stderr.write(`citedby-check fix: cannot be applied to ${dir}\n${info.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }
  let root = dir;
  let originUrl = '';
  if (a.pr) {
    const top = await sh('git', ['rev-parse', '--show-toplevel'], dir);
    if (top.code !== 0) { stderr.write('citedby-check fix: --pr needs a git checkout.\n'); return 1; }
    root = top.stdout;
    originUrl = (await sh('git', ['remote', 'get-url', 'origin'], root)).stdout;
    const no = refusal({ repo: a.repo, consent: a.consent, originUrl });
    if (no) { stderr.write(`citedby-check fix: ${no}\n`); return 2; }
    if ((await sh('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${a.branch}`], root)).code === 0) { stderr.write(`citedby-check fix: the branch ${a.branch} already exists here. Delete it or pass --branch with another name.\n`); return 1; }
    if ((await sh('git', ['status', '--porcelain'], root)).stdout) { stderr.write('citedby-check fix: the checkout has uncommitted changes. Commit or remove them first, so the pull request holds only the fix.\n'); return 1; }
  }

  const before = await plainRead(a.url, fetchImpl);
  let b;
  let home;
  const routes = [];
  try {
    b = await browser({ env });
    const first = await b.render(a.url);
    if (first.status >= 400 || !first.page || !first.page.blocks.length) throw new Error(`${a.url} answered ${first.status || 'nothing'} and showed no text in the browser.`);
    home = first.page;
    for (const r of pickRoutes(home, info.routes, a.routes)) {
      try {
        const got = await b.render(home.origin + r.path);
        if (got.page && got.page.origin === home.origin && !looksNotFound(got.page) && got.page.blocks.length) routes.push({ ...r, page: got.page });
      } catch { /* a route that does not load is left out */ }
    }
  } catch (e) {
    stderr.write(`citedby-check fix: the site could not be read. ${e.message}\n`);
    return 3;
  } finally {
    if (b) await b.close();
  }

  const res = buildFix({ info, home, routes, url: a.url, before: before.words, date: now().toISOString().slice(0, 10) });
  if (a.bodyOut) writeFileSync(resolve(a.bodyOut), res.body);
  let mode = 'dry';
  let written = [];
  let pr = null;
  if (a.write || a.pr) {
    written = applyPlan(dir, res.plan);
    mode = 'write';
  }
  if (a.pr) {
    const bodyFile = join(mkdtempSync(join(tmpdir(), 'citedby-fix-pr-')), 'body.md');
    writeFileSync(bodyFile, res.body);
    try {
      pr = await pullRequest({
        dir: relative(root, dir), root, repo: a.repo, base: a.base, branch: a.branch, title: res.title, bodyFile, files: written, consent: a.consent, env,
        message: `${res.title}\n\nText read from ${res.site} on ${res.date} with citedby-check fix. Files: ${written.join(', ')}.${a.consent.trim().toLowerCase() === 'own' ? '' : `\n\nOpened at the owner's request: ${a.consent.trim()}`}`,
      });
      mode = 'pr';
    } catch (e) {
      if (!(e instanceof PrError)) throw e;
      stderr.write(`citedby-check fix: ${e.message}\nThe files are written in ${dir}; look at \`git status\` there before you try again.\n`);
      return 1;
    }
  }
  const { plan, body, ...rest } = res;
  stdout.write(a.json ? `${JSON.stringify({ ...rest, files: plan.map(({ path, action, why }) => ({ path, action, why })), mode, written, pullRequest: pr }, null, 2)}\n` : report(res, { mode, written, pr }));
  return 0;
}
