import { spawn } from 'child_process';
import path from 'path';
import net from 'net';
import { promises as fs } from 'fs';

import { once } from 'events';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = (cmd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const command = isWin ? (process.env.ComSpec || 'cmd.exe') : cmd;
    const commandArgs = isWin ? ['/d', '/s', '/c', cmd, ...args] : args;
    const child = spawn(command, commandArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...options
    });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });

const waitForOk = async (url, timeoutMs = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const isPortFree = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    // Bind on all interfaces to match how the app listens.
    server.listen(port);
  });

const findFreePort = async (preferred) => {
  const start = Number(preferred);
  for (let port = start; port < start + 200; port++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) return String(port);
  }
  throw new Error(`Could not find a free port starting at ${preferred}`);
};

const waitForOkOrExit = async (child, url, timeoutMs = 20000) => {
  await Promise.race([
    waitForOk(url, timeoutMs),
    once(child, 'exit').then(([code]) => {
      throw new Error(`Process exited (${code}) while waiting for ${url}`);
    })
  ]);
};

const fetchText = async (url, init = undefined) => {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, text };
};

const basicAuthHeader = (user, pass) =>
  `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;

const stopProcess = async (child) => {
  if (!child || child.pid === undefined) return;
  if (child.exitCode !== null) return;

  child.kill();
  await Promise.race([once(child, 'exit'), sleep(2000)]);
  if (child.exitCode !== null) return;

  if (process.platform === 'win32') {
    try {
      const killer = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'taskkill', '/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore'
      });
      await Promise.race([once(killer, 'exit'), sleep(2000)]);
    } catch {
      // Process may have already exited.
    }
  } else {
    child.kill('SIGKILL');
  }
  await Promise.race([once(child, 'exit'), sleep(2000)]);
};

const main = async () => {
  // Build + typecheck
  await run('npm', ['run', 'typecheck', '--prefix', 'server']);
  await run('npm', ['run', 'build', '--prefix', 'server']);
  await run('npm', ['run', 'lint', '--prefix', 'apps/web']);
  await run('npm', ['run', 'build:web:static']);

  // API smoke
  const apiPort = await findFreePort(10001);
  const api = spawn('node', ['server/dist/index.js'], {
    env: {
      ...process.env,
      PORT: apiPort,
      NODE_ENV: 'development',
      DISABLE_WHATSAPP: 'true',
      DISABLE_SCHEDULERS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  api.stdout.on('data', (d) => process.stdout.write(d));
  api.stderr.on('data', (d) => process.stderr.write(d));

  try {
    await waitForOkOrExit(api, `http://localhost:${apiPort}/health`);
    const paths = [
      '/',
      '/health',
      '/ping',
      '/ready',
      '/api/openapi.json',
      '/api/docs',
      '/api/settings',
      '/api/feeds',
      '/api/templates',
      '/api/templates/available-variables',
      '/api/targets',
      '/api/schedules',
      '/api/feed-items',
      '/api/logs',
      '/api/queue/stats',
      '/api/queue?status=pending',
      '/api/shabbos/status',
      '/api/shabbos/settings',
      '/api/whatsapp/status',
      '/api/whatsapp/qr',
      '/api/whatsapp/groups',
      '/api/whatsapp/channels'
    ];
    for (const p of paths) {
      const { status } = await fetchText(`http://localhost:${apiPort}${p}`);
      if (status < 200 || status > 399) {
        throw new Error(`API smoke failed: ${p} returned ${status}`);
      }
    }

    const { text: html } = await fetchText(`http://localhost:${apiPort}/`);
    if (!html.includes('WhatsApp News Bot')) {
      throw new Error('API smoke failed: expected SPA title not found on /');
    }
  } finally {
    await stopProcess(api);
  }

  // Auth lock smoke (production-like): health probes open, app/API locked.
  const authPort = await findFreePort(10200);
  const authUser = 'owner';
  const authPass = 'Smoke-Auth-Password-123';
  const authApi = spawn('node', ['server/dist/index.js'], {
    env: {
      ...process.env,
      PORT: authPort,
      NODE_ENV: 'production',
      DISABLE_WHATSAPP: 'true',
      DISABLE_SCHEDULERS: 'true',
      REQUIRE_BASIC_AUTH: 'true',
      BASIC_AUTH_USER: authUser,
      BASIC_AUTH_PASS: authPass,
      BASIC_AUTH_REQUIRE_HTTPS: 'false',
      ALLOW_WEAK_BASIC_AUTH: 'false',
      SUPABASE_URL: process.env.SUPABASE_URL || 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 'smoke-test-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  authApi.stdout.on('data', (d) => process.stdout.write(d));
  authApi.stderr.on('data', (d) => process.stderr.write(d));

  try {
    await waitForOkOrExit(authApi, `http://localhost:${authPort}/health`);

    const openHealth = await fetchText(`http://localhost:${authPort}/health`);
    if (openHealth.status !== 200) {
      throw new Error(`Auth smoke failed: /health returned ${openHealth.status}`);
    }

    const lockedReady = await fetchText(`http://localhost:${authPort}/ready`);
    if (lockedReady.status !== 401) {
      throw new Error(`Auth smoke failed: /ready without auth returned ${lockedReady.status}`);
    }

    const lockedHealthMethod = await fetchText(`http://localhost:${authPort}/health`, { method: 'POST' });
    if (lockedHealthMethod.status !== 401) {
      throw new Error(`Auth smoke failed: POST /health returned ${lockedHealthMethod.status}, expected 401`);
    }

    const lockedNoAuth = await fetchText(`http://localhost:${authPort}/api/openapi.json`);
    if (lockedNoAuth.status !== 401) {
      throw new Error(`Auth smoke failed: /api/openapi.json without auth returned ${lockedNoAuth.status}`);
    }

    const lockedBadAuth = await fetchText(`http://localhost:${authPort}/api/openapi.json`, {
      headers: { Authorization: basicAuthHeader(authUser, 'bad-password') }
    });
    if (lockedBadAuth.status !== 401) {
      throw new Error(`Auth smoke failed: /api/openapi.json with bad auth returned ${lockedBadAuth.status}`);
    }

    const unlockedGoodAuth = await fetchText(`http://localhost:${authPort}/api/openapi.json`, {
      headers: { Authorization: basicAuthHeader(authUser, authPass) }
    });
    if (unlockedGoodAuth.status < 200 || unlockedGoodAuth.status > 399) {
      throw new Error(`Auth smoke failed: /api/openapi.json with good auth returned ${unlockedGoodAuth.status}`);
    }
  } finally {
    await stopProcess(authApi);
  }

  // Allowlist smoke: valid credentials but non-matching IP should be denied.
  const allowlistPort = await findFreePort(10300);
  const allowlistApi = spawn('node', ['server/dist/index.js'], {
    env: {
      ...process.env,
      PORT: allowlistPort,
      NODE_ENV: 'production',
      DISABLE_WHATSAPP: 'true',
      DISABLE_SCHEDULERS: 'true',
      REQUIRE_BASIC_AUTH: 'true',
      BASIC_AUTH_USER: authUser,
      BASIC_AUTH_PASS: authPass,
      BASIC_AUTH_REQUIRE_HTTPS: 'false',
      ACCESS_ALLOWLIST: '203.0.113.10',
      TRUST_PROXY_HOPS: '0',
      ALLOW_WEAK_BASIC_AUTH: 'false',
      SUPABASE_URL: process.env.SUPABASE_URL || 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 'smoke-test-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  allowlistApi.stdout.on('data', (d) => process.stdout.write(d));
  allowlistApi.stderr.on('data', (d) => process.stderr.write(d));

  try {
    await waitForOkOrExit(allowlistApi, `http://localhost:${allowlistPort}/health`);
    const denied = await fetchText(`http://localhost:${allowlistPort}/api/openapi.json`, {
      headers: { Authorization: basicAuthHeader(authUser, authPass) }
    });
    if (denied.status !== 403) {
      throw new Error(`Allowlist smoke failed: expected 403, got ${denied.status}`);
    }
  } finally {
    await stopProcess(allowlistApi);
  }

  // Static export smoke
  const staticIndexPath = path.join(process.cwd(), 'server', 'public', 'index.html');
  const staticHtml = await fs.readFile(staticIndexPath, 'utf8');
  if (!staticHtml.includes('WhatsApp News Bot')) {
    throw new Error('Static export smoke failed: expected app title not found in server/public/index.html');
  }

  console.log('SMOKE OK');
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
