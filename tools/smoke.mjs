import { spawn } from 'child_process';
import path from 'path';
import net from 'net';

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

const fetchText = async (url) => {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, text };
};

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
  await run('npm', ['run', 'build', '--prefix', 'client']);
  await run('npm', ['run', 'lint', '--prefix', 'apps/web']);
  await run('npm', ['run', 'build', '--prefix', 'apps/web']);

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
    const readiness = await fetchText(`http://localhost:${apiPort}/ready`);
    if (![200, 503].includes(readiness.status)) {
      throw new Error(`/ready returned unexpected status ${readiness.status}`);
    }

    let dbReady = false;
    try {
      const parsed = JSON.parse(readiness.text);
      dbReady = Boolean(parsed?.db);
    } catch {
      dbReady = false;
    }

    const basePaths = [
      '/',
      '/health',
      '/ping',
      '/ready',
      '/api/openapi.json',
      '/api/docs',
      '/api/whatsapp/status',
      '/api/whatsapp/qr',
      '/api/whatsapp/groups',
      '/api/whatsapp/channels'
    ];

    const dbPaths = [
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
      '/api/analytics/overview',
      '/api/analytics/recommendation',
      '/api/analytics/timeline',
      '/api/analytics/windows',
      '/api/shabbos/status',
      '/api/shabbos/settings'
    ];

    const paths = dbReady ? [...basePaths, ...dbPaths] : basePaths;
    if (!dbReady) {
      console.log('Skipping DB-backed API smoke paths (database not configured in this environment).');
    }

    for (const p of paths) {
      const { status } = await fetchText(`http://localhost:${apiPort}${p}`);
      if (p === '/ready' && status === 503) {
        continue;
      }
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

  // Web smoke (start)
  const webPort = await findFreePort(3001);
  const nextBin = path.join(process.cwd(), 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
  const web = spawn('node', [nextBin, 'start', '-p', webPort], {
    cwd: path.join(process.cwd(), 'apps', 'web'),
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  web.stdout.on('data', (d) => process.stdout.write(d));
  web.stderr.on('data', (d) => process.stderr.write(d));

  try {
    await waitForOkOrExit(web, `http://localhost:${webPort}/`);
    const { status, text } = await fetchText(`http://localhost:${webPort}/`);
    if (status !== 200) {
      throw new Error(`Web smoke failed: / returned ${status}`);
    }
    if (!text.includes('WhatsApp News Bot')) {
      throw new Error('Web smoke failed: expected app title not found');
    }
  } finally {
    await stopProcess(web);
  }

  console.log('SMOKE OK');
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
