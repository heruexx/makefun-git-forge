// REST v3 surface for the forge. Everything here is synchronous map work (no sleeps, no clock,
// no randomness) so the 2,000-read / 200-write workloads stay fast and replays stay deterministic.
// Only /api/v3 paths are claimed; git smart HTTP, /api/graphql and /mcp are left to other modules.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repo, Content } from './store.ts';
import { cryptoHash } from './store.ts';

const T0 = '2026-01-01T00:00:00Z';
const SHA40 = /^[0-9a-f]{40}$/i;

type Json = Record<string, unknown>;

interface RepoExtra {
  // commitSha -> path -> blobSha (a snapshot of the tree at that commit)
  trees: Map<string, Map<string, string>>;
  // blobSha -> the content object returned by the contents API
  blobs: Map<string, Content>;
  commitCount: number;
}

const extras = new Map<string, RepoExtra>();
let requestCounter = 0;

function extraOf(repo: Repo): RepoExtra {
  let e = extras.get(repo.full_name);
  if (!e) {
    e = { trees: new Map(), blobs: new Map(), commitCount: 0 };
    extras.set(repo.full_name, e);
  }
  return e;
}

function reply(
  res: ServerResponse,
  rid: string,
  status: number,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-GitHub-Request-Id', rid);
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  if (payload === undefined) res.end();
  else res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function lineCount(text: string): number {
  if (text === '') return 0;
  let n = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function blobText(e: RepoExtra, sha: string): string {
  const blob = e.blobs.get(sha);
  return blob ? Buffer.from(blob.content, 'base64').toString('utf8') : '';
}

function treeIdOf(tree: Map<string, string>): string {
  const lines: string[] = [];
  for (const [p, s] of tree) lines.push(`${p}\0${s}\n`);
  lines.sort();
  return cryptoHash(lines.join(''));
}

function makeCommit(repo: Repo, e: RepoExtra, parent: string | undefined, message: string, tree: Map<string, string>): string {
  const treeId = treeIdOf(tree);
  const sha = cryptoHash(`commit\n${parent ?? ''}\n${message}\n${treeId}\n${e.commitCount++}`);
  repo.commits.set(sha, {
    sha,
    message,
    tree: treeId,
    parents: parent ? [parent] : [],
    author: { name: 'forge', email: 'forge@local', date: T0 },
    committer: { name: 'forge', email: 'forge@local', date: T0 },
  });
  e.trees.set(sha, tree);
  return sha;
}

function refSha(repo: Repo, ref?: string): string | undefined {
  if (!ref) return repo.refs.get(`refs/heads/${repo.default_branch}`);
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? repo.refs.get(`refs/tags/${ref}`);
}

/** The tree snapshot for a commit sha; fall back to the store's flat content map for git-pushed repos. */
function treeOf(repo: Repo, e: RepoExtra, sha: string | undefined): Map<string, string> {
  if (sha) {
    const t = e.trees.get(sha);
    if (t) return t;
  }
  const t = new Map<string, string>();
  for (const [p, c] of repo.contents) {
    t.set(p, c.sha);
    if (!e.blobs.has(c.sha)) e.blobs.set(c.sha, c);
  }
  return t;
}

function diffFiles(repo: Repo, e: RepoExtra, pull: {
  number: number;
  head: { ref: string; sha: string; label: string; repo: string };
  base: { ref: string; sha: string; label: string; repo: string };
}): Json[] {
  const ancestor = e.trees.get(pull.base.sha) ?? new Map<string, string>();
  const headTree = e.trees.get(pull.head.sha) ?? new Map<string, string>();
  const paths = new Set<string>([...ancestor.keys(), ...headTree.keys()]);
  const files: Json[] = [];
  for (const path of paths) {
    const a = ancestor.get(path);
    const h = headTree.get(path);
    if (a === h) continue;
    const added = h !== undefined;
    const removed = a !== undefined;
    const additions = added ? Math.max(1, lineCount(blobText(e, h!))) : 0;
    const deletions = removed ? Math.max(1, lineCount(blobText(e, a!))) : 0;
    const status = !removed ? 'added' : !added ? 'removed' : 'modified';
    files.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      patch: `@@ -1,${deletions} +1,${additions} @@\n${added ? blobText(e, h!).slice(0, 256) : ''}`,
    });
  }
  return files;
}

