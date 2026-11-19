// HTTP surface: dispatch to the four protocol modules, keeping the harness
// lifecycle in main.ts untouched. The store is shared by every surface, so a
// repo or issue made over MCP reads back over REST with the same ids.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL, handleMCP } from './api.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER = 'adaiversen'; // token owner fixed by the kit's published scenario seed

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; }
  catch { return '/'; }
}

/** Build the server. It binds nothing until main.ts listens on an ephemeral port. */
export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Store(VIEWER, token);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // Each module answers only the requests that belong to its surface.
    if (handleGit(req, res, store)) return;
    if (handleRest(req, res, store)) return;
    if (path === '/api/graphql' && handleGraphQL(req, res, store)) return;
    if (path === '/mcp' && handleMCP(req, res, store)) return;

    sendJson(res, 404, { message: 'Not Found' });
  });
}
