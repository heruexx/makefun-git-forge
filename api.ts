// GraphQL v4 (/api/graphql) and MCP Streamable HTTP (/mcp) handlers for the forge.
// Node stdlib only. All state lives in the shared Store; no clock and no randomness.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repo, Issue, Pull } from './store.ts';

// ------------------------------------------------------------------ shared helpers

const isRecord = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  try { return new URL(raw, 'http://forge.local').pathname; }
  catch { return raw.split('?')[0] ?? raw; }
}

function authOk(req: IncomingMessage, store: Store): boolean {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h.trim());
  return m !== null && m[1] === store.token;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': 'forge-local-request',
    ...extra,
  },);
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer | string) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      size += b.length;
      if (size <= 8 * 1024 * 1024) chunks.push(b);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => reject(e));
  });
}

// ================================================================== GraphQL v4

// ---- tokeniser -------------------------------------------------------
interface Tok { t: 'name' | 'str' | 'int' | 'float' | 'punct'; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (/\s/.test(c) || c === ',') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '"') {
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        let j = i + 3, s = '';
        while (j < n && !(src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"')) { s += src[j]; j++; }
        i = j + 3; out.push({ t: 'str', v: s }); continue;
      }
      let j = i + 1, s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1] ?? '';
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else { s += src[j]; j++; }
      }
      i = j + 1; out.push({ t: 'str', v: s }); continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      out.push({ t: 'punct', v: '...' }); i += 3; continue;
    }
    if ('{}()[]:$@!=|&'.includes(c)) { out.push({ t: 'punct', v: c }); i++; continue; }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < n && /[0-9]/.test(src[j]!)) j++;
      let float = false;
      if (src[j] === '.') { float = true; j++; while (j < n && /[0-9]/.test(src[j]!)) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        float = true; j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && /[0-9]/.test(src[j]!)) j++;
      }
      out.push({ t: float ? 'float' : 'int', v: src.slice(i, j) }); i = j; continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < n && /[_A-Za-z0-9]/.test(src[j]!)) j++;
      out.push({ t: 'name', v: src.slice(i, j) }); i = j; continue;
    }
    i++;
  }
  return out;
}

// ---- AST -------------------------------------------------------------
type VNode =
  | { kind: 'Var'; name: string }
  | { kind: 'Const'; value: any }
  | { kind: 'List'; values: VNode[] }
  | { kind: 'Object'; fields: { name: string; value: VNode }[] };

type Sel =
  | { kind: 'Field'; alias: string; name: string; args: { name: string; value: VNode }[]; sel?: Sel[] }
  | { kind: 'Inline'; typeCondition?: string; sel: Sel[] }
  | { kind: 'Spread'; name: string };

