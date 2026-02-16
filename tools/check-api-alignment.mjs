import fs from 'fs';
import path from 'path';

const root = process.cwd();

const walk = (dir, exts) => {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full, exts));
      continue;
    }
    if (exts.includes(path.extname(name))) {
      out.push(full);
    }
  }
  return out;
};

const routeBaseByFile = {
  whatsapp: '/api/whatsapp',
  feeds: '/api/feeds',
  templates: '/api/templates',
  targets: '/api/targets',
  schedules: '/api/schedules',
  settings: '/api/settings',
  logs: '/api/logs',
  feedItems: '/api/feed-items',
  shabbos: '/api/shabbos',
  queue: '/api/queue',
  analytics: '/api/analytics',
  manual: '/api/manual'
};

const normalizeClientPath = (value) =>
  String(value || '')
    .trim()
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\?.*$/, '')
    .replace(/\/{2,}/g, '/');

const normalizeServerPath = (value) =>
  String(value || '')
    .trim()
    .replace(/:[A-Za-z0-9_]+/g, ':param')
    .replace(/\/{2,}/g, '/');

const frontendFiles = walk(path.join(root, 'apps', 'web'), ['.ts', '.tsx']);
const clientCalls = new Set();

const apiCallPattern = /api\.(get|post|put|patch|delete)\(\s*([`'"])([\s\S]*?)\2/gm;
for (const file of frontendFiles) {
  const text = fs.readFileSync(file, 'utf8');
  let match = null;
  while ((match = apiCallPattern.exec(text))) {
    const rawPath = normalizeClientPath(match[3]);
    if (!rawPath.startsWith('/api/')) continue;
    clientCalls.add(rawPath);
  }
}

const backendRoutes = new Set(['/api/health', '/api/ping', '/api/openapi.json']);
const serverFiles = walk(path.join(root, 'server', 'src', 'routes'), ['.ts']);
const routePattern = /router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gm;

for (const file of serverFiles) {
  const baseName = path.basename(file, '.ts');
  if (baseName === 'index') continue;
  const basePath = routeBaseByFile[baseName];
  if (!basePath) continue;

  const text = fs.readFileSync(file, 'utf8');
  let match = null;
  while ((match = routePattern.exec(text))) {
    const routePath = String(match[2] || '');
    const fullPath = normalizeServerPath(`${basePath}${routePath === '/' ? '' : routePath}`);
    backendRoutes.add(fullPath);
  }
}

const backendList = Array.from(backendRoutes);
const unmatched = [];
for (const clientPath of Array.from(clientCalls).sort()) {
  const normalizedClient = normalizeServerPath(clientPath);
  const exactMatch = backendRoutes.has(normalizedClient);
  if (exactMatch) continue;

  const regexMatch = backendList.some((backendPath) => {
    const escaped = backendPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:param/g, '[^/]+');
    return new RegExp(`^${escaped}$`).test(normalizedClient);
  });
  if (!regexMatch) unmatched.push(normalizedClient);
}

console.log(`Frontend API calls: ${clientCalls.size}`);
console.log(`Backend API routes: ${backendRoutes.size}`);
if (!unmatched.length) {
  console.log('API alignment OK');
  process.exit(0);
}

console.log('Unmatched frontend API paths:');
for (const item of unmatched) {
  console.log(`- ${item}`);
}
process.exit(1);