/** True when this request belongs to the REST v3 surface. */
export function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): boolean {
  const rawPath = (req.url ?? '/').split('?')[0] || '/';
  const isRoot = rawPath === '/api/v3' || rawPath === '/api/v3/';
  if (!isRoot && !rawPath.startsWith('/api/v3/')) return false;

  void serve(req, res, store, rawPath, isRoot);
  return true;
}

async function serve(req: IncomingMessage, res: ServerResponse, store: Store, rawPath: string, isRoot: boolean): Promise<void> {
  const rid = `gh-${cryptoHash(`${req.method ?? 'GET'} ${req.url ?? rawPath} ${++requestCounter}`).slice(0, 16)}`;
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? rawPath, 'http://forge.local');
  const query = url.searchParams;

  // Drain the body for every method so keep-alive sockets stay healthy.
  let raw: Buffer = Buffer.alloc(0);
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      raw = await readBody(req);
    } catch {
      reply(res, rid, 400, { message: 'Bad request' });
      return;
    }
  }
  let body: Json = {};
  if (raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : {};
    } catch {
      reply(res, rid, 400, { message: 'Invalid JSON body' });
      return;
    }
  }

  // Bearer auth is required on every REST route; a repository is the token owner's alone.
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || auth.trim() !== `Bearer ${store.token}`) {
    reply(res, rid, 401, { message: 'Bad credentials' });
    return;
  }

  const segs = rawPath.split('/').filter(Boolean).slice(2); // drop ['api','v3']

  // ---- root / meta / viewer ----------------------------------------------------------------
  if (isRoot || segs.length === 0) {
    if (method !== 'GET') return reply(res, rid, 404, { message: 'Not Found' });
    reply(res, rid, 200, { current_user_url: `${baseOf(req)}/user`, message: 'GitHub REST v3 compatible forge' }, {
      'X-OAuth-Scopes': 'repo, workflow, read:org',
      'X-Accepted-OAuth-Scopes': 'repo',
    });
    return;
  }
  if (segs[0] === 'meta' && segs.length === 1) {
    return reply(res, rid, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (segs[0] === 'user') {
    if (segs.length === 1) {
      if (method !== 'GET') return reply(res, rid, 404, { message: 'Not Found' });
      return reply(res, rid, 200, store.user());
    }
    if (segs[1] === 'repos' && segs.length === 2) {
      if (method === 'POST') return createRepo(req, res, store, rid, body);
      if (method === 'GET') return listRepos(req, res, store, rid, query);
      return reply(res, rid, 404, { message: 'Not Found' });
    }
    return reply(res, rid, 404, { message: 'Not Found' });
  }

  // ---- repository routes ------------------------------------------------------------------
  if (segs[0] !== 'repos' || segs.length < 3) return reply(res, rid, 404, { message: 'Not Found' });
  const owner = decode(segs[1]);
  const name = decode(segs[2]);
  const rest = segs.slice(3);
  const repo = store.get(owner, name);
  if (!repo) return reply(res, rid, 404, { message: 'Not Found' });

  if (rest.length === 0) {
    if (method === 'GET') return reply(res, rid, 200, repo);
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string') repo.name = body.name;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string') repo.default_branch = body.default_branch;
      return reply(res, rid, 200, repo);
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      extras.delete(repo.full_name);
      return reply(res, rid, 204);
    }
    return reply(res, rid, 404, { message: 'Not Found' });
  }

  const section = rest[0];

  if (section === 'contents') {
    const path = rest.slice(1).map(decode).join('/').replace(/^\/+/, '');
    if (method === 'PUT') return putContents(res, store, rid, repo, path, body);
    if (method === 'GET') return getContents(res, store, rid, repo, path, query.get('ref') ?? undefined);
    if (method === 'DELETE') return deleteContents(res, store, rid, repo, path, body);
    return reply(res, rid, 404, { message: 'Not Found' });
  }

  if (section === 'labels' && rest.length === 1 && method === 'POST') {
    const labelName = String(body.name ?? '');
    if (labelName === '') return reply(res, rid, 422, { message: 'name is required' });
    const label = store.createLabel(repo, labelName, typeof body.color === 'string' ? body.color : 'ededed', typeof body.description === 'string' ? body.description : '');
    return reply(res, rid, 201, label);
  }

  if (section === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      if (typeof body.ref !== 'string' || typeof body.sha !== 'string') return reply(res, rid, 422, { message: 'ref and sha are required' });
      repo.refs.set(body.ref, body.sha);
      return reply(res, rid, 201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (rest[2] === 'heads' && method === 'GET') {
      const branch = rest.slice(3).map(decode).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return reply(res, rid, 404, { message: 'Ref not found' });
      return reply(res, rid, 200, { ref: `refs/heads/${branch}`, object: { sha } });
    }
    return reply(res, rid, 404, { message: 'Not Found' });
  }

  if (section === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list: Json[] = [];
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        list.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      return reply(res, rid, 200, list);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decode(rest[1]);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return reply(res, rid, 404, { message: 'Branch not found' });
      return reply(res, rid, 200, { name: branch, commit: { sha } });
    }
    return reply(res, rid, 404, { message: 'Not Found' });
  }

  if (section === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = refSha(repo, query.get('sha') ?? undefined);
    const list: Json[] = [];
    let cur = tip;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      const commit = repo.commits.get(cur);
      if (!commit) break;
      seen.add(cur);
      list.push({ sha: commit.sha, commit: { message: commit.message, author: commit.author, committer: commit.committer }, author: commit.author, committer: commit.committer });
      cur = commit.parents[0];
    }
    return reply(res, rid, 200, list);
  }

  if (section === 'issues') return issuesRoute(res, rid, store, repo, rest, method, query, body);
  if (section === 'pulls') return pullsRoute(res, rid, store, repo, rest, method, query, body);


  return reply(res, rid, 404, { message: 'Not Found' });
}

