// Smoke-test the EdgeOne route files and their self-contained bundle in Node.
//
// This does not emulate EdgeOne's router; it verifies that both generated
// route files (`index.js` for `/`, `[[default]].js` for other paths) import the
// bundle without node_modules and serve a metadata route and a real conversion.

import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routeDir = join(ROOT, 'cloud-functions');
const index = await import(pathToFileURL(join(routeDir, 'index.js')).href);
const catchAll = await import(pathToFileURL(join(routeDir, '[[default]].js')).href);

if (typeof index.onRequest !== 'function' || typeof catchAll.onRequest !== 'function') {
  throw new Error('EdgeOne route files must export onRequest');
}

async function request(handler, path) {
  return handler({
    request: new Request(`https://edgeone.local${path}`),
    env: {},
    waitUntil: () => {},
  });
}

const version = await request(index.onRequest, '/version');
if (version.status !== 200) {
  throw new Error(`/version returned ${version.status}`);
}
const versionText = await version.text();
if (!versionText.includes('subconverter-worker')) {
  throw new Error('/version response does not mention subconverter-worker');
}

const ss = 'ss://YWVzLTEyOC1nY206cGFzcw==@1.2.3.4:8388#edgeone';
const source = `inline:${Buffer.from(ss, 'utf8').toString('base64url')}`;
const sub = await request(catchAll.onRequest, `/sub?target=clash&url=${encodeURIComponent(source)}`);
if (sub.status !== 200) {
  throw new Error(`/sub returned ${sub.status}: ${(await sub.text()).slice(0, 200)}`);
}
const yaml = await sub.text();
if (!yaml.includes('proxies:') || yaml.includes('DOMA')) {
  throw new Error('/sub output did not look like a valid Clash config');
}

console.log('edgeone: route files OK (/version 200, /sub 200, proxies present, no DOMA)');
