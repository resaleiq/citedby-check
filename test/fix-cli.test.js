import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { fixMain, parseFixArgs, buildFix } from '../src/fix/cli.js';
import { findChrome, openBrowser } from '../src/fix/chrome.js';
import { inspectRepo } from '../src/fix/repo.js';
import { countWords } from '../src/fix/words.js';
import { makeRepo, HOME, PRICING } from './_fix-fixtures.js';

const fakeBrowser = (pages) => async () => ({
  render: async (url) => {
    const p = pages[new URL(url).pathname];
    if (!p) return { status: 200, page: { origin: HOME.origin, path: new URL(url).pathname, title: 'Not found', renderedWords: 5, blocks: [{ tag: 'h1', region: 'main', text: '404' }], links: [] } };
    return { status: 200, page: p };
  },
  close: async () => {},
});

async function run(argv, opts = {}) {
  let stdout = '';
  let stderr = '';
  const code = await fixMain(argv, {
    env: {},
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    fetchImpl: async () => new Response('<html><body><div id="root"></div></body></html>', { status: 200 }),
    browser: fakeBrowser({ '/': HOME, '/pricing': PRICING }),
    now: () => new Date('2026-11-24T10:00:00Z'),
    ...opts,
  });
  return { code, stdout, stderr };
}

test('fix arguments: one folder and --url are needed; --pr is refused before any reading when the yes or the repository is missing', async () => {
  assert.throws(() => parseFixArgs([]), /Give one folder/);
  assert.throws(() => parseFixArgs(['.']), /--url/);
  assert.throws(() => parseFixArgs(['.', '--url', 'ftp://x']), /http or https/);
  assert.equal(parseFixArgs(['.', '--url', 'acme.example']).url, 'https://acme.example/');
  assert.equal((await run(['.', '--nope'])).code, 2);
  const help = await run(['--help']);
  assert.match(help.stdout, /^citedby-check fix:/);
});

