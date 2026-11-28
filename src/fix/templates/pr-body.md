## What this changes

A program that loads {{site}} without running JavaScript reads **{{before}} words** of text. A browser shows about {{rendered}}. Many AI crawlers and fetch tools read the HTML and do not run scripts, so that is all they get.

This pull request puts the text of the site into `index.html`. Counted the same way on the changed file, a plain request reads **{{after}} words**. The design, the React code, the build and the hosting stay as they are.

## Files

{{files}}

## How it works

- The text sits inside `<div id="root">`. React replaces everything in that element when the app starts, so visitors get the same site as today. While the app loads the block is hidden; if the scripts never load, it shows after 6 seconds instead of a blank page.
- Every word in the block was read from the live site on {{date}} with a headless browser. Nothing was written for it.
{{org_line}}

## Limits

- A single-page app serves the same `index.html` for every address. A plain request to {{example_route}} gets this same text. That is why the block describes the whole site and links {{route_summary}}.
- The block is a copy. After you change the text of the site, run the refresh command below, or the copy goes out of date. If a line on the page changes by itself (live data, opening hours, news), delete it from the block.
- `llms.txt` is optional: cheap to have, and we do not expect it to change what AI assistants answer.
{{notes}}

## Check it

Once a preview or the deploy is up:

```sh
npx github:citedby-eu/citedby-check <address of the preview or the site>
```

Refresh the copy after a text change (run in the folder that holds `index.html`):

```sh
npx github:citedby-eu/citedby-check fix . --url {{site}} --write
```

## Undo

Revert this one commit. No other file is touched.

How we count, and the same reading for 50 sites built with Lovable and Bolt: https://citedby.eu/data/ai-built-sites
