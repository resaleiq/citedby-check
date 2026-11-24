import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { countWords, visibleText, textLevel, hasOrgData } from '../src/fix/words.js';
import { brandName, pickRoutes, looksNotFound, staticHtml, describe, orgJsonLd, sitemapXml, llmsTxt, robotsTxt, isContentPath } from '../src/fix/snapshot.js';
import { inspectRepo, patchIndexHtml, planFiles, applyPlan, blockedBots, routesInSource, HEAD_START, BODY_END } from '../src/fix/repo.js';
import { refusal, openPullRequest, PrError, repoOfRemote } from '../src/fix/pr.js';
import { INDEX, makeRepo, HOME, PRICING } from './_fix-fixtures.js';


test('words are counted the way the citedby.eu check counts them', () => {
  assert.equal(countWords('<div id="root"></div><script>var a = "one two three";</script>'), 0);
  assert.equal(countWords('<!-- a developer comment --><p>Two words</p><noscript>not counted here</noscript><svg><text>no</text></svg>'), 2);
  assert.equal(visibleText('<h1>Hello</h1>\n<p>big   world</p>'), 'Hello big world');
  assert.deepEqual([textLevel(49), textLevel(50), textLevel(199), textLevel(200)], ['fix', 'check', 'check', 'ok']);
  assert.equal(hasOrgData('<script type="application/ld+json">{"@graph":[{"@type":"Organization"}]}</script>'), true);
  assert.equal(hasOrgData('<script type="application/ld+json">{"@type":"WebSite"}</script><script type="application/ld+json">{broken</script>'), false);
});

test('the site name comes from the title part that matches the host, and routes leave out logins and files', () => {
  assert.equal(brandName(HOME), 'Acme Tools');
  assert.equal(brandName({ siteName: 'Acme', title: 'x', origin: 'https://a.example' }), 'Acme');
  assert.equal(brandName({ title: 'Welcome | PickMeA', origin: 'https://pickmea.netlify.app' }), 'PickMeA');
  assert.deepEqual(pickRoutes(HOME, ['/pricing', '/about/', '/user/:id', '*']), [{ path: '/pricing', text: 'Pricing' }, { path: '/about', text: '' }]);
  assert.equal(isContentPath('/admin-login'), false);
  assert.equal(looksNotFound({ title: 'Acme', renderedWords: 12, blocks: [{ text: '404' }, { text: 'Oops! Page not found' }] }), true);
  assert.equal(looksNotFound(PRICING), false);
});

test('the static block holds the site text, escaped, with one section per route: its heading and intro only', () => {
  const { html, routeSections } = staticHtml({ home: HOME, routes: [{ path: '/pricing', text: 'Pricing', page: PRICING }] });
  assert.match(html, /<nav aria-label="Pages">[\s\S]*<a href="\/pricing">Pricing<\/a>/);
  assert.match(html, /<h1>Fix things &lt;faster&gt; &amp; better<\/h1>/);
  assert.match(html, /<ul>\n {2}<li>Plan repairs<\/li>\n {2}<li><a href="\/pricing">Order parts<\/a><\/li>\n<\/ul>/);
  assert.match(html, /<section>\n<h2><a href="\/pricing">Simple pricing<\/a><\/h2>\n<p>One plan at 19 euros a month for the whole workshop\.<\/p>\n<\/section>/);
  assert.doesNotMatch(html, /stays out/);
  assert.match(html, /<footer>\n<p>© Acme Tools<\/p>\n<\/footer>/);
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  assert.deepEqual(routeSections.map((s) => s.path), ['/pricing']);
  const noH1 = staticHtml({ home: { ...HOME, blocks: HOME.blocks.filter((b) => b.tag !== 'h1') } });
  assert.match(noH1.html, /<h1>Acme Tools - Fix things faster<\/h1>/);
});