interface OpDef { kind: 'Op'; operation: string; name?: string; sel: Sel[] }
interface FragDef { kind: 'Frag'; name: string; typeCondition?: string; sel: Sel[] }
type Def = OpDef | FragDef;

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }
  private isP(v: string): boolean { const t = this.peek(); return t?.t === 'punct' && t.v === v; }
  private eat(v: string): boolean { if (this.isP(v)) { this.pos++; return true; } return false; }
  private expect(v: string): void { if (!this.eat(v)) throw new Error(`expected ${v}`); }

  parseDocument(): Def[] {
    const defs: Def[] = [];
    while (this.pos < this.toks.length) {
      if (this.isP('{')) {
        defs.push({ kind: 'Op', operation: 'query', sel: this.selectionSet() });
        continue;
      }
      const t = this.next();
      if (!t || t.t !== 'name') { throw new Error('unexpected token in document'); }
      if (t.v === 'query' || t.v === 'mutation' || t.v === 'subscription') {
        const name = this.peek()?.t === 'name' ? this.next()!.v : undefined;
        if (this.isP('(')) this.skipParens();
        this.skipDirectives();
        defs.push({ kind: 'Op', operation: t.v, name, sel: this.selectionSet() });
      } else if (t.v === 'fragment') {
        const name = this.next()?.v ?? '';
        if (this.peek()?.t === 'name' && this.peek()!.v === 'on') { this.next(); }
        const tc = this.next()?.v;
        this.skipDirectives();
        defs.push({ kind: 'Frag', name, typeCondition: tc, sel: this.selectionSet() });
      } else {
        throw new Error(`unexpected definition ${t.v}`);
      }
    }
    return defs;
  }

  private selectionSet(): Sel[] {
    this.expect('{');
    const out: Sel[] = [];
    while (!this.isP('}') && this.pos < this.toks.length) out.push(this.selection());
    this.expect('}');
    return out;
  }

  private selection(): Sel {
    if (this.isP('...')) {
      this.pos++;
      let tc: string | undefined;
      if (this.peek()?.t === 'name' && this.peek()!.v === 'on') {
        this.next(); tc = this.next()?.v;
      }
      this.skipDirectives();
      return { kind: 'Inline', typeCondition: tc, sel: this.selectionSet() };
    }
    const first = this.next();
    if (!first || first.t !== 'name') throw new Error('expected a field name');
    let name = first.v, alias = first.v;
    if (this.isP(':')) {
      this.pos++;
      const second = this.next();
      if (!second || second.t !== 'name') throw new Error('expected a field name after alias');
      name = second.v;
    }
    const args: { name: string; value: VNode }[] = [];
    if (this.eat('(')) {
      while (!this.isP(')') && this.pos < this.toks.length) {
        const an = this.next();
        if (!an || an.t !== 'name') break;
        this.expect(':');
        args.push({ name: an.v, value: this.value() });
      }
      this.expect(')');
    }
    this.skipDirectives();
    const sel = this.isP('{') ? this.selectionSet() : undefined;
    return { kind: 'Field', alias, name, args, sel };
  }

  private value(): VNode {
    const t = this.next();
    if (!t) throw new Error('expected a value');
    if (t.t === 'punct') {
      if (t.v === '$') return { kind: 'Var', name: this.next()?.v ?? '' };
      if (t.v === '[') {
        const values: VNode[] = [];
        while (!this.isP(']') && this.pos < this.toks.length) values.push(this.value());
        this.expect(']');
        return { kind: 'List', values };
      }
      if (t.v === '{') {
        const fields: { name: string; value: VNode }[] = [];
        while (!this.isP('}') && this.pos < this.toks.length) {
          const fn = this.next();
          if (!fn || fn.t !== 'name') break;
          this.eat(':');
          fields.push({ name: fn.v, value: this.value() });
        }
        this.expect('}');
        return { kind: 'Object', fields };
      }
    }
    if (t.t === 'str') return { kind: 'Const', value: t.v };
    if (t.t === 'int' || t.t === 'float') return { kind: 'Const', value: Number(t.v) };
    if (t.t === 'name') {
      if (t.v === 'true') return { kind: 'Const', value: true };
      if (t.v === 'false') return { kind: 'Const', value: false };
      if (t.v === 'null') return { kind: 'Const', value: null };
      return { kind: 'Const', value: t.v }; // enum
    }
    return { kind: 'Const', value: t.v };
  }

  private skipDirectives(): void {
    while (this.isP('@')) {
      this.pos++;
      if (this.peek()?.t === 'name') this.next();
      if (this.isP('(')) this.skipParens();
    }
  }

  private skipParens(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0 && this.pos < this.toks.length) {
      const t = this.next()!;
      if (t.t === 'punct' && t.v === '(') depth++;
      else if (t.t === 'punct' && t.v === ')') depth--;
    }
  }
}

function evaluate(node: VNode, vars: Record<string, any>): any {
  switch (node.kind) {
    case 'Var': return vars?.[node.name];
    case 'Const': return node.value;
    case 'List': return node.values.map((v) => evaluate(v, vars));
    case 'Object': {
      const o: Record<string, any> = {};
      for (const f of node.fields) o[f.name] = evaluate(f.value, vars);
      return o;
    }
  }
}

