import assert from 'node:assert/strict';
import test from 'node:test';
import { Lockstep, INPUT_DELAY } from '../shared/lockstep.js';

test('startup neutral inputs are explicit, missing input cannot advance', () => {
  const queue = new Lockstep(0), seen = [];
  assert.equal(INPUT_DELAY, 2);
  assert(queue.advance((...pair) => seen.push(pair)));
  assert(queue.advance((...pair) => seen.push(pair)));
  assert.deepEqual(seen, [[0, 0], [0, 0]]);
  assert.equal(queue.advance(() => assert.fail('missing input simulated')), false);
  queue.put(0, 2, 0);
  assert.equal(queue.ready, false);
  queue.receive(2, 0);
  assert.equal(queue.ready, true);
  assert(queue.advance((...pair) => assert.deepEqual(pair, [0, 0])));
});

test('stalled capture is immutable, including zero and key release', () => {
  const queue = new Lockstep(0);
  assert.deepEqual(queue.capture(16), { frame: 2, mask: 16 });
  for (let i = 0; i < 100; i++) assert.equal(queue.capture(i & 127), null);
  queue.advance(() => {});
  assert.deepEqual(queue.capture(0), { frame: 3, mask: 0 });
  assert.equal(queue.capture(2), null);
  assert.equal(queue.inputs[0].get(2), 16);
  assert.equal(queue.inputs[0].get(3), 0);
});

test('guest capture controls only P2, remote input controls P1', () => {
  const queue = new Lockstep(1);
  queue.capture(32);
  queue.receive(2, 2);
  queue.advance(() => {}); queue.advance(() => {});
  assert(queue.advance((a, b) => assert.deepEqual([a, b], [2, 32])));
});

test('invalid ranges and conflicting duplicates fail at the input boundary', () => {
  const queue = new Lockstep(0);
  for (const frame of [-1, 1.5, NaN, Infinity, 65]) assert.throws(() => queue.receive(frame, 0));
  for (const mask of [-1, 128, NaN, 1.5, '2']) assert.throws(() => queue.receive(2, mask));
  assert.equal(queue.receive(2, 8), true);
  assert.equal(queue.receive(2, 8), false);
  assert.throws(() => queue.receive(2, 0), /冲突/);
});

test('asymmetric scheduling and delayed delivery keep 10000 frame inputs identical and bounded', () => {
  const queues = [new Lockstep(0), new Lockstep(1)];
  const records = [[], []], mail = [[], []];
  const capture = player => {
    const queue = queues[player];
    const packet = queue.capture((queue.frame * (player ? 13 : 7)) & 127);
    if (packet) mail[1 - player].push({ ...packet, at: tick + 1 + (packet.frame % 9) });
  };
  let tick = 0;
  while (queues.some(queue => queue.frame < 10000) && tick < 200000) {
    for (const player of [0, 1]) {
      while (mail[player].length && mail[player][0].at <= tick) {
        const { frame, mask } = mail[player].shift();
        queues[player].receive(frame, mask);
      }
      if (player === 1 && tick % 3) continue;
      const queue = queues[player];
      if (queue.frame >= 10000) continue;
      capture(player);
      queue.advance((...pair) => records[player].push(pair));
      for (const inputs of queue.inputs) assert(inputs.size <= 185);
      assert(Math.abs(queues[0].frame - queues[1].frame) <= 3);
    }
    tick++;
  }
  assert.equal(queues[0].frame, 10000);
  assert.equal(queues[1].frame, 10000);
  assert.deepEqual(records[0], records[1]);
  assert.throws(() => queues[0].receive(0, 0), /过期/);
});

test('a new match queue has no previous inputs or capture markers', () => {
  const old = new Lockstep(0); old.capture(127); old.receive(2, 1);
  old.advance(() => {}); old.advance(() => {}); old.advance(() => {});
  const fresh = new Lockstep(0);
  assert.equal(fresh.frame, 0);
  assert.equal(fresh.inputs[0].has(2), false);
  assert.deepEqual(fresh.capture(0), { frame: 2, mask: 0 });
  assert.equal(fresh.inputs[1].has(2), false);
});