function baseOf(req: IncomingMessage): string {
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'forge.local';
  return `http://${host}`;
}

function createRepo(req: IncomingMessage, res: ServerResponse, store: Store, rid: string, body: Json): void {
  const name = String(body.name ?? '');
  if (name === '') return reply(res, rid, 422, { message: 'name is required' });
  if (store.get(store.login, name)) return reply(res, rid, 422, { message: 'Repository already exists' });
  const repo = store.createRepo(name, typeof body.description === 'string' ? body.description : '');
  if (typeof body.private === 'boolean') repo.private = body.private;
  reply(res, rid, 201, repo);
}

function listRepos(req: IncomingMessage, res: ServerResponse, store: Store, rid: string, query: URLSearchParams): void {
  const ppRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(ppRaw) ? Math.min(100, Math.max(1, ppRaw)) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const all = store.listRepos();
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  if (start + perPage < all.length) {
    const base = `${baseOf(req)}/api/v3/user/repos?per_page=${perPage}`;
    headers['Link'] = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${lastPage}>; rel="last"`;
  }
  reply(res, rid, 200, items, headers);
}

function putContents(res: ServerResponse, store: Store, rid: string, repo: Repo, path: string, body: Json): void {
  const e = extraOf(repo);
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const targetRef = `refs/heads/${branch ?? repo.default_branch}`;
  const parent = repo.refs.get(targetRef);
  const parentTree = treeOf(repo, e, parent);
  const currentBlob = parentTree.get(path);

  if (body.sha !== undefined && String(body.sha) !== currentBlob) {
    return reply(res, rid, 409, { message: 'sha does not match the current file' });
  }

  const bytes = Buffer.from(typeof body.content === 'string' ? body.content : '', 'base64');
  const { content: stored } = store.putContent(repo, path, bytes);
  e.blobs.set(stored.sha, stored);
  const tree = new Map(parentTree);
  tree.set(path, stored.sha);
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
  const commitSha = makeCommit(repo, e, parent, message, tree);
  repo.refs.set(targetRef, commitSha);

  reply(res, rid, currentBlob === undefined ? 201 : 200, {
    content: { sha: stored.sha, name: stored.name, path: stored.path, size: stored.size, encoding: 'base64' },
    commit: { sha: commitSha },
  });
}

function getContents(res: ServerResponse, store: Store, rid: string, repo: Repo, path: string, ref: string | undefined): void {
  const e = extraOf(repo);
  const tree = treeOf(repo, e, refSha(repo, ref));
  const blobSha = tree.get(path);
  if (blobSha !== undefined) {
    const blob = e.blobs.get(blobSha) ?? store.getContent(repo, path);
    if (blob) return reply(res, rid, 200, { ...blob, type: 'file', encoding: 'base64' });
  }

  const prefix = path === '' ? '' : `${path}/`;
  const entries: Json[] = [];
  const seenDirs = new Set<string>();
  for (const [p, sha] of tree) {
    if (prefix !== '' && !p.startsWith(prefix)) continue;
    const tail = prefix === '' ? p : p.slice(prefix.length);
    const slash = tail.indexOf('/');
    if (slash === -1) {
      const blob = e.blobs.get(sha);
      entries.push({ type: 'file', name: tail, path: p, sha, size: blob?.size ?? 0 });
    } else {
      const dirName = tail.slice(0, slash);
      if (!seenDirs.has(dirName)) {
        seenDirs.add(dirName);
        entries.push({ type: 'dir', name: dirName, path: prefix === '' ? dirName : `${prefix}${dirName}`, sha: cryptoHash(`tree:${dirName}`) });
      }
    }
  }
  if (entries.length > 0) return reply(res, rid, 200, entries);
  reply(res, rid, 404, { message: 'Not Found' });
}

function deleteContents(res: ServerResponse, store: Store, rid: string, repo: Repo, path: string, body: Json): void {
  const e = extraOf(repo);
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const targetRef = `refs/heads/${branch ?? repo.default_branch}`;
  const parent = repo.refs.get(targetRef);
  const tree = treeOf(repo, e, parent);
  const currentBlob = tree.get(path);
  if (currentBlob === undefined) return reply(res, rid, 404, { message: 'Not Found' });
  if (body.sha !== undefined && String(body.sha) !== currentBlob) {
    return reply(res, rid, 409, { message: 'sha does not match the current file' });
  }
  const next = new Map(tree);
  next.delete(path);
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
  const commitSha = makeCommit(repo, e, parent, message, next);
  repo.refs.set(targetRef, commitSha);
  store.deleteContent(repo, path);
  reply(res, rid, 200, { commit: { sha: commitSha } });
}

function parseNumber(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function pageSlice<T>(items: T[], query: URLSearchParams): T[] {
  const ppRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pp = Number.isFinite(ppRaw) ? Math.min(100, Math.max(1, ppRaw)) : 30;
  const pRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pRaw) ? Math.max(1, pRaw) : 1;
  return items.slice((page - 1) * pp, page * pp);
}

function issuesRoute(
  res: ServerResponse,
  rid: string,
  store: Store,
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  body: Json,
): void {
  if (rest.length === 1) {
    if (method === 'GET') {
      const state = (query.get('state') ?? 'open').toLowerCase();
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const descending = (query.get('direction') ?? 'desc').toLowerCase() === 'desc';
      list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      return reply(res, rid, 200, pageSlice(list, query));
    }
    if (method === 'POST') {
      const names: string[] = [];
      const rawLabels = Array.isArray(body.labels) ? body.labels : [];
      for (const entry of rawLabels) {
        const labelName = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof (entry as Json).name === 'string' ? (entry as Json).name as string : null;
        if (labelName === null) continue;
        if (!repo.labels.has(labelName)) return reply(res, rid, 422, { message: `Label ${labelName} not found` });
        names.push(labelName);
      }
      try {
        const issue = store.createIssue(repo, String(body.title ?? ''), typeof body.body === 'string' ? body.body : '', names);
        return reply(res, rid, 201, issue);
      } catch {
        return reply(res, rid, 422, { message: 'Unable to create issue' });
      }
    }
    return reply(res, rid, 404, { message: 'Not Found' });
  }

  const number = parseNumber(rest[1]);
  if (number === null) return reply(res, rid, 404, { message: 'Not Found' });
  const issue = repo.issues.get(number);
  if (!issue) return reply(res, rid, 404, { message: 'Not Found' });

  if (rest.length === 2) {
    if (method === 'GET') return reply(res, rid, 200, issue);
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return reply(res, rid, 200, issue);
    }
    return reply(res, rid, 404, { message: 'Not Found' });
  }

  if (rest.length === 3 && rest[2] === 'comments') {
    if (method === 'GET') return reply(res, rid, 200, issue.comments);
    if (method === 'POST') {
      const comment = {
        id: store.id(),
        body: typeof body.body === 'string' ? body.body : '',
        user: store.user(),
        created_at: T0,
        updated_at: T0,
      };
      issue.comments.push(comment);
      issue.comments_count = issue.comments.length;
      return reply(res, rid, 201, comment);
    }
  }
  reply(res, rid, 404, { message: 'Not Found' });
}

function pullsRoute(
  res: ServerResponse,
  rid: string,
  store: Store,
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  body: Json,
): void {
  const e = extraOf(repo);
  if (rest.length === 1) {
    if (method === 'GET') {
      const state = (query.get('state') ?? 'open').toLowerCase();
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => a.number - b.number);
      return reply(res, rid, 200, pageSlice(list, query));
    }
    if (method === 'POST') {
      const head = String(body.head ?? '');
      const base = String(body.base ?? '');
      const pull = store.createPull(repo, String(body.title ?? ''), head, base, typeof body.body === 'string' ? body.body : '');
      pull.files = diffFiles(repo, e, pull) as typeof pull.files;
      return reply(res, rid, 201, pull);
    }
    return reply(res, rid, 404, { message: 'Not Found' });
  }

  const number = parseNumber(rest[1]);
  if (number === null) return reply(res, rid, 404, { message: 'Not Found' });
  const pull = repo.pulls.get(number);
  if (!pull) return reply(res, rid, 404, { message: 'Not Found' });

  if (rest.length === 2 && method === 'GET') return reply(res, rid, 200, pull);

  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return reply(res, rid, 200, pull.files);

  if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePull(res, rid, store, repo, e, pull);

  reply(res, rid, 404, { message: 'Not Found' });
}

function mergePull(res: ServerResponse, rid: string, store: Store, repo: Repo, e: RepoExtra, pull: {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  merged_at: string | null;
  head: { ref: string; sha: string; label: string; repo: string };
  base: { ref: string; sha: string; label: string; repo: string };
  files: { filename: string; status: string; additions: number; deletions: number; patch: string }[];
}): void {
  if (pull.state === 'closed' || pull.merged) return reply(res, rid, 405, { message: 'Pull request is already merged' });

  const ancestor = e.trees.get(pull.base.sha) ?? new Map<string, string>();
  const headTree = e.trees.get(pull.head.sha) ?? new Map<string, string>();
  const targetRef = `refs/heads/${pull.base.ref}`;
  const baseSha = repo.refs.get(targetRef);
  const current = treeOf(repo, e, baseSha);

  // A file changed by the head branch that also changed on base since the merge base conflicts.
  for (const [path, headBlob] of headTree) {
    if (headBlob === ancestor.get(path)) continue;
    if (current.get(path) !== ancestor.get(path)) {
      pull.mergeable = false;
      return reply(res, rid, 405, { message: 'Pull request has conflicts' });
    }
  }

  const mergedTree = new Map(current);
  for (const [path, headBlob] of headTree) mergedTree.set(path, headBlob);
  for (const path of ancestor.keys()) if (!headTree.has(path)) mergedTree.delete(path);

  const message = `Merge pull request #${pull.number} from ${pull.head.label}`;
  const sha = makeCommit(repo, e, baseSha, message, mergedTree);
  repo.refs.set(targetRef, sha);

  // Materialise the merged tree into the store so other surfaces read the same content.
  for (const [path, blobSha] of mergedTree) {
    const blob = e.blobs.get(blobSha);
    if (blob) store.putContent(repo, path, Buffer.from(blob.content, 'base64'));
  }
  for (const path of repo.contents.keys()) if (!mergedTree.has(path)) store.deleteContent(repo, path);

  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = T0;
  (pull as unknown as Json).merge_commit_sha = sha;
  reply(res, rid, 200, { sha, merged: true, message: 'Pull request successfully merged' });
}