test('the main CLI hands "fix" to the fix command and still checks addresses otherwise', async () => {
  let out = '';
  const code = await main(['fix', '--help'], { env: {}, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  assert.equal(code, 0);
  assert.match(out, /Usage: citedby-check fix <folder>/);
});

test('a dry run changes nothing; --write writes index.html and the missing files; the report gives before and after', async () => {
  const dir = makeRepo();
  const before = readFileSync(join(dir, 'index.html'), 'utf8');
  const dry = await run([dir, '--url', 'https://acme.example']);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /Plain request today {6}0 words/);
  assert.match(dry.stdout, /In a browser {13}40 words/);
  assert.match(dry.stdout, /Nothing was changed/);
  assert.match(dry.stdout, /does not add text the site does not have/);
  assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), before);
  assert.equal(existsSync(join(dir, 'public/robots.txt')), false);

  const body = join(dir, 'body.md');
  const wrote = await run([dir, '--url', 'https://acme.example', '--write', '--json', '--body-out', body]);
  const j = JSON.parse(wrote.stdout);
  assert.equal(j.mode, 'write');
  assert.deepEqual(j.written, ['index.html', 'public/sitemap.xml', 'public/robots.txt', 'public/llms.txt']);
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.equal(countWords(html), j.words.after);
  assert.ok(j.words.after > 20);
  assert.match(html, /<div id="citedby-static">/);
  assert.doesNotMatch(html, /--url|--write/); // an HTML comment cannot hold a double dash
  assert.deepEqual(j.routes, [{ path: '/pricing', read: true, words: 120 }]);
  const md = readFileSync(body, 'utf8');
  assert.match(md, /reads \*\*0 words\*\* of text\. A browser shows about 40\./);
  assert.match(md, /`public\/robots\.txt`: new/);
  assert.match(md, /Organization data \(JSON-LD\) with these values, all read from the page: name `Acme Tools`; url `https:\/\/acme\.example\/`; description `Acme Tools helps[^`]+` \(the first paragraph of the home page\); email `hi@acme\.example`; sameAs `https:\/\/www\.linkedin\.com\/company\/acme`\./);

  // A second run is a refresh: the Organization data the first run wrote is written again, not dropped.
  const again = JSON.parse((await run([dir, '--url', 'https://acme.example', '--write', '--json'])).stdout);
  assert.equal(again.orgData, 'added');
  const html2 = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.equal(html2, html);
  assert.equal(html2.split('application/ld+json').length, 2);
  assert.match(md, /read from the live site on 2026-11-24/);
  assert.doesNotMatch(md, /\{\{/);
});

test('a repository the fix does not fit exits 1 with the reason; a site that shows nothing exits 3; --count reads a build', async () => {
  const bad = await run([makeRepo({ pkg: { dependencies: { next: '15' } } }), '--url', 'https://acme.example']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /not a Vite app/);
  const empty = await run([makeRepo(), '--url', 'https://acme.example'], { browser: fakeBrowser({ '/': { ...HOME, blocks: [] } }) });
  assert.equal(empty.code, 3);
  const dir = makeRepo();
  writeFileSync(join(dir, 'index.html'), '<div id="root"><p>one two three</p></div>');
  const c = await run(['--count', dir]);
  assert.match(c.stdout, /3 words readable without JavaScript \(Fix\)/);
});

test('--pr: missing consent stops before anything is read; with it, the pull request gets the written files and the generated title', async () => {
  const dir = makeRepo();
  const no = await run([dir, '--url', 'https://acme.example', '--pr', '--repo', 'acme/site']);
  assert.equal(no.code, 1); // not a git checkout: nothing to push from
  assert.match(no.stderr, /needs a git checkout/);
  const res = buildFix({ info: inspectRepo(dir), home: HOME, routes: [{ path: '/pricing', text: 'Pricing', page: PRICING }], url: 'https://acme.example/', before: 0, date: '2026-11-24' });
  assert.match(res.title, /^Make the site's text readable without JavaScript \(\d+ words in index\.html, was 0\)$/);
  assert.equal(res.orgData, 'added');
});

const chrome = findChrome();
test('a real headless browser reads a JavaScript-only page: text, routes, opened answers; controls are left out', { skip: chrome ? false : 'no Chrome on this machine' }, async () => {
  const page = `<!doctype html><html lang="en"><head><title>Demo Shop | Home</title><meta name="description" content="A demo."></head><body><div id="root"></div><script>
    const root = document.getElementById('root');
    const path = location.pathname;
    setTimeout(() => {
      root.innerHTML = path === '/' ? '<nav><a href="/about">About</a><a href="/login">Log in</a></nav><main><h1><span style="display:inline-block">De</span><span style="display:inline-block">mo</span> Shop</h1><div><div>Hand-made lamps from Lyon, shipped in a week.</div><button>Buy now</button><span class="x" style="display:none">hidden words</span></div><h3><button aria-expanded="false" aria-controls="a1" id="q1">Do you ship abroad?</button></h3><div id="a1" hidden>Yes, to every EU country.</div><ul><li>Oak base</li><li>Linen shade</li></ul><a href="https://www.instagram.com/demoshop">Instagram</a></main><footer><p>Demo Shop SAS</p></footer>' : '<main><h1>About us</h1><p>Two people and a workshop.</p></main>';
      const q = document.getElementById('q1');
      if (q) q.onclick = () => { document.getElementById('a1').hidden = false; q.setAttribute('aria-expanded', 'true'); };
    }, 50);
  </script></body></html>`;
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await openBrowser({ env: { ...process.env, ...(process.env.CI ? { CITEDBY_CHROME_NO_SANDBOX: '1' } : {}) }, settleMs: 400 });
  try {
    assert.match(b.userAgent, /CitedBot\/1\.0 \(\+https:\/\/citedby\.eu\/bot\)$/);
    const { status, page: p } = await b.render(`${base}/`);
    assert.equal(status, 200);
    assert.equal(p.title, 'Demo Shop | Home');
    const texts = p.blocks.map((x) => `${x.tag}:${x.text}`);
    assert.ok(texts.includes('h1:Demo Shop'), texts.join(' | '));
    assert.ok(texts.includes('p:Hand-made lamps from Lyon, shipped in a week.'));
    assert.ok(texts.includes('h3:Do you ship abroad?'));
    assert.ok(texts.includes('p:Yes, to every EU country.'));
    assert.ok(texts.includes('li:Oak base') && texts.includes('li:Linen shade'));
    assert.ok(!texts.some((t) => /Buy now|hidden words/.test(t)), texts.join(' | '));
    assert.deepEqual(p.blocks.find((x) => x.text === 'About'), { tag: 'p', region: 'nav', text: 'About', href: '/about' });
    assert.equal(p.blocks.find((x) => x.text === 'Demo Shop SAS').region, 'footer');
    assert.deepEqual(p.sameAs, ['https://www.instagram.com/demoshop']);
    assert.deepEqual(p.links.map((l) => l.path), ['/about', '/login']);
    const about = await b.render(`${base}/about`);
    assert.deepEqual(about.page.blocks.map((x) => x.text), ['About us', 'Two people and a workshop.']);
  } finally {
    await b.close();
    server.close();
  }
});