// ---- schema description (for field validation and introspection) -----
const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', 'createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'avatarUrl', '__typename'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'url', 'issue', 'issues', 'pullRequests', 'pullRequest', '__typename'],
  Ref: ['name', 'oid', '__typename'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'user', 'createdAt', 'updatedAt', 'url', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueEdge: ['node', 'cursor', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'head', 'base', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'url', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', '__typename'],
  PullRequestFileConnection: ['nodes', 'edges', '__typename'],
  PullRequestFile: ['path', 'filename', 'status', 'additions', 'deletions', 'patch', '__typename'],
  Label: ['id', 'name', 'color', 'description', '__typename'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'user', '__typename'],
  IssueCommentEdge: ['node', 'cursor', '__typename'],
  CreateIssuePayload: ['issue', '__typename'],
  CloseIssuePayload: ['issue', '__typename'],
  CreatePullRequestPayload: ['pullRequest', '__typename'],
  MergePullRequestPayload: ['pullRequest', '__typename'],
  AddCommentPayload: ['commentEdge', '__typename'],
  __Type: ['name', 'kind', 'fields', 'enumValues', '__typename'],
  __Field: ['name', '__typename'],
  __EnumValue: ['name', '__typename'],
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'WIKI', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---- opaque global ids ----------------------------------------------
function gid(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}
function decodeGid(value: unknown): { type: string; key: string } | null {
  if (typeof value !== 'string') return null;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const i = text.indexOf(':');
    return i < 0 ? null : { type: text.slice(0, i), key: text.slice(i + 1) };
  } catch { return null; }
}
function repoById(store: Store, id: unknown): Repo | undefined {
  const d = decodeGid(id);
  if (!d || d.type !== 'Repository') return undefined;
  const key = Number(d.key);
  for (const r of store.repos.values()) if (r.id === key) return r;
  return undefined;
}
function issueById(store: Store, id: unknown): Issue | undefined {
  const d = decodeGid(id);
  if (!d || d.type !== 'Issue') return undefined;
  const key = Number(d.key);
  for (const r of store.repos.values()) for (const i of r.issues.values()) if (i.id === key) return i;
  return undefined;
}
function pullById(store: Store, id: unknown): Pull | undefined {
  const d = decodeGid(id);
  if (!d || d.type !== 'PullRequest') return undefined;
  const key = Number(d.key);
  for (const r of store.repos.values()) for (const p of r.pulls.values()) if (p.id === key) return p;
  return undefined;
}

// ---- pull-request changed files (best effort from git objects) -------
interface TreeEntry { name: string; sha: string; mode: string }
function treeEntries(buf: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < buf.length) {
    const space = buf.indexOf(0x20, i);
    if (space < 0 || space - i > 8) break;
    const mode = buf.toString('ascii', i, space);
    if (!/^[0-7]+$/.test(mode)) break;
    const nul = buf.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > buf.length) break;
    const name = buf.toString('utf8', space + 1, nul);
    const sha = buf.toString('hex', nul + 1, nul + 21);
    out.push({ name, sha, mode });
    i = nul + 21;
  }
  return out;
}
function objectBody(repo: Repo, sha: string): Buffer | null {
  const b = repo.objects.get(sha);
  if (!b) return null;
  const head = /^(?:tree|blob|commit) \d+\0/.exec(b.toString('latin1', 0, Math.min(64, b.length)));
  return head ? b.subarray(head[0].length) : b;
}
function walkTree(repo: Repo, sha: string, prefix: string, out: Set<string>, seen: Set<string>, depth: number): void {
  if (depth > 12 || seen.has(sha)) return;
  seen.add(sha);
  const buf = objectBody(repo, sha);
  if (!buf) return;
  for (const e of treeEntries(buf)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (parseInt(e.mode, 8) === 0o40000) walkTree(repo, e.sha, path, out, seen, depth + 1);
    else out.add(path);
  }
}
function changedPaths(store: Store, pull: Pull): string[] {
  if (Array.isArray(pull.files) && pull.files.length > 0) {
    return pull.files.map((f) => f.filename ?? (f as any).path ?? '').filter((p) => p !== '');
  }
  const out = new Set<string>();
  const repo = store.repos.get(pull.base.repo) ?? [...store.repos.values()].find((r) => r.pulls.get(pull.number) === pull);
  if (!repo) return [];
  for (const ref of [`refs/heads/${pull.head.ref}`, `refs/heads/${pull.base.ref}`]) {
    const commitSha = repo.refs.get(ref);
    if (!commitSha) continue;
    const commit = repo.commits.get(commitSha);
    if (commit?.tree) walkTree(repo, commit.tree, '', out, new Set(), 0);
  }
  for (const p of repo.contents.keys()) out.add(p);
  return [...out];
}

