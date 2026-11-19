// Git smart-HTTP for the github-core-clone-01 forge.
//
// Handles GET  /{owner}/{repo}.git/info/refs?service=...   (v0 + v2 advertisements)
//       POST /{owner}/{repo}.git/git-upload-pack           (v2 ls-refs / fetch, v0 fetch)
//       POST /{owner}/{repo}.git/git-receive-pack          (v0 commands + pack, report-status)
//
// Node built-ins only. No git binary, no npm. Everything is wrapped so a malformed
// peer can never take the process down.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Repo, Store } from './store.ts';

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
type TreeEntry = { mode: string; name: string; oid: string };

const ZERO = '0'.repeat(40);
const PKT_LINE_MAX = 65520;
const PKT_PAYLOAD_MAX = PKT_LINE_MAX - 4;
const FLUSH = Buffer.from('0000', 'ascii');
const AGENT = 'git/2.39.0';
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// -------------------------------------------------------------------------------------------
// small helpers
// -------------------------------------------------------------------------------------------

const typesByRepo = new WeakMap<Repo, Map<string, GitObjectType>>();

function typeMap(repo: Repo): Map<string, GitObjectType> {
  let m = typesByRepo.get(repo);
  if (!m) { m = new Map(); typesByRepo.set(repo, m); }
  return m;
}

function setType(repo: Repo, oid: string, type: GitObjectType): void {
  typeMap(repo).set(oid, type);
}

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry has no id');
    const mode = data.subarray(i, sp).toString('ascii');
    if (!/^[0-7]+$/.test(mode)) throw new Error('tree entry has a bad mode');
    out.push({
      mode,
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return out;
}

function parseCommit(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const blank = data.indexOf('\n\n');
  const header = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

function parseTag(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const header = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  let object = '';
  let type = '';
  for (const line of header.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    if (key === 'object') object = line.slice(sp + 1);
    else if (key === 'type') type = line.slice(sp + 1);
  }
  return { object, type };
}

function objectType(repo: Repo, oid: string, data: Buffer): GitObjectType {
  const known = typeMap(repo).get(oid);
  if (known) return known;
  const head = data.subarray(0, 46).toString('latin1');
  if (/^tree [0-9a-f]{40}\n/.test(head)) return 'commit';
  if (/^object [0-9a-f]{40}\n/.test(head)) return 'tag';
  try { parseTree(data); return 'tree'; } catch { /* a blob may look tree-ish; fall through */ }
  return 'blob';
}

function hashObject(type: GitObjectType, data: Buffer): string {
  const hdr = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return createHash('sha1').update(hdr).update(data).digest('hex');
}

function recordCommit(repo: Repo, oid: string, data: Buffer): void {
  const c = parseCommit(data);
  repo.commits.set(oid, {
    sha: oid, message: c.message, tree: c.tree, parents: c.parents,
    author: c.author, committer: c.committer,
  });
}

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const h = Buffer.allocUnsafe(4);
  h.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}

function line(text: string): Buffer {
  return pkt(`${text}\n`);
}

/** Decode pkt-lines from the start of a buffer, stopping at the first flush.
 *  `offset` is the byte just past the flush — in receive-pack the packfile starts there. */
function readPktLines(buf: Buffer): { payloads: Buffer[]; offset: number } {
  const payloads: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (!HEX4.test(hex)) throw new Error(`invalid pkt-line header ${JSON.stringify(hex)}`);
    const len = Number.parseInt(hex, 16);
    off += 4;
    if (len === 0) return { payloads, offset: off };
    if (len === 1 || len === 2) continue;
    if (len === 3) throw new Error('invalid pkt-line length 3');
    if (len > PKT_LINE_MAX || off + (len - 4) > buf.length) throw new Error('pkt-line is truncated');
    payloads.push(buf.subarray(off, off + len - 4));
    off += len - 4;
  }
  return { payloads, offset: off };
}