test('session handshake, manual exchange timeout, rematch timer and disconnect use one clock', async t => {
  const { createSession } = await import('../shared/netplay.js');
  const { configFingerprint } = await import('../shared/integrity.js');
  const nativeRTC = globalThis.RTCPeerConnection;
  const peers = [];
  const flush = () => new Promise(resolve => setImmediate(resolve));
  let wall = performance.now();
  const scheduled = [], heartbeats = [];
  t.mock.method(performance, 'now', () => wall);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, at: wall + delay, cancelled: false };
    scheduled.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { if (timer) timer.cancelled = true; });
  t.mock.method(globalThis, 'setInterval', callback => {
    const timer = { callback, cancelled: false }; heartbeats.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', timer => { if (timer) timer.cancelled = true; });
  async function elapse(ms) {
    wall += ms;
    for (const timer of scheduled.filter(timer => !timer.cancelled && timer.at <= wall)) {
      timer.cancelled = true; timer.callback();
    }
    await flush();
  }
  class Channel {
    constructor() {
      this.label = 'fight'; this.ordered = true; this.maxRetransmits = null;
      this.maxPacketLifeTime = null; this.readyState = 'connecting'; this.bufferedAmount = 0;
    }
    send(data) {
      assert.equal(this.readyState, 'open');
      const target = this.other;
      queueMicrotask(() => target.onmessage?.({ data }));
    }
    close() { this.readyState = 'closed'; }
  }
  class Peer {
    constructor(config) {
      assert.deepEqual(config, { iceServers: [] });
      this.number = peers.push(this) - 1; this.iceGatheringState = 'complete';
    }
    createDataChannel(label, options) {
      assert.equal(label, 'fight'); assert.deepEqual(options, { ordered: true });
      return this.channel = new Channel();
    }
    async createOffer() { return this.description('offer'); }
    async createAnswer() { return this.description('answer'); }
    description(type) { return { type, sdp: 'v=0\r\na=candidate:test\r\npeer=' + this.number }; }
    async setLocalDescription(description) {
      this.localDescription = { ...description, toJSON: () => description };
    }
    async setRemoteDescription(description) {
      const other = peers[Number(description.sdp.split('peer=')[1])];
      if (description.type === 'offer') {
        this.channel = new Channel();
        this.channel.other = other.channel; other.channel.other = this.channel;
        this.ondatachannel({ channel: this.channel });
      } else {
        for (const channel of [this.channel, other.channel]) {
          channel.readyState = 'open'; queueMicrotask(() => channel.onopen?.());
        }
      }
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  globalThis.RTCPeerConnection = Peer;
  const makeEngine = () => {
    let frame = 0, seed = 0, sums = [0, 0];
    return {
      reset(value) { frame = 0; seed = value; sums = [0, 0]; },
      step(a, b) { frame++; sums[0] += a; sums[1] += b; },
      frame: () => frame, hash: () => configFingerprint({ frame, seed, sums }),
      config: () => '12345678', build: () => 'abcdef01',
      rate: () => 1, ended: () => frame === 120
    };
  };
  const engines = [makeEngine(), makeEngine()], statuses = [[], []];
  let rematchTimerChecked = false;
  const sessions = engines.map((engine, i) => createSession(engine, status => {
    statuses[i].push(status);
    if (i === 0 && status.state === 'handshake' && status.epoch === 2) {
      queueMicrotask(() => { heartbeats[0].callback(); rematchTimerChecked = true; });
    }
  }));
  const tick = async (both = true) => {
    wall += 20;
    sessions[0].tick(wall, engines[0].frame() % 128);
    if (both) sessions[1].tick(wall, (engines[1].frame() * 3) % 128);
    await flush();
  };
  try {
    const offer = await sessions[0].host();
    sessions[1].join();
    assert.equal(await sessions[1].accept('bad'), null);
    assert.equal(sessions[1].state, 'signaling');
    assert.match(statuses[1].at(-1).message, /格式错误/);
    const mismatch = JSON.parse(atob(offer)); mismatch.build = 'bad';
    assert.equal(await sessions[1].accept(btoa(JSON.stringify(mismatch))), null);
    assert.equal(sessions[1].state, 'signaling');
    const answer = await sessions[1].accept(offer);
    await elapse(20000);
    assert.equal(sessions[1].state, 'connecting', 'manual answer exchange survives 20 seconds');
    await sessions[0].accept(answer); await flush();
    assert.deepEqual(sessions.map(s => s.state), ['playing', 'playing'], JSON.stringify(statuses));
    assert.deepEqual(sessions.map(s => s.epoch), [1, 1]);
    for (let i = 0; i < 20; i++) await tick();
    const guestFrame = engines[1].frame();
    for (let i = 0; i < 25; i++) await tick(false);
    assert.equal(sessions[0].state, 'waiting');
    assert(engines[0].frame() <= guestFrame + 3);
    for (let i = 0; i < 400 && sessions.some(s => s.state !== 'ended'); i++) await tick();
    assert.deepEqual(sessions.map(s => s.state), ['ended', 'ended']);
    assert.equal(engines[0].hash(), engines[1].hash());
    for (const check of sessions[0].checkpoints) {
      const other = sessions[1].checkpoints.find(p => p.frame === check.frame);
      assert.equal(check.hash, other.hash);
    }
    const copy = sessions[0].checkpoints; copy[0].hash = 'tamper';
    assert.notEqual(sessions[0].checkpoints[0].hash, 'tamper');
    wall += 20000;
    const matchId = JSON.parse(atob(offer)).id;
    for (const peer of peers) peer.channel.send(JSON.stringify({v:1,id:matchId,epoch:1,type:'ping'}));
    await flush();
    sessions[0].rematch(); await flush();
    assert.equal(sessions[0].epoch, 1);
    sessions[1].rematch(); await flush();
    assert(rematchTimerChecked, 'heartbeat ran during rematch handshake');
    assert.deepEqual(sessions.map(s => s.epoch), [2, 2]);
    assert.deepEqual(sessions.map(s => s.frame), [0, 0]);
    assert.equal(engines[0].hash(), engines[1].hash());
    const previous = JSON.parse(atob(offer));
    peers[1].channel.send(JSON.stringify({v:1,id:previous.id,epoch:1,type:'input',frame:2,mask:127}));
    peers[1].channel.send(JSON.stringify({v:1,id:previous.id,epoch:1,type:'leave'}));
    await flush();
    assert.deepEqual(sessions.map(s => s.state), ['playing', 'playing']);
    for (let i = 0; i < 10; i++) await tick();
    sessions[0].close(); await flush();
    assert.deepEqual(sessions.map(s => s.state), ['disconnected', 'disconnected']);
    const stopped = sessions.map(s => s.frame);
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(sessions.map(s => s.frame), stopped);
    const newOffer=await sessions[0].host(); sessions[1].join();
    const newAnswer=await sessions[1].accept(newOffer);
    await sessions[0].accept(newAnswer); await flush();
    assert.deepEqual(sessions.map(s => s.state), ['playing', 'playing']);
    const mismatchId=JSON.parse(atob(newOffer)).id;
    const badHash=engines[0].hash()==='ffffffff'?'00000000':'ffffffff';
    peers.at(-1).channel.send(JSON.stringify({v:1,id:mismatchId,epoch:1,type:'hash',frame:0,hash:badHash}));
    await flush();
    assert.equal(sessions[0].state,'error');
    assert.equal(sessions[1].state,'disconnected');
    assert.match(statuses[0].at(-1).message,/同步校验失败/);
  } finally {
    for (const session of sessions) session.close();
    globalThis.RTCPeerConnection = nativeRTC;
  }
});