test('Organization data uses only what was read: no default icon as logo, no share links, a short meta description gives way to the page', () => {
  assert.deepEqual(describe(HOME), { text: 'Acme Tools helps small workshops plan repairs and order parts in one place.', from: 'first paragraph of the home page' });
  const ld = orgJsonLd({ home: HOME, origin: HOME.origin });
  const org = ld['@graph'][0];
  assert.equal(org['@type'], 'Organization');
  assert.equal(org.name, 'Acme Tools');
  assert.equal(org.logo, undefined);
  assert.deepEqual(org.sameAs, ['https://www.linkedin.com/company/acme']);
  assert.equal(org.email, 'hi@acme.example');
  assert.equal(ld['@graph'][1].publisher['@id'], org['@id']);
  assert.match(sitemapXml(HOME.origin, ['/pricing']), /<loc>https:\/\/acme\.example\/<\/loc>[\s\S]*<loc>https:\/\/acme\.example\/pricing<\/loc>/);
  assert.match(llmsTxt({ home: HOME, origin: HOME.origin, routes: [{ path: '/pricing', text: 'Pricing' }] }), /^# Acme Tools\n\n> Acme Tools helps[\s\S]*- \[Pricing\]\(https:\/\/acme\.example\/pricing\)\n$/);
  assert.equal(robotsTxt(HOME.origin), 'User-agent: *\nAllow: /\n\nSitemap: https://acme.example/sitemap.xml\n');
});

test('inspectRepo accepts a Vite + React export and says why another repository cannot take the fix', () => {
  const ok = inspectRepo(makeRepo());
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.routes, ['/', '/pricing']);
  assert.equal(ok.stack.lovable, true);
  assert.match(inspectRepo(makeRepo({ pkg: { dependencies: { next: '15' } } })).problems.join(' '), /not a Vite app/);
  assert.match(inspectRepo(makeRepo({ main: 'hydrateRoot(document.getElementById("root"), <App />)' })).problems.join(' '), /hydrates/);
  assert.match(inspectRepo(makeRepo({ index: '<html><head></head><body><div id="app"></div></body></html>' })).problems.join(' '), /no <div id="root">/);
  assert.match(inspectRepo(makeRepo({ index: null })).problems.join(' '), /No index\.html/);
  assert.deepEqual(routesInSource('<Route path="about" /><Route path={"/x"} /><Route path="/a/:id" />'), ['/about', '/x']);
});

test('patchIndexHtml puts the block inside #root and the data in the head, and a second run replaces instead of stacking', () => {
  const once = patchIndexHtml(INDEX, { staticInner: '<h1>Hi</h1>\n<p>Text here</p>', jsonLd: { '@type': 'Organization', name: 'A</script>' }, note: 'read -- today > now' });
  assert.match(once, /<div id="root">\n {6}<!-- citedby-static:start read - today  now -->\n {6}<div id="citedby-static">\n {6}<h1>Hi<\/h1>\n {6}<p>Text here<\/p>\n {6}<\/div>\n {6}<!-- citedby-static:end -->\n {4}<\/div>/);
  assert.match(once, /<script type="application\/ld\+json">\{"@type":"Organization","name":"A\\u003c\/script>"\}<\/script>\n {4}<!-- citedby-static:head:end -->\n {2}<\/head>/);
  assert.equal(countWords(once), 9); // the 6 words of the title count too, as they do in the check
  assert.equal(hasOrgData(once), true);
  const twice = patchIndexHtml(once, { staticInner: '<h1>New</h1>', jsonLd: null, note: 'n' });
  assert.equal(twice.split(HEAD_START).length, 2);
  assert.equal(twice.split(BODY_END).length, 2);
  assert.doesNotMatch(twice, /Text here|ld\+json/);
  assert.match(twice, /<script type="module" src="\/src\/main\.tsx"><\/script>/);
  assert.equal(patchIndexHtml(twice, { staticInner: '<h1>New</h1>', jsonLd: null, note: 'n' }), twice);
});

