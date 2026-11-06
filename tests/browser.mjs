import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { connect, tab, until } from './cdp.mjs';
import { serve } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const report = { environment: 'Two independent Chrome windows on one computer; no physical two-PC acceptance.', checks: [] };
const passed = (name, details) => { report.checks.push({ name, result: 'pass', details }); console.log(`PASS ${name}${details ? ' ' + JSON.stringify(details) : ''}`); };
const pages = [];
const site = await serve(root);
let browserProcess, profile, browserPort = Number(process.env.CDP_PORT || 0);

async function newPage(prefix = '/neon-fist/') {
  const page = await tab(browserPort, site.url + prefix);
  pages.push(page);
  await until(() => page.eval('!!window.NEON'), Boolean, 15000);
  return page;
}
async function click(page, id) {
  await page.eval(`(() => {const button=document.getElementById(${JSON.stringify(id)});if(!button || button.disabled)throw Error('Unavailable button '+${JSON.stringify(id)});button.click();})()`);
}
async function key(page, code, down) {
  const value = code.startsWith('Key') ? code.slice(3).toLowerCase() : code === 'Enter' ? 'Enter' : code;
  await page.send('Input.dispatchKeyEvent', { type: down ? 'keyDown' : 'keyUp', code, key: value, windowsVirtualKeyCode: value.length === 1 ? value.toUpperCase().charCodeAt(0) : code === 'Enter' ? 13 : undefined });
}
async function state(page) { return page.eval('NEON.snapshot()'); }
async function advance(page, frames) {
  const start = (await state(page)).frame;
  return until(() => state(page), value => value.frame >= start + frames || value.phase === 'matchEnd', 12000);
}
async function compare(a, b, label) {
  const [left, right] = await Promise.all([a.eval('NEON.Net.checkpoints'), b.eval('NEON.Net.checkpoints')]);
  const epoch = await a.eval('NEON.Net.epoch');
  const common = left.filter(p => p.epoch === epoch && right.some(q => q.epoch === p.epoch && q.frame === p.frame));
  assert(common.length > 0, `shared checkpoints for ${label}`);
  for (const p of common) assert.equal(right.find(q => q.epoch === p.epoch && q.frame === p.frame).hash, p.hash, `same state at ${p.frame}`);
  passed(label, { checkpoints: common.length, throughFrame: Math.max(...common.map(p => p.frame)) });
}
async function openNet(page) { await click(page, 'openNet'); await page.eval('document.getElementById("manualConnect").open=true'); }
async function exchange(a, b) {
  await openNet(a); await openNet(b);
  await click(a, 'nHost');
  const offer = await until(() => a.eval('document.getElementById("netout").value'), Boolean, 15000);
  await click(b, 'nJoin');
  await b.eval(`document.getElementById('netin').value=${JSON.stringify(offer)}`);
  await click(b, 'nAccept');
  const answer = await until(() => b.eval('document.getElementById("netout").value'), Boolean, 15000);
  await a.eval(`document.getElementById('netin').value=${JSON.stringify(answer)}`);
  await click(a, 'nAccept');
  for (const p of [a, b]) await until(() => p.eval('NEON.Net.state'), value => ['playing', 'waiting'].includes(value), 15000);
  passed('manual offer/answer establishes two peer connections', { offerLength: offer.length, answerLength: answer.length });
}