// ---- resolver --------------------------------------------------------
type Res =
  | { kind: 'scalar'; value: any }
  | { kind: 'object'; type: string; value: any }
  | { kind: 'list'; type: string; value: any[] }
  | { kind: 'null' };
const S = (value: any): Res => ({ kind: 'scalar', value });
const O = (type: string, value: any): Res => ({ kind: 'object', type, value });
const L = (type: string, value: any[]): Res => ({ kind: 'list', type, value });
const N: Res = { kind: 'null' };

class Executor {
  readonly errors: { message: string }[] = [];
  readonly fragments = new Map<string, FragDef>();
  private vars: Record<string, any> = {};

  private readonly store: Store;
  constructor(store: Store) { this.store = store; }

  execute(op: OpDef, vars: Record<string, any>): Record<string, any> {
    this.vars = vars ?? {};
    const root = op.operation === 'mutation' ? 'Mutation' : op.operation === 'subscription' ? 'Query' : 'Query';
    return this.selectionSet(root, {}, op.sel);
  }

  private selectionSet(type: string, source: any, sels: Sel[], out: Record<string, any> = {}): Record<string, any> {
    for (const sel of sels) {
      if (sel.kind === 'Inline') {
        if (!sel.typeCondition || sel.typeCondition === type) this.selectionSet(type, source, sel.sel, out);
      } else if (sel.kind === 'Spread') {
        const frag = this.fragments.get(sel.name);
        if (frag && (!frag.typeCondition || frag.typeCondition === type)) this.selectionSet(type, source, frag.sel, out);
      } else {
        const args: Record<string, any> = {};
        for (const a of sel.args) args[a.name] = evaluate(a.value, this.vars);
        const res = this.field(type, sel.name, args, source);
        if (res.kind === 'null') out[sel.alias] = null;
        else if (res.kind === 'scalar') out[sel.alias] = res.value;
        else if (res.kind === 'object') out[sel.alias] = res.value == null ? null : this.selectionSet(res.type, res.value, sel.sel ?? []);
        else out[sel.alias] = (res.value ?? []).map((v) => this.selectionSet(res.type, v, sel.sel ?? []));
      }
    }
    return out;
  }

