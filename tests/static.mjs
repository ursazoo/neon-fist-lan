import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { serve } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(path.join(root, 'index.html'), 'utf8');
assert(!/\/api\/|['"`](?:stun|stuns|turn|turns):|serviceWorker\.register|from ['"]https?:/.test(html), 'page uses only static local resources');
assert(!/LiveConfig|Telemetry/.test(html), 'no backend configuration or telemetry');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert(script, 'game has a module script');
const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: script, encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr);

const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory)) {
    const absolute = path.join(directory, entry);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('tests') || relative.startsWith('.') || relative.startsWith('artifacts')) continue;
    if ((await stat(absolute)).isDirectory()) await walk(absolute);
    else if (/\.(js|json|png|ico|webmanifest)$/.test(entry)) files.push(relative);
  }
}
await walk(root);
for (const file of files.filter(p => p.endsWith('.js'))) {
  const code = await readFile(path.join(root, file), 'utf8');
  if (file === 'shared/vendor/peerjs.min.js') {
    assert.equal(createHash('sha256').update(code).digest('hex'),
      '7604d8c31bec4f134b0d15c2d80b1d095ea18af005354f439f14291fcd7b4168', 'PeerJS is the unmodified pinned 1.5.5 bundle');
  } else assert(!/['"`](?:stun|stuns|turn|turns):/.test(code), `${file} does not call external ICE services`);
  const check = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
}
const site = await serve(root);
try {
  for (const prefix of ['/', '/neon-fist/']) {
    for (const file of ['index.html', ...files]) {
      const result = await fetch(site.url + prefix + file);
      assert.equal(result.status, 200, `${prefix}${file} loads`);
    }
  }
  console.log(`PASS syntax, static-only dependencies, and ${files.length + 1} files at root and /neon-fist/.`);
} finally { await site.close(); }
