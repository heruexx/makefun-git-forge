// This file owns only the harness handshake. The scored HTTP surface lives in
// app.ts; here we bind a kernel-chosen port, announce it to the env, and stay
// alive until the env tells us the trial export is sealed.

const { createApp } = await import('./app.ts');

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN === '') {
  process.stderr.write('no MAKEFUN_ENV_URL: cannot register a forge\n');
  process.exit(1);
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const backoff = (n: number): number => Math.min(2000, 250 * 2 ** Math.min(n, 8));
const REGISTER_OK = new Set([200, 409]);

async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30000),
      });
      if (REGISTER_OK.has(reply.status)) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register rejected with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (problem) {
      if (problem instanceof Error && problem.message.startsWith('register rejected')) throw problem;
    }
    await wait(backoff(attempt));
  }
}

async function awaitExport(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(30000) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env may still be booting; the trial is not over until it says so.
    }
    await wait(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((ready, failed) => {
    server.once('error', failed);
    server.listen(0, () => ready());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('no ephemeral TCP port was bound');
  process.stdout.write(`[forge] bound ${bound.port}\n`);

  await announce(bound.port);
  await awaitExport();
  server.close();
  process.stdout.write('[forge] env finished\n');
}

try {
  await run();
  process.exit(0);
} catch (problem) {
  process.stderr.write(`[forge] ${problem instanceof Error ? problem.message : String(problem)}\n`);
  process.exit(1);
}