  private field(type: string, name: string, a: Record<string, any>, src: any): Res {
    if (name === '__typename') return S(type);
    const known = FIELDS[type];
    if (!known || !known.includes(name)) {
      this.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
      return N;
    }

    // ---- Query / Mutation ----
    if (type === 'Query' || type === 'Mutation') {
      switch (name) {
        case 'viewer': return O('User', this.store.user());
        case 'repository': {
          const repo = this.store.get(String(a.owner ?? ''), String(a.name ?? ''));
          return repo ? O('Repository', repo) : N;
        }
        case 'node': {
          const d = decodeGid(a.id);
          if (!d) return N;
          if (d.type === 'Repository') {
            const r = repoById(this.store, a.id); return r ? O('Repository', r) : N;
          }
          if (d.type === 'Issue') {
            const i = issueById(this.store, a.id); return i ? O('Issue', i) : N;
          }
          if (d.type === 'PullRequest') {
            const p = pullById(this.store, a.id); return p ? O('PullRequest', p) : N;
          }
          return N;
        }
        case '__type': return O('__Type', { name: String(a.name ?? '') });
        case 'createIssue': {
          const input = isRecord(a.input) ? a.input : {};
          const repo = repoById(this.store, input.repositoryId);
          if (!repo) return N;
          const issue = this.store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
          return O('CreateIssuePayload', { issue });
        }
        case 'closeIssue': {
          const input = isRecord(a.input) ? a.input : {};
          const issue = issueById(this.store, input.issueId);
          if (issue) issue.state = 'closed';
          return issue ? O('CloseIssuePayload', { issue }) : N;
        }
        case 'createPullRequest': {
          const input = isRecord(a.input) ? a.input : {};
          const repo = repoById(this.store, input.repositoryId);
          if (!repo) return N;
          const pull = this.store.createPull(
            repo,
            String(input.title ?? ''),
            String(input.headRefName ?? ''),
            String(input.baseRefName ?? ''),
            typeof input.body === 'string' ? input.body : '',
          );
          return O('CreatePullRequestPayload', { pullRequest: pull });
        }
        case 'mergePullRequest': {
          const input = isRecord(a.input) ? a.input : {};
          const pull = pullById(this.store, input.pullRequestId);
          if (pull) { pull.merged = true; pull.state = 'closed'; pull.merged_at = pull.created_at; }
          return pull ? O('MergePullRequestPayload', { pullRequest: pull }) : N;
        }
        case 'addComment': {
          const input = isRecord(a.input) ? a.input : {};
          const issue = issueById(this.store, input.subjectId);
          if (!issue) return N;
          const comment = {
            id: this.store.id(),
            body: typeof input.body === 'string' ? input.body : '',
            user: this.store.user(),
            created_at: issue.created_at,
            updated_at: issue.created_at,
          };
          issue.comments.push(comment as any);
          issue.comments_count += 1;
          return O('AddCommentPayload', { edge: { node: comment } });
        }
        default: return N;
      }
    }

    // ---- Repository ----
    if (type === 'Repository') {
      const repo = src as Repo;
      switch (name) {
        case 'id': return S(gid('Repository', repo.id));
        case 'databaseId': return S(repo.id);
        case 'name': return S(repo.name);
        case 'nameWithOwner': return S(repo.full_name);
        case 'description': return S(repo.description);
        case 'url': return S(repo.url);
        case 'owner': return O('User', this.store.user(repo.owner));
        case 'defaultBranchRef': return O('Ref', { name: repo.default_branch, oid: repo.refs.get(`refs/heads/${repo.default_branch}`) ?? '' });
        case 'viewerPermission': return S('ADMIN');
        case 'hasIssuesEnabled': return S(repo.has_issues);
        case 'issue': {
          const issue = repo.issues.get(Number(a.number));
          return issue ? O('Issue', issue) : N;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(a.number));
          return pull ? O('PullRequest', pull) : N;
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          if (Array.isArray(a.states) && a.states.length > 0) {
            const states = a.states.map((s: any) => String(s).toUpperCase());
            issues = issues.filter((i) => states.includes(i.state.toUpperCase()));
          }
          const order = isRecord(a.orderBy) ? a.orderBy : {};
          const asc = String(order.direction ?? '').toUpperCase() === 'ASC';
          issues.sort((x, y) => asc ? x.number - y.number : y.number - x.number);
          const first = typeof a.first === 'number' && a.first >= 0 ? a.first : issues.length;
          const offset = cursorOffset(a.after);
          const slice = issues.slice(offset, offset + first);
          const end = offset + slice.length;
          return O('IssueConnection', {
            pageIssues: slice,
            hasNextPage: end < issues.length,
            hasPreviousPage: offset > 0,
            startCursor: cursorFor(offset),
            endCursor: cursorFor(end),
            totalCount: issues.length,
          });
        }
        case 'pullRequests': {
          const pulls = [...repo.pulls.values()].sort((x, y) => y.number - x.number);
          const first = typeof a.first === 'number' && a.first >= 0 ? a.first : pulls.length;
          return O('PullRequestConnection', { nodes: pulls.slice(0, first), totalCount: pulls.length });
        }
        default: return N;
      }
    }

    // ---- connections ----
    if (type === 'IssueConnection') {
      const c = src;
      switch (name) {
        case 'nodes': return L('Issue', c.pageIssues ?? []);
        case 'edges': return L('IssueEdge', (c.pageIssues ?? []).map((i: Issue) => ({ node: i, cursor: gid('Issue', i.id) })));
        case 'totalCount': return S(c.totalCount ?? 0);
        case 'pageInfo':
        case 'pageinfo': return O('PageInfo', c);
        default: return N;
      }
    }
    if (type === 'IssueEdge') {
      if (name === 'node') return O('Issue', src.node);
      if (name === 'cursor') return S(src.cursor);
      return N;
    }
    if (type === 'PageInfo') {
      switch (name) {
        case 'hasNextPage': return S(!!src.hasNextPage);
        case 'hasPreviousPage': return S(!!src.hasPreviousPage);
        case 'startCursor': return S(src.startCursor ?? '');
        case 'endCursor': return S(src.endCursor ?? '');
        default: return N;
      }
    }
    if (type === 'PullRequestConnection') {
      if (name === 'nodes') return L('PullRequest', src.nodes ?? []);
      if (name === 'totalCount') return S(src.totalCount ?? 0);
      return N;
    }