try {
  if (!browserPort) {
    const chrome = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
    await access(chrome);
    profile = await mkdtemp(path.join(os.tmpdir(), 'neon-fist-chrome-'));
    browserProcess = spawn(chrome, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    browserPort = await until(async () => { try { return Number((await readFile(portFile, 'utf8')).split('\n')[0]); } catch { return 0; } }, Boolean, 15000);
  }
  const a = await newPage();
  const b = await newPage();
  passed('both pages boot below GitHub project subpath');

  await a.eval(`document.querySelector('#boot [data-picker="local"] [data-character="claude"]').click()`);
  await b.eval(`document.querySelector('#boot [data-picker="local"] [data-character="chatgpt"]').click()`);
  await openNet(b); await click(b, 'nJoin');
  await b.eval('document.getElementById("netin").value="invalid connection code"');
  await click(b, 'nAccept');
  const invalid = await until(() => b.eval('document.getElementById("netstat").textContent'), text => /无效|错误|格式|无法|失败|invalid/i.test(text));
  assert(!(await b.eval('NEON.Net.active')));
  passed('invalid code rejected without starting a match', invalid);
  await click(b, 'nClose');
  await exchange(a, b);
  for (const p of [a,b]) {
    assert.deepEqual(await p.eval('NEON.Game.roster'),['claude','chatgpt']);
    assert.equal(await p.eval("NEON.sprites.frame('p1').character"),'claude');
    assert.equal(await p.eval("NEON.sprites.frame('p2').character"),'chatgpt');
    assert(await p.eval("[...document.querySelectorAll('.character-card')].every(b=>b.disabled)"));
  }
  passed('different character selections render the same roster on both peers');
  assert.equal(await a.eval('NEON.Net.role'), 'host');
  assert.equal(await b.eval('NEON.Net.role'), 'guest');
  for (const p of [a, b]) {
    const config = await p.eval('NEON.Net.pc.getConfiguration()');
    assert.equal(config.iceServers.length, 0);
  }
  passed('LAN-only ICE configuration has no STUN or TURN');
  await until(() => a.eval('NEON.Game.phase'), phase => phase === 'fight', 12000);
  await compare(a, b, 'initial match states agree');

  const before = await state(a);
  await Promise.all([key(a, 'KeyD', true), key(b, 'KeyA', true)]);
  await advance(a, 19);
  await Promise.all([key(a, 'KeyD', false), key(b, 'KeyA', false)]);
  await advance(a, 5);
  const moved = await state(a);
  assert(moved.fighters[0].x > before.fighters[0].x, 'host WASD moves P1');
  assert(moved.fighters[1].x < before.fighters[1].x, 'guest WASD moves P2');
  passed('each keyboard controls its own fighter', { before: before.fighters.map(p => p.x), after: moved.fighters.map(p => p.x) });

  await Promise.all([key(a, 'KeyD', true), key(b, 'KeyA', true)]);
  await advance(a, 40);
  await Promise.all([key(a, 'KeyD', false), key(b, 'KeyA', false)]);
  for (let i = 0; i < 5; i++) {
    await key(a, 'KeyJ', true); await advance(a, 2); await key(a, 'KeyJ', false); await advance(a, 22);
  }
  const hit = await state(a);
  assert(hit.fighters[1].hp < 100, 'host punch damages guest');
  for (let i = 0; i < 4; i++) {
    await key(b, 'KeyK', true); await advance(a, 2); await key(b, 'KeyK', false); await advance(a, 25);
  }
  const counter = await state(a);
  assert(counter.fighters[0].hp < 100, 'guest kick damages host');
  passed('both keyboards cause combat damage', { hp: counter.fighters.map(p => p.hp) });
  await compare(a, b, 'movement, attacks and hitstop stay synchronized');

  await a.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await advance(b, 90);
  await a.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await compare(a, b, 'different rendering speed stays synchronized');

  for (let i = 0; i < 65 && (await state(a)).phase !== 'matchEnd'; i++) {
    if ((await state(a)).phase === 'fight') {
      await key(a, 'KeyD', true); await advance(a, 10); await key(a, 'KeyD', false);
      await key(a, 'KeyK', true); await advance(a, 2); await key(a, 'KeyK', false); await advance(a, 25);
    } else {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  await until(() => state(a), value => value.phase === 'matchEnd', 20000);
  await until(() => state(b), value => value.phase === 'matchEnd', 5000);
  await compare(a, b, 'complete match and round transitions stay synchronized');

  const epoch = await a.eval('NEON.Net.epoch');
  await key(a, 'Enter', true); await key(a, 'Enter', false);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await a.eval('NEON.Net.epoch'), epoch, 'one player cannot restart alone');
  await key(b, 'Enter', true); await key(b, 'Enter', false);
  for (const p of [a, b]) await until(() => p.eval('NEON.Net.epoch'), value => value > epoch, 10000);
  await advance(a, 185);
  assert.equal((await state(a)).fighters[0].hp, 100);
  assert.equal((await state(a)).fighters[1].hp, 100);
  await compare(a, b, 'both players must agree to a clean rematch');

  const capture = await a.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(artifacts, 'game.png'), Buffer.from(capture.data, 'base64'));
  const pageErrors = pages.flatMap(p => p.events.filter(e => e.method === 'Runtime.exceptionThrown'));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert(!site.requests.some(url => url.startsWith('/api/') || url.endsWith('/sw.js')), 'no backend or worker requests');
  passed('no browser exceptions or backend requests');

  await click(a, 'tNet'); await click(a, 'nDisconnect');
  await until(() => b.eval('NEON.Net.active'), active => !active);
  const stopped = (await state(b)).frame;
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal((await state(b)).frame, stopped, 'disconnect freezes simulation');
  passed('disconnect freezes instead of falling back to local CPU');

  const rootPage = await newPage('/');
  assert(await rootPage.eval('!!NEON'));
  passed('root deployment also boots');
  report.result = 'pass';
} catch (error) {
  report.result = 'fail';
  report.error = error.stack;
  throw error;
} finally {
  await writeFile(path.join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  for (const page of pages) await page.destroy().catch(() => page.close());
  await site.close();
  if (browserProcess) {
    const exited = new Promise(resolve => browserProcess.once('exit', resolve));
    browserProcess.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
