// Draws a page in a headless Chrome that is already on the machine and reads its text. No dependencies:
// the browser is driven over its own debugging pipe (file descriptors 3 and 4, one JSON message per NUL byte).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPage } from './extract.js';

export const BOT_UA_SUFFIX = 'CitedBot/1.0 (+https://citedby.eu/bot)';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

/** The browser to use: CHROME_PATH when set, else the first known install. null when there is none. */
export function findChrome(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.CHROME_PATH) return exists(env.CHROME_PATH) ? env.CHROME_PATH : null;
  return (CANDIDATES[platform] || []).find((p) => exists(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Pipe {
  constructor(proc) {
    this.out = proc.stdio[3];
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = false;
    let buf = '';
    proc.stdio[4].setEncoding('utf8');
    proc.stdio[4].on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'browser error')); else resolve(msg.result);
        } else if (msg.method) {
          for (const h of this.handlers) h(msg);
        }
      }
    });
    const end = () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('The browser closed before it answered.'));
      this.pending.clear();
    };
    proc.on('exit', end);
    proc.on('error', end);
    this.out.on('error', () => {});
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('The browser is not running.'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }
}

/**
 * Starts the browser. Returns { render(url), close() }.
 * render resolves { status, page } where page is what extract.js returns; it throws when the page cannot be loaded.
 */
export async function openBrowser({ chromePath, env = process.env, loadTimeoutMs = 30000, settleMs = 1500, quietMs = 800, maxQuietWaitMs = 10000 } = {}) {
  const bin = chromePath || findChrome(env);
  if (!bin) throw new Error('No Chrome, Chromium or Edge found. Install one, or set CHROME_PATH to the browser to use.');
  const profile = mkdtempSync(join(tmpdir(), 'citedby-fix-'));
  const args = [
    /headless-shell/.test(bin) ? '--headless' : '--headless=new',
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-gpu', '--mute-audio', '--hide-scrollbars', '--window-size=1280,900',
    ...(env.CITEDBY_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const pipe = new Pipe(proc);
  let ua;
  try {
    const v = await pipe.send('Browser.getVersion');
    ua = `${v.userAgent} ${BOT_UA_SUFFIX}`;
  } catch (e) {
    proc.kill();
    rmSync(profile, { recursive: true, force: true });
    throw new Error(`The browser at ${bin} did not start: ${e.message}`);
  }

  async function render(url) {
    const { targetId } = await pipe.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => pipe.send(m, p, sessionId);
    let inflight = 0;
    let lastActivity = Date.now();
    let loaded = false;
    let status = 0;
    let mainRequest = null;
    const onEvent = (msg) => {
      if (msg.sessionId !== sessionId) return;
      const p = msg.params || {};
      if (msg.method === 'Network.requestWillBeSent') {
        if (!p.redirectResponse) inflight += 1;
        if (p.type === 'Document' && !mainRequest) mainRequest = p.requestId;
        lastActivity = Date.now();
      } else if (msg.method === 'Network.responseReceived') {
        if (p.requestId === mainRequest) status = p.response.status;
      } else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
        inflight = Math.max(0, inflight - 1);
        lastActivity = Date.now();
      } else if (msg.method === 'Page.loadEventFired') {
        loaded = true;
      }
    };
    pipe.handlers.add(onEvent);
    try {
      await s('Page.enable');
      await s('Network.enable');
      await s('Emulation.setUserAgentOverride', { userAgent: ua });
      const nav = await s('Page.navigate', { url });
      if (nav.errorText) throw new Error(`${url} did not load: ${nav.errorText}`);
      const start = Date.now();
      while (!loaded && Date.now() - start < loadTimeoutMs) await sleep(100);
      const quietStart = Date.now();
      while (Date.now() - quietStart < maxQuietWaitMs && (inflight > 0 || Date.now() - lastActivity < quietMs)) await sleep(100);
      await sleep(settleMs);
      const res = await s('Runtime.evaluate', { expression: `(${extractPage.toString()})({})`, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(`Could not read ${url}: ${res.exceptionDetails.text || 'script error'}`);
      return { status, page: res.result.value };
    } finally {
      pipe.handlers.delete(onEvent);
      await pipe.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  async function close() {
    await Promise.race([pipe.send('Browser.close').catch(() => {}), sleep(2000)]);
    if (proc.exitCode === null) proc.kill();
    await sleep(100);
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }

  return { render, close, userAgent: ua };
}