    // ---- Issue ----
    if (type === 'Issue') {
      const i = src as Issue;
      switch (name) {
        case 'id': return S(gid('Issue', i.id));
        case 'number': return S(i.number);
        case 'title': return S(i.title);
        case 'state': return S(i.state.toUpperCase());
        case 'body': return S(i.body);
        case 'labels': return L('Label', i.labels ?? []);
        case 'comments': return L('IssueComment', i.comments ?? []);
        case 'user': return O('User', i.user ?? this.store.user());
        case 'createdAt': return S(i.created_at);
        case 'updatedAt': return S(i.updated_at);
        case 'url': return S(i.url);
        default: return N;
      }
    }

    // ---- PullRequest ----
    if (type === 'PullRequest') {
      const p = src as Pull;
      switch (name) {
        case 'id': return S(gid('PullRequest', p.id));
        case 'number': return S(p.number);
        case 'title': return S(p.title);
        case 'body': return S(p.body);
        case 'state': return S(p.state.toUpperCase());
        case 'merged': return S(!!p.merged);
        case 'mergeable': return S(p.mergeable ? 'MERGEABLE' : 'CONFLICTING');
        case 'headRefName': return S(p.head.ref);
        case 'baseRefName': return S(p.base.ref);
        case 'head': return O('Ref', { name: p.head.ref, oid: p.head.sha });
        case 'base': return O('Ref', { name: p.base.ref, oid: p.base.sha });
        case 'createdAt': return S(p.created_at);
        case 'updatedAt': return S(p.updated_at);
        case 'mergedAt': return S(p.merged_at);
        case 'url': return S(p.url);
        case 'files': {
          const files = changedPaths(this.store, p).map((path) => ({ path, filename: path, status: 'modified', additions: 0, deletions: 0, patch: '' }));
          return O('PullRequestFileConnection', { nodes: files });
        }
        default: return N;
      }
    }
    if (type === 'PullRequestFileConnection') {
      if (name === 'nodes') return L('PullRequestFile', src.nodes ?? []);
      return N;
    }
    if (type === 'PullRequestFile') {
      const f = src;
      if (name === 'path' || name === 'filename') return S(f.path ?? f.filename ?? '');
      if (name === 'status') return S(f.status ?? 'modified');
      if (name === 'additions') return S(f.additions ?? 0);
      if (name === 'deletions') return S(f.deletions ?? 0);
      if (name === 'patch') return S(f.patch ?? '');
      return N;
    }

