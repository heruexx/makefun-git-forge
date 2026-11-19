// Shared in-memory store for the forge. All ids and timestamps are deterministic:
// trials compare state exports byte for byte, so nothing here reads the clock twice.
export type User = { login: string; id: number; type: 'User' };

export type Label = { id: number; name: string; color: string; description: string | null; default: boolean };
export type Comment = { id: number; body: string; user: User; created_at: string; updated_at: string };
export type Content = { path: string; name: string; sha: string; size: number; type: 'file'; content: string; encoding: 'base64'; download_url: string; html_url: string };
export type Repo = {
  id: number; name: string; owner: string; full_name: string; description: string | null;
  private: boolean; default_branch: string; created_at: string; updated_at: string; pushed_at: string;
  html_url: string; clone_url: string; url: string; topics: string[]; fork: boolean; archived: boolean;
  has_issues: boolean; has_projects: boolean; has_wiki: boolean; size: number;
  labels: Map<string, Label>; issues: Map<number, Issue>; pulls: Map<number, Pull>;
  contents: Map<string, Content>; refs: Map<string, string>; objects: Map<string, Buffer>;
  commits: Map<string, { sha: string; message: string; tree: string; parents: string[]; author: any; committer: any }>;
};
export type Issue = {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; user: User; created_at: string; updated_at: string; comments: Comment[];
  comments_count: number; html_url: string; url: string; pull_request?: { url: string; html_url: string };
};
export type Pull = {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: { ref: string; sha: string; label: string; repo: string };
  base: { ref: string; sha: string; label: string; repo: string };
  merged: boolean; mergeable: boolean; merged_at: string | null;
  user: User; created_at: string; updated_at: string; files: { filename: string; status: string; additions: number; deletions: number; patch: string }[];
  comments: Comment[]; html_url: string; url: string;
};

const T0 = '2026-01-01T00:00:00Z';

export class Store {
  readonly login: string;
  readonly token: string;
  private next = 1;
  readonly repos = new Map<string, Repo>();
  readonly users = new Map<string, User>();
  constructor(login: string, token: string) {
    this.login = login;
    this.token = token;
    this.users.set(login, { login, id: 1, type: 'User' });
  }
  id(): number { return this.next++; }
  user(login = this.login): User {
    let u = this.users.get(login);
    if (!u) { u = { login, id: this.id(), type: 'User' }; this.users.set(login, u); }
    return u;
  }
  full(owner: string, repo: string): string { return `${owner}/${repo}`; }
  get(owner: string, repo: string): Repo | undefined { return this.repos.get(this.full(owner, repo)); }
  createRepo(name: string, description = '', owner = this.login): Repo {
    const full = this.full(owner, name);
    const baseUrl = 'http://forge.local';
    const r: Repo = {
      id: this.id(), name, owner, full_name: full, description: description || null, private: false,
      default_branch: 'main', created_at: T0, updated_at: T0, pushed_at: T0,
      html_url: `${baseUrl}/${full}`, clone_url: `${baseUrl}/${full}.git`, url: `${baseUrl}/api/v3/repos/${full}`,
      topics: [], fork: false, archived: false, has_issues: true, has_projects: false, has_wiki: false, size: 0,
      labels: new Map(), issues: new Map(), pulls: new Map(), contents: new Map(), refs: new Map(),
      objects: new Map(), commits: new Map(),
    };
    this.repos.set(full, r);
    return r;
  }
  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.full(owner, name)); }
  listRepos(): Repo[] { return [...this.repos.values()].filter((r) => r.owner === this.login); }
  createLabel(repo: Repo, name: string, color = 'ededed', description = ''): Label {
    let l = repo.labels.get(name);
    if (!l) {
      l = { id: this.id(), name, color: color.replace(/^#/, ''), description: description || null, default: false };
      repo.labels.set(name, l);
    }
    return l;
  }
  createIssue(repo: Repo, title: string, body = '', labels: string[] = []): Issue {
    const number = (Math.max(0, ...repo.issues.keys()) + 1);
    for (const name of labels) if (!repo.labels.has(name)) throw new Error(`label ${name} not found`);
    const issue: Issue = {
      id: this.id(), number, title, body, state: 'open',
      labels: labels.map((n) => repo.labels.get(n)!), user: this.user(), created_at: T0, updated_at: T0,
      comments: [], comments_count: 0,
      html_url: `${repo.html_url}/issues/${number}`, url: `${repo.url}/issues/${number}`,
    };
    repo.issues.set(number, issue);
    return issue;
  }
  createPull(repo: Repo, title: string, head: string, base: string, body = ''): Pull {
    const number = (Math.max(0, ...repo.pulls.keys()) + 1);
    const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '0'.repeat(40);
    const p: Pull = {
      id: this.id(), number, title, body, state: 'open',
      head: { ref: head, sha: repo.refs.get(`refs/heads/${head}`) ?? '0'.repeat(40), label: `${this.login}:${head}`, repo: repo.full_name },
      base: { ref: base, sha: baseSha, label: `${repo.owner}:${base}`, repo: repo.full_name },
      merged: false, mergeable: true, merged_at: null, user: this.user(), created_at: T0, updated_at: T0,
      files: [], comments: [], html_url: `${repo.html_url}/pull/${number}`, url: `${repo.url}/pulls/${number}`,
    };
    repo.pulls.set(number, p);
    return p;
  }
  putContent(repo: Repo, path: string, bytes: Buffer): { action: 'created' | 'updated'; content: Content } {
    const clean = path.replace(/^\/+/, '');
    const sha = cryptoHash(bytes);
    const prev = repo.contents.get(clean);
    const content: Content = {
      path: clean, name: clean.split('/').pop() ?? clean, sha, size: bytes.length, type: 'file',
      content: bytes.toString('base64'), encoding: 'base64',
      download_url: `${repo.html_url}/raw/${repo.default_branch}/${clean}`,
      html_url: `${repo.html_url}/blob/${repo.default_branch}/${clean}`,
    };
    repo.contents.set(clean, content);
    return { action: prev ? 'updated' : 'created', content };
  }
  getContent(repo: Repo, path: string): Content | undefined { return repo.contents.get(path.replace(/^\/+/, '')); }
  deleteContent(repo: Repo, path: string): boolean { return repo.contents.delete(path.replace(/^\/+/, '')); }
}

import { createHash } from 'node:crypto';
export function cryptoHash(b: Buffer | string): string {
  return createHash('sha1').update(b).digest('hex');
}
