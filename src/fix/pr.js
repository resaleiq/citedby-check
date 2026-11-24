// Opens the pull request: one branch, one commit, pushed to the repository itself, never to a fork's parent.
// Rule built in: a pull request is opened only where the owner said yes (--consent), and only on the repository named with --repo.
import { execFile } from 'node:child_process';

export class PrError extends Error {}

function run(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: Boolean(err && err.code === 'ENOENT') });
    });
  });
}

export function parseRepo(s) {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(String(s || '').trim());
  return m ? { owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}` } : null;
}

export function repoOfRemote(url) {
  const m = /(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Refusals that need no network. Returns the reason, or null when the request may go ahead. */
export function refusal({ repo, consent, originUrl }) {
  if (!parseRepo(repo)) return 'Name the repository the pull request goes to: --repo owner/name.';
  if (!consent || String(consent).trim().length < 3) {
    return 'A pull request is opened only after the owner said yes. Say where: --consent "<link or reference to their yes>", or --consent own for a repository of your own.';
  }
  const origin = repoOfRemote(originUrl);
  if (!origin) return 'This folder has no GitHub remote named origin, so there is no repository to push the branch to.';
  if (origin.toLowerCase() !== parseRepo(repo).slug.toLowerCase()) {
    return `This checkout comes from ${origin}, not ${parseRepo(repo).slug}. The branch is pushed to the repository the pull request is opened on: clone that repository and run the fix there.`;
  }
  return null;
}

// The token is read from the environment by git itself; it is never put in a command line or a URL.
const TOKEN_HELPER = '!f(){ echo username=x-access-token; echo "password=${GH_TOKEN:-$GITHUB_TOKEN}"; };f';

/**
 * Commits the listed files on a new branch, pushes it and opens the pull request. Resolves { url, branch, commit }.
 * Throws PrError with a plain reason; nothing is pushed when a step before the push fails.
 */
export async function openPullRequest({ dir, root, repo, base, branch, title, bodyFile, files, message, consent, authorName = 'CitedBy', authorEmail = 'hello@citedby.eu', env = process.env, exec = run }) {
  const git = (args) => exec('git', args, { cwd: root, env });
  const need = async (p, what) => {
    const r = await p;
    if (r.missing) throw new PrError(`${what}: the command is not installed.`);
    if (r.code !== 0) throw new PrError(`${what}: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
    return r.stdout.trim();
  };
  const originUrl = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
  const no = refusal({ repo, consent, originUrl });
  if (no) throw new PrError(no);
  const { slug } = parseRepo(repo);
  if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) throw new PrError(`The branch ${branch} already exists here. Delete it or pass --branch with another name.`);
  await need(git(['checkout', '-q', '-b', branch]), 'Could not start the branch');
  await need(git(['add', '--', ...files.map((f) => (dir ? `${dir}/${f}` : f))]), 'Could not stage the files');
  const ident = ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`];
  await need(git([...ident, 'commit', '-q', '-m', message]), 'Could not commit');
  const commit = await need(git(['rev-parse', 'HEAD']), 'Could not read the commit');
  const hasToken = Boolean(env.GH_TOKEN || env.GITHUB_TOKEN);
  const pushArgs = [...(hasToken ? ['-c', 'credential.helper=', '-c', `credential.helper=${TOKEN_HELPER}`] : []), 'push', '-q', `https://github.com/${slug}.git`, `${branch}:refs/heads/${branch}`];
  await need(git(pushArgs), 'Could not push the branch');
  const out = await need(exec('gh', ['pr', 'create', '--repo', slug, '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile], { cwd: root, env }), 'The branch is pushed, but the pull request could not be opened');
  const url = out.split('\n').map((l) => l.trim()).filter((l) => /^https:\/\/github\.com\//.test(l)).pop() || out;
  return { url, branch, commit };
}
