// Shared by the fix tests: a throwaway Vite + React repository and what the browser "read" on its site.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const INDEX = `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Acme Tools - Fix things faster</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

export function makeRepo({ index = INDEX, pkg = { dependencies: { react: '^18.3.1' }, devDependencies: { vite: '^5.4.1', 'lovable-tagger': '^1.1.7' } }, main = 'createRoot(document.getElementById("root")!).render(<App />);', files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-fix-test-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  if (index !== null) writeFileSync(join(dir, 'index.html'), index);
  writeFileSync(join(dir, 'src/main.tsx'), main);
  writeFileSync(join(dir, 'src/App.tsx'), '<Routes><Route path="/" element={<A />} /><Route path="/pricing" element={<P />} /><Route path="/user/:id" element={<U />} /><Route path="*" element={<N />} /></Routes>');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

export const HOME = {
  url: 'https://acme.example/', origin: 'https://acme.example', path: '/', title: 'Acme Tools - Fix things faster', description: 'Tools.', siteName: '', ogImage: '', lang: 'en', renderedWords: 40,
  blocks: [
    { tag: 'p', region: 'nav', text: 'Pricing', href: '/pricing' },
    { tag: 'h1', region: 'main', text: 'Fix things <faster> & better' },
    { tag: 'p', region: 'main', text: 'Acme Tools helps small workshops plan repairs and order parts in one place.' },
    { tag: 'li', region: 'main', text: 'Plan repairs' },
    { tag: 'li', region: 'main', text: 'Order parts', href: '/pricing' },
    { tag: 'p', region: 'footer', text: '© Acme Tools' },
  ],
  links: [{ path: '/pricing', text: 'Pricing' }, { path: '/login', text: 'Log in' }, { path: '/', text: 'Home' }, { path: '/brochure.pdf', text: 'PDF' }],
  sameAs: ['https://www.linkedin.com/company/acme?trk=x', 'https://twitter.com/intent/tweet?text=hi'], email: 'hi@acme.example', phone: '', icons: [{ rel: 'icon', href: 'https://acme.example/vite.svg', sizes: '' }],
};
export const PRICING = {
  origin: 'https://acme.example', path: '/pricing', title: 'Pricing', renderedWords: 120,
  blocks: [
    { tag: 'p', region: 'nav', text: 'Pricing', href: '/pricing' },
    { tag: 'h1', region: 'main', text: 'Simple pricing' },
    { tag: 'p', region: 'main', text: 'One plan at 19 euros a month for the whole workshop.' },
    { tag: 'h2', region: 'main', text: 'Questions' },
    { tag: 'p', region: 'main', text: 'This line sits under a second heading and stays out.' },
  ],
};

