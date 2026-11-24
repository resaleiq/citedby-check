# Changelog

## 0.2.0

- New command `citedby-check fix <folder> --url <live site>` for Vite + React sites exported from Lovable, Bolt or v0, where a plain request reads an empty page. It opens the live site in a headless Chrome on your machine, reads the text a visitor sees on the home page and the main routes, and writes it inside `<div id="root">` in `index.html`; React replaces the block when the app starts. It adds `public/robots.txt`, `public/sitemap.xml` and `public/llms.txt` where the repository has none, and Organization data when `index.html` has none. Every word comes from the site.
- Dry run by default. `--write` writes the files. `--pr --repo owner/name --consent <ref>` commits on a new branch, pushes it to that repository and opens the pull request; it refuses without the owner's yes, and it never targets a fork's parent.
- `citedby-check fix --count <index.html or build folder>` counts the words a plain request reads, the way the citedby.eu check counts them.
- No new dependencies. The fix needs Chrome, Chromium or Edge (or `CHROME_PATH`).

## 0.1.1

- A robots.txt that answers a server error (HTTP 500 to 599) is now reported as Fix: RFC 9309 says a crawler must then assume the whole site is disallowed. Before, it read as "No robots.txt found, so nothing is blocked". One that could not be loaded at all is Not checked.
- README: the Result column, the llms.txt row and the limits now match what the check does, and the sample output shows the full run.
- `npm test` runs on Node 22 and later.

## 0.1.0

First release.

- `citedby-check <address>`: runs the free citedby.eu check and prints one block per check with the fix.
- Options: `--fail-on fail|warn|never`, `--lang`, `--json`, `--quiet`, `--no-color`, `--source`, `--api-url`.
- Exit codes: 0 nothing at or above `--fail-on`, 1 something to fix, 2 wrong use, 3 not measured.
- GitHub Action (`uses: resaleiq/citedby-check@v0`): job summary, annotations, step outputs.