    // ---- payloads / labels / comments / user / ref ----
    if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
      return name === 'issue' ? O('Issue', src.issue) : N;
    }
    if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
      return name === 'pullRequest' ? O('PullRequest', src.pullRequest) : N;
    }
    if (type === 'AddCommentPayload') {
      return name === 'commentEdge' ? O('IssueCommentEdge', src.edge) : N;
    }
    if (type === 'IssueCommentEdge') {
      return name === 'node' ? O('IssueComment', src.node) : N;
    }
    if (type === 'Label') {
      const l = src;
      if (name === 'id') return S(l.id);
      if (name === 'name') return S(l.name);
      if (name === 'color') return S(l.color);
      if (name === 'description') return S(l.description);
      return N;
    }
    if (type === 'IssueComment') {
      const c = src;
      if (name === 'id') return S(gid('IssueComment', c.id));
      if (name === 'body') return S(c.body);
      if (name === 'createdAt') return S(c.created_at);
      if (name === 'updatedAt') return S(c.updated_at);
      if (name === 'user') return O('User', c.user ?? this.store.user());
      return N;
    }
    if (type === 'User') {
      if (name === 'login') return S(src.login);
      if (name === 'id') return S(gid('User', src.id));
      if (name === 'name') return S(src.login);
      if (name === 'avatarUrl') return S(`http://forge.local/avatars/${src.login}`);
      return N;
    }
    if (type === 'Ref') {
      if (name === 'name') return S(src.name);
      if (name === 'oid') return S(src.oid ?? '');
      return N;
    }

    // ---- introspection ----
    if (type === '__Type') {
      if (name === 'name') return S(src.name);
      if (name === 'kind') return S(ENUMS[src.name] ? 'ENUM' : 'OBJECT');
      if (name === 'fields') return L('__Field', (FIELDS[src.name] ?? []).map((n) => ({ name: n })));
      if (name === 'enumValues') return L('__EnumValue', (ENUMS[src.name] ?? []).map((n) => ({ name: n })));
      return N;
    }
    if (type === '__Field' || type === '__EnumValue') {
      return name === 'name' ? S(src.name) : N;
    }
    return N;
  }
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}
function cursorOffset(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const n = Number(text.replace(/^cursor:/, ''));
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

function executeGraphQLOne(op: unknown, store: Store): Record<string, any> {
  if (!isRecord(op) || typeof op.query !== 'string') {
    return { data: null, errors: [{ message: 'A GraphQL request needs a query string.' }] };
  }
  try {
    const defs = new Parser(tokenize(op.query)).parseDocument();
    const vars = isRecord(op.variables) ? op.variables : {};
    const exec = new Executor(store);
    for (const def of defs) {
      if (def.kind === 'Frag') { exec.fragments.set(def.name, def); continue; }
      if (typeof op.operationName === 'string' && def.name && op.operationName !== def.name) continue;
      const data = exec.execute(def, vars);
      const out: Record<string, any> = { data };
      if (exec.errors.length > 0) out.errors = exec.errors;
      return out;
    }
    return { data: null };
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}

export function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): boolean {
  if (pathOf(req) !== '/api/graphql') return false;
  if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return true; }
  if (!authOk(req, store)) { sendJson(res, 401, { message: 'Requires authentication' }); return true; }
  readBody(req).then((text) => {
    let body: unknown;
    try { body = JSON.parse(text); }
    catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
    if (Array.isArray(body)) {
      sendJson(res, 200, body.map((op) => executeGraphQLOne(op, store)));
    } else {
      sendJson(res, 200, executeGraphQLOne(body, store));
    }
  }).catch(() => { sendJson(res, 400, { message: 'Bad request' }); });
  return true;
}

// ================================================================== MCP

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, any>; required?: string[] };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    title: 'Create a repository',
    description: 'Create a new repository owned by the authenticated user (or the given owner). Returns the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Account that owns the new repository.' },
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'Short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    title: 'Get a repository',
    description: 'Read a repository by owner and name. Returns the repository object including its id and full name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Account that owns the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    title: 'Create an issue',
    description: 'Open a new issue in a repository with a title and optional body. Returns the created issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues in a repository, optionally filtered by open or closed state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Filter by state: open or closed.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create a pull request',
    description: 'Open a pull request from a head branch into a base branch. Returns the created pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch containing the changes.' },
        base: { type: 'string', description: 'Base branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge a pull request',
    description: 'Merge a pull request by number, closing it and recording merged: true. Returns the merged pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type RpcId = string | number | null;
function rpcOk(id: RpcId, result: unknown): Record<string, any> {
  return { jsonrpc: '2.0', id, result };
}
function rpcErr(id: RpcId, code: number, message: string): Record<string, any> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function toolResult(id: RpcId, result: Record<string, any>): Record<string, any> {
  return rpcOk(id, result);
}

function repoObject(repo: Repo): Record<string, any> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    default_branch: repo.default_branch,
    html_url: repo.html_url,
    url: repo.url,
  };
}
function issueObject(issue: Issue): Record<string, any> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: (issue.labels ?? []).map((l) => l.name),
    user: { login: issue.user?.login },
    created_at: issue.created_at,
    html_url: issue.html_url,
    url: issue.url,
  };
}
function pullObject(pull: Pull): Record<string, any> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merged_at: pull.merged_at,
    html_url: pull.html_url,
    url: pull.url,
  };
}