test('files the owner already has are kept; an existing robots.txt keeps its rules and gains the sitemap line', () => {
  const dir = makeRepo({ files: { 'public/robots.txt': 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n', 'public/llms.txt': '# mine\n' } });
  const info = inspectRepo(dir);
  const plan = planFiles(info, { indexHtml: 'X', sitemap: 'S', robots: 'R', llms: 'L' }, 'https://acme.example');
  assert.deepEqual(plan.map((f) => [f.path, f.action]), [['index.html', 'change'], ['public/sitemap.xml', 'add'], ['public/robots.txt', 'change'], ['public/llms.txt', 'keep']]);
  assert.deepEqual(applyPlan(dir, plan), ['index.html', 'public/sitemap.xml', 'public/robots.txt']);
  assert.equal(readFileSync(join(dir, 'public/robots.txt'), 'utf8'), 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n\nSitemap: https://acme.example/sitemap.xml\n');
  assert.equal(readFileSync(join(dir, 'public/llms.txt'), 'utf8'), '# mine\n');
  assert.deepEqual(blockedBots(info.robotsText), ['GPTBot']);
  assert.deepEqual(blockedBots('User-agent: *\nDisallow: /\n').length, 8);
  assert.deepEqual(blockedBots('User-agent: *\nDisallow: /admin\n'), []);
  const fresh = makeRepo();
  applyPlan(fresh, planFiles(inspectRepo(fresh), { indexHtml: 'X', sitemap: 'S', robots: 'R', llms: 'L' }, 'https://acme.example'));
  assert.equal(existsSync(join(fresh, 'public/llms.txt')), true);
});

test('a pull request is refused without the owner\'s yes, without --repo, or on a repository that is not this checkout\'s origin', () => {
  const origin = 'https://github.com/acme/site.git';
  assert.match(refusal({ repo: 'acme/site', consent: '', originUrl: origin }), /only after the owner said yes/);
  assert.match(refusal({ repo: '', consent: 'own', originUrl: origin }), /--repo owner\/name/);
  assert.match(refusal({ repo: 'upstream/site', consent: 'own', originUrl: origin }), /comes from acme\/site, not upstream\/site/);
  assert.match(refusal({ repo: 'acme/site', consent: 'own', originUrl: '' }), /no GitHub remote/);
  assert.equal(refusal({ repo: 'Acme/Site', consent: 'mail thread 42', originUrl: 'git@github.com:acme/site.git' }), null);
  assert.equal(repoOfRemote('https://github.com/a/b'), 'a/b');
});

test('openPullRequest names repo, base and head itself, pushes to that repository only, and keeps the token out of the command line', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'remote') return { code: 0, stdout: 'https://github.com/acme/site.git\n', stderr: '' };
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') return { code: 1, stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'abc1234def\n', stderr: '' };
    if (cmd === 'gh') return { code: 0, stdout: 'Creating pull request\nhttps://github.com/acme/site/pull/7\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const env = { GH_TOKEN: 'ghs_secretvalue' };
  const pr = await openPullRequest({ dir: 'app', root: '/r', repo: 'acme/site', base: 'main', branch: 'citedby/static-text', title: 'T', bodyFile: '/tmp/b.md', files: ['index.html', 'public/robots.txt'], message: 'm', consent: 'own', env, exec });
  assert.deepEqual(pr, { url: 'https://github.com/acme/site/pull/7', branch: 'citedby/static-text', commit: 'abc1234def' });
  const flat = calls.map((c) => c.join(' '));
  assert.ok(flat.includes('git add -- app/index.html app/public/robots.txt'));
  assert.ok(flat.some((c) => c.startsWith('git -c user.name=CitedBy -c user.email=hello@citedby.eu commit')));
  const push = flat.find((c) => c.includes(' push '));
  assert.match(push, /push -q https:\/\/github\.com\/acme\/site\.git citedby\/static-text:refs\/heads\/citedby\/static-text$/);
  assert.equal(flat[flat.length - 1], 'gh pr create --repo acme/site --base main --head citedby/static-text --title T --body-file /tmp/b.md');
  assert.ok(!flat.join('\n').includes('ghs_secretvalue'));
  await assert.rejects(openPullRequest({ dir: '', root: '/r', repo: 'other/site', base: 'main', branch: 'b', title: 'T', bodyFile: 'f', files: [], message: 'm', consent: 'own', env, exec }), PrError);
  assert.equal(calls.filter((c) => c.includes('push')).length, 1);
});