/** Decode all pkt-lines in a body, skipping flush/delim markers (fetch has two sections in v0). */
function readAllPktLines(buf: Buffer): Buffer[] {
  const payloads: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (!HEX4.test(hex)) throw new Error(`invalid pkt-line header ${JSON.stringify(hex)}`);
    const len = Number.parseInt(hex, 16);
    off += 4;
    if (len === 0 || len === 1 || len === 2) continue;
    if (len === 3) throw new Error('invalid pkt-line length 3');
    if (len > PKT_LINE_MAX || off + (len - 4) > buf.length) throw new Error('pkt-line is truncated');
    payloads.push(buf.subarray(off, off + len - 4));
    off += len - 4;
  }
  return payloads;
}

function textOf(payload: Buffer): string {
  return payload.toString('utf8').replace(/\n$/, '');
}

// -------------------------------------------------------------------------------------------
// packfile read
// -------------------------------------------------------------------------------------------

type ResolvedObject = { oid: string; type: GitObjectType; data: Buffer };

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta size varint truncated');
      const b = delta[pos++];
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (pos >= delta.length) throw new Error('delta copy offset truncated');
          copyOffset += delta[pos++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (pos >= delta.length) throw new Error('delta copy size truncated');
          copySize += delta[pos++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > targetSize) throw new Error('delta copy out of range');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      if (pos + n > delta.length || written + n > targetSize) throw new Error('delta insert out of range');
      delta.copy(out, written, pos, pos + n);
      pos += n;
      written += n;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

type RawPackEntry = {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: ResolvedObject;
};

function readPack(buf: Buffer, repo: Repo): ResolvedObject[] {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let off = 12;

  for (let index = 0; index < count; index += 1) {
    const entryOffset = off;
    if (off >= trailer) throw new Error('pack entry header truncated');
    let byte = buf[off++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (off >= trailer) throw new Error('pack size varint truncated');
      byte = buf[off++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack size varint too long');
    }
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (off >= trailer) throw new Error('ofs-delta truncated');
      byte = buf[off++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (off >= trailer) throw new Error('ofs-delta base offset truncated');
        byte = buf[off++];
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error('bad ofs-delta base offset');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (off + 20 > trailer) throw new Error('ref-delta base id truncated');
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const view = buf.subarray(off, trailer);
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    } catch (err) {
      throw new Error(`pack object at ${entryOffset} did not inflate: ${(err as Error).message}`);
    }
    const written = inflated.engine.bytesWritten;
    if (!written || written <= 0 || inflated.buffer.length !== size) throw new Error('pack object size mismatch');
    entry.data = Buffer.from(inflated.buffer);
    off += written;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailer) throw new Error('pack has stray bytes before its trailer');

  const byOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): ResolvedObject => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset!);
      if (!base) throw new Error('ofs-delta base missing');
      const resolvedBase = resolve(base);
      type = resolvedBase.type;
      data = applyDelta(resolvedBase.data, entry.data);
    } else if (entry.typeCode === 7) {
      const base = byOid.get(entry.baseOid!) ?? (() => {
        const bytes = repo.objects.get(entry.baseOid!);
        return bytes ? { offset: -1, typeCode: 0, size: bytes.length, data: bytes } as unknown as RawPackEntry : undefined;
      })();
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} is missing`);
      const resolvedBase = base.offset === -1
        ? { type: objectType(repo, entry.baseOid!, base.data), data: base.data }
        : resolve(base);
      type = resolvedBase.type;
      data = applyDelta(resolvedBase.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const result: ResolvedObject = { type, data, oid: hashObject(type, data) };
    entry.resolved = result;
    byOid.set(result.oid, entry);
    resolving.delete(entry.offset);
    return result;
  };

  const out: ResolvedObject[] = [];
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!out.some((o) => o.oid === resolved.oid)) out.push(resolved);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// packfile write (plain objects only — the suite's packs are plain, and plain is always valid)
// -------------------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: ResolvedObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// -------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------

function treeClosure(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const data = repo.objects.get(oid);
    if (!data) continue;
    out.add(oid);
    if (objectType(repo, oid, data) !== 'tree') continue;
    for (const entry of parseTree(data)) {
      if (entry.mode === '160000') continue; // a gitlink names an object this repo does not hold
      stack.push(entry.oid);
    }
  }
}

type Closure = { oids: Set<string>; boundaries: Set<string> };

/** Closure from `roots`. A commit-depth of n includes n generations of commits and stops
 *  before their parents; those stopped commits are returned as new shallow boundaries. */
function wantClosure(repo: Repo, roots: string[], commitDepth: number | null): Closure {
  const oids = new Set<string>();
  const boundaries = new Set<string>();
  const seen = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = roots.map((oid) => ({ oid, depth: commitDepth ?? Number.POSITIVE_INFINITY }));
  while (queue.length) {
    const item = queue.shift()!;
    const prior = seen.get(item.oid);
    if (prior !== undefined && prior >= item.depth) continue;
    seen.set(item.oid, item.depth);
    const data = repo.objects.get(item.oid);
    if (!data) continue;
    const type = objectType(repo, item.oid, data);
    oids.add(item.oid);
    if (type === 'commit') {
      const c = parseCommit(data);
      treeClosure(repo, c.tree, oids);
      if (item.depth === 1 && c.parents.length) {
        boundaries.add(item.oid);
      } else {
        for (const parent of c.parents) queue.push({ oid: parent, depth: item.depth - 1 });
      }
    } else if (type === 'tag') {
      const t = parseTag(data);
      if (HEX40.test(t.object)) queue.push({ oid: t.object, depth: item.depth });
    } else if (type === 'tree') {
      treeClosure(repo, item.oid, oids);
    }
  }
  return { oids, boundaries };
}

/** What the client already has. Traversal stops at the client's shallow boundaries. */
function haveClosure(repo: Repo, roots: string[], shallow: Set<string>): Set<string> {
  const oids = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.shift()!;
    if (oids.has(oid)) continue;
    const data = repo.objects.get(oid);
    if (!data) continue;
    const type = objectType(repo, oid, data);
    oids.add(oid);
    if (type === 'commit') {
      const c = parseCommit(data);
      treeClosure(repo, c.tree, oids);
      if (shallow.has(oid)) continue;
      for (const parent of c.parents) queue.push(parent);
    } else if (type === 'tag') {
      const t = parseTag(data);
      if (HEX40.test(t.object)) queue.push(t.object);
    } else if (type === 'tree') {
      treeClosure(repo, oid, oids);
    }
  }
  return oids;
}

function peelTag(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (let i = 0; i < 16; i += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    const data = repo.objects.get(current);
    if (!data || objectType(repo, current, data) !== 'tag') return i === 0 ? null : current;
    const target = parseTag(data).object;
    if (!HEX40.test(target)) return null;
    current = target;
  }
  return null;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const data = repo.objects.get(oid);
    if (!data || objectType(repo, oid, data) !== 'commit') continue;
    for (const parent of parseCommit(data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].filter(([, oid]) => HEX40.test(oid)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// -------------------------------------------------------------------------------------------
// HTTP helpers
// -------------------------------------------------------------------------------------------

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  try {
    if (res.headersSent) { res.end(); return; }
    res.statusCode = status;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  } catch { /* a peer that vanished must not take the process down */ }
}

function fail(res: ServerResponse): void {
  send(res, 500, 'text/plain', Buffer.from('git server error\n'));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

function advertise(res: ServerResponse, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): void {
  const parts: Buffer[] = [line(`# service=${service}`)];
  const headTarget = `refs/heads/${repo.default_branch}`;
  const headOid = repo.refs.get(headTarget);

  if (v2) {
    parts.push(line('version 2'));
    parts.push(line('ls-refs=unborn'));
    parts.push(line('fetch=shallow wait-for-done filter'));
    parts.push(line(`object-format=sha1`));
    parts.push(line(`agent=${AGENT}`));
    parts.push(FLUSH);
    send(res, 200, `application/x-${service}-advertisement`, Buffer.concat(parts));
    return;
  }

  const caps: string[] = service === 'git-receive-pack'
    ? ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'quiet', `agent=${AGENT}`]
    : ['multi_ack_detailed', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'no-progress', 'include-tag', `agent=${AGENT}`];
  if (headOid && HEX40.test(headOid)) caps.push(`symref=HEAD:${headTarget}`);

  const entries: Array<{ oid: string; name: string }> = [];
  if (headOid && HEX40.test(headOid)) entries.push({ oid: headOid, name: 'HEAD' });
  for (const [name, oid] of sortedRefs(repo)) entries.push({ oid, name });
  if (!entries.length) entries.push({ oid: ZERO, name: 'capabilities^{}' });

  entries.forEach((entry, index) => {
    parts.push(pkt(`${entry.oid} ${entry.name}${index === 0 ? `\u0000${caps.join(' ')}` : ''}\n`));
    if (entry.name.startsWith('refs/tags/')) {
      const peeled = peelTag(repo, entry.oid);
      if (peeled) parts.push(line(`${peeled} ${entry.name}^{}`));
    }
  });
  parts.push(FLUSH);
  send(res, 200, `application/x-${service}-advertisement`, Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// -------------------------------------------------------------------------------------------

function lsRefs(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { payloads } = readPktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const payload of payloads) {
    const text = textOf(payload);
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const headTarget = `refs/heads/${repo.default_branch}`;
  const headOid = repo.refs.get(headTarget);
  const out: Buffer[] = [];
  if (keep('HEAD')) {
    if (headOid && HEX40.test(headOid)) {
      out.push(line(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`));
    } else if (unborn) {
      out.push(line(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let text = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = peelTag(repo, oid);
      if (peeled) text += ` peeled:${peeled}`;
    }
    out.push(line(text));
  }
  out.push(FLUSH);
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// -------------------------------------------------------------------------------------------
// fetch
// -------------------------------------------------------------------------------------------

function fetch(repo: Repo, body: Buffer, res: ServerResponse, v2: boolean): void {
  const payloads = readAllPktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const payload of payloads) {
    const text = textOf(payload);
    if (text.startsWith('want ')) {
      const oid = text.slice(5).trim().split(/\s+/)[0];
      if (HEX40.test(oid)) wants.push(oid);
    } else if (text.startsWith('have ')) {
      const oid = text.slice(5).trim();
      if (HEX40.test(oid)) haves.push(oid);
    } else if (text.startsWith('shallow ')) {
      const oid = text.slice(8).trim();
      if (HEX40.test(oid)) shallow.push(oid);
    } else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }

  const shallowSet = new Set(shallow);
  const haveSet = haveClosure(repo, haves, shallowSet);
  const wanted = wantClosure(repo, wants, depth);
  const sendOids = [...wanted.oids].filter((oid) => !haveSet.has(oid));
  const objects: ResolvedObject[] = [];
  for (const oid of sendOids) {
    const data = repo.objects.get(oid);
    if (!data) continue;
    objects.push({ oid, type: objectType(repo, oid, data), data });
  }
  const pack = writePack(objects);

  const info: string[] = [];
  for (const oid of wanted.boundaries) info.push(`shallow ${oid}`);
  if (shallowSet.size) {
    for (const boundary of shallowSet) {
      const data = repo.objects.get(boundary);
      if (!data || objectType(repo, boundary, data) !== 'commit') continue;
      if (parseCommit(data).parents.some((parent) => wanted.oids.has(parent))) info.push(`unshallow ${boundary}`);
    }
  }

  const out: Buffer[] = [];
  if (v2) {
    out.push(line('acknowledgments'));
    out.push(line('NAK'));
    out.push(FLUSH);
    if (info.length) {
      out.push(line('shallow-info'));
      for (const text of info) out.push(line(text));
      out.push(FLUSH);
    }
    out.push(line('packfile'));
    for (let i = 0; i < pack.length; i += 60000) {
      const chunk = pack.subarray(i, i + 60000);
      out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    }
    out.push(FLUSH);
    out.push(FLUSH);
  } else {
    out.push(line('NAK'));
    for (let i = 0; i < pack.length; i += 60000) {
      const chunk = pack.subarray(i, i + 60000);
      out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    }
    out.push(FLUSH);
  }
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

type Command = { oldOid: string; newOid: string; ref: string };
type Verdict = { ref: string; ok: boolean; reason: string };

function applyCommand(repo: Repo, command: Command): Verdict {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO) {
    if (current === undefined || current === command.oldOid) {
      repo.refs.delete(command.ref);
      return { ref: command.ref, ok: true, reason: '' };
    }
    return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
  }
  if (command.oldOid === ZERO) {
    if (current !== undefined) return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
    repo.refs.set(command.ref, command.newOid);
    return { ref: command.ref, ok: true, reason: '' };
  }
  if (current === undefined || current !== command.oldOid) return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
  if (current === command.newOid) return { ref: command.ref, ok: true, reason: '' };
  if (!repo.objects.has(command.newOid)) return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
  if (!isAncestor(repo, command.oldOid, command.newOid)) return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true, reason: '' };
}

function receive(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { payloads, offset } = readPktLines(body);
  const commands: Command[] = [];
  let caps: string[] = [];
  for (const payload of payloads) {
    const nul = payload.indexOf(0);
    const meta = nul >= 0 ? payload.subarray(nul + 1).toString('utf8') : '';
    if (nul >= 0 && caps.length === 0) caps = meta.trim().split(/\s+/).filter(Boolean);
    const text = (nul >= 0 ? payload.subarray(0, nul) : payload).toString('utf8').trim();
    const parts = text.split(/\s+/);
    if (parts.length >= 3 && HEX40.test(parts[0]) && HEX40.test(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }

  let unpack = 'ok';
  const pack = body.subarray(offset);
  if (pack.length >= 32 && pack.subarray(0, 4).toString('ascii') === 'PACK') {
    try {
      const objects = readPack(pack, repo);
      for (const object of objects) {
        repo.objects.set(object.oid, object.data);
        setType(repo, object.oid, object.type);
        if (object.type === 'commit') recordCommit(repo, object.oid, object.data);
      }
    } catch (err) {
      unpack = `ng ${(err as Error).message.slice(0, 80)}`;
    }
  } else if (pack.length) {
    unpack = 'ng unpacker-error';
  }

  const verdicts = commands.map((command) => {
    if (unpack !== 'ok') return { ref: command.ref, ok: false, reason: 'unpack-failed' };
    return applyCommand(repo, command);
  });

  const report: string[] = [`unpack ${unpack}`];
  for (const verdict of verdicts) {
    report.push(verdict.ok ? `ok ${verdict.ref}` : `ng ${verdict.ref} ${verdict.reason}`);
  }
  const sideband = caps.includes('side-band-64k');
  const out: Buffer[] = [];
  for (const text of report) {
    const payload = Buffer.from(`${text}\n`, 'utf8');
    out.push(sideband ? pkt(Buffer.concat([Buffer.from([1]), payload])) : pkt(payload));
  }
  out.push(FLUSH);
  send(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(out));
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): boolean {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)\/?$/);
    if (!match) return false;
    const owner = decodeURIComponent(match[1]);
    const name = decodeURIComponent(match[2]);
    const tail = match[3];

    let service: 'git-upload-pack' | 'git-receive-pack';
    if (tail === 'info/refs') {
      const param = url.searchParams.get('service');
      if (param !== 'git-upload-pack' && param !== 'git-receive-pack') return false;
      service = param;
      if (req.method !== 'GET') return false;
    } else {
      service = tail;
      if (req.method !== 'POST') return false;
    }

    const repo = store.get(owner, name);
    if (!repo) {
      send(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' })));
      return true;
    }

    if (tail === 'info/refs') {
      const protocol = req.headers['git-protocol'] || '';
      const v2 = service === 'git-upload-pack' && /version=2/.test(Array.isArray(protocol) ? protocol.join(' ') : protocol);
      advertise(res, repo, service, v2);
      return true;
    }

    readBody(req).then((body) => {
      try {
        if (tail === 'git-receive-pack') {
          receive(repo, body, res);
          return;
        }
        const { payloads } = readPktLines(body);
        const isLsRefs = payloads.some((p) => textOf(p) === 'command=ls-refs');
        if (isLsRefs) lsRefs(repo, body, res);
        else {
          const proto = req.headers['git-protocol'] || '';
          const v2 = /version=2/.test(Array.isArray(proto) ? proto.join(' ') : proto);
          fetch(repo, body, res, v2);
        }
      } catch (err) {
        fail(res);
        void err;
      }
    }).catch(() => fail(res));
    return true;
  } catch (err) {
    void err;
    fail(res);
    return true;
  }
}