function toolDispatch(name: string, args: Record<string, any>, store: Store): { value?: any; error?: string } {
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : store.login;
  const full = typeof args.full_name === 'string' ? args.full_name.split('/') : [];
  const repoName = typeof args.repo === 'string' && args.repo !== ''
    ? args.repo
    : (full.length === 2 ? full[1]! : '');
  const findRepo = (): Repo | undefined => store.get(owner, repoName);

  switch (name) {
    case 'create_repo':
      return { value: repoObject(store.createRepo(String(args.name), typeof args.description === 'string' ? args.description : '', owner)) };
    case 'get_repo': {
      const repo = findRepo();
      return repo ? { value: repoObject(repo) } : { error: `Repository ${owner}/${repoName} was not found` };
    }
    case 'create_issue': {
      const repo = findRepo();
      if (!repo) return { error: `Repository ${owner}/${repoName} was not found` };
      return { value: issueObject(store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '')) };
    }
    case 'list_issues': {
      const repo = findRepo();
      if (!repo) return { error: `Repository ${owner}/${repoName} was not found` };
      let issues = [...repo.issues.values()];
      if (typeof args.state === 'string') {
        const state = args.state.toLowerCase();
        if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
      }
      return { value: { issues: issues.map(issueObject) } };
    }
    case 'create_pull_request': {
      const repo = findRepo();
      if (!repo) return { error: `Repository ${owner}/${repoName} was not found` };
      const pull = store.createPull(repo, String(args.title), String(args.head), String(args.base), typeof args.body === 'string' ? args.body : '');
      return { value: pullObject(pull) };
    }
    case 'merge_pull_request': {
      const repo = findRepo();
      if (!repo) return { error: `Repository ${owner}/${repoName} was not found` };
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) return { error: `Pull request #${number} was not found` };
      pull.merged = true;
      pull.state = 'closed';
      pull.merged_at = pull.created_at;
      return { value: pullObject(pull) };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

function rpcHandle(msg: unknown, store: Store): Record<string, any> | null {
  if (!isRecord(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcErr(null, -32600, 'Invalid Request');
  }
  const id: RpcId = (msg.id === undefined || msg.id === null) ? null : (msg.id as RpcId);
  const params = isRecord(msg.params) ? msg.params : {};
  switch (msg.method) {
    case 'server/discover':
      return rpcOk(id, {
        resultType: 'server/discover',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { ...SERVER_INFO },
        instructions: 'A GitHub-compatible forge over the Model Context Protocol.',
        _meta: {},
      });
    case 'initialize':
      return rpcOk(id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { ...SERVER_INFO },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return rpcOk(id, {});
    case 'resources/list':
      return rpcOk(id, { resources: [] });
    case 'prompts/list':
      return rpcOk(id, { prompts: [] });
    case 'tools/list':
      return rpcOk(id, { tools: TOOLS.map((t) => ({ ...t })) });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name)) {
        return rpcErr(id, -32602, `Unknown tool: ${String(name)}`);
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOLS.find((t) => t.name === name)!;
      const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return toolResult(id, {
          content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }],
          isError: true,
        });
      }
      try {
        const outcome = toolDispatch(name, args, store);
        if (outcome.error !== undefined) {
          return toolResult(id, { content: [{ type: 'text', text: outcome.error }], isError: true });
        }
        return toolResult(id, {
          content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
          structuredContent: outcome.value,
        });
      } catch (e) {
        return toolResult(id, {
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        });
      }
    }
    default:
      return rpcErr(id, -32601, 'Method not found');
  }
}

export function handleMCP(req: IncomingMessage, res: ServerResponse, store: Store): boolean {
  if (pathOf(req) !== '/mcp') return false;
  if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return true; }
  if (!authOk(req, store)) { sendJson(res, 401, { message: 'Requires authentication' }); return true; }
  readBody(req).then((text) => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const responses = items
      .map((msg: unknown) => rpcHandle(msg, store))
      .filter((r): r is Record<string, any> => r !== null);
    if (responses.length === 0) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': 0 });
      res.end();
      return;
    }
    sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0]);
  }).catch(() => {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  });
  return true;
}
