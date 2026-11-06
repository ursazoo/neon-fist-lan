import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRooms, normalizeRoomCode, roomLink } from '../shared/rooms.js';
import { createSession } from '../shared/netplay.js';
import { configFingerprint } from '../shared/integrity.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const protocol = 'neon-fist-room-v1';

function fixture(t, behavior = {}) {
  let wall = 0, nextCode = 100000;
  const timers = new Set(), peers = [], registry = new Map(), connections = [], messages = [], clients = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, at: wall + delay };
    timers.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => timers.delete(timer));
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(performance, 'now', () => wall);
  class Connection extends EventEmitter {
    open = false;
    closed = false;
    constructor(peer, options) {
      super();
      this.peer = peer;
      Object.assign(this, options);
      this.dataChannel = { label: options.label, ordered: options.reliable,
        maxRetransmits: null, maxPacketLifeTime: null, bufferedAmount: 0, readyState: 'connecting',
        onopen() {}, onmessage() {}, onclose() {} };
      this.privateHandlers = [this.dataChannel.onopen, this.dataChannel.onmessage, this.dataChannel.onclose];
      this.peerConnection = { getConfiguration: () => ({ iceServers: [] }), getStats: async () => new Map() };
      connections.push(this);
    }
    send(raw) {
      assert(this.open && !this.closed, 'send only over an open connection');
      messages.push({ sender: this.peer, raw });
      queueMicrotask(() => { if (this.other.open && !this.other.closed) this.other.emit('data', raw); });
    }
    close() {
      if (this.closed) return;
      this.closed = true; this.open = false; this.dataChannel.readyState = 'closed';
      this.emit('close');
      queueMicrotask(() => this.other?.close());
    }
  }
  class Peer extends EventEmitter {
    destroyed = false;
    connections = [];
    constructor(id, options) {
      super(); this.id = id; this.options = options;
      peers.push(this);
      assert.deepEqual(options.config, { iceServers: [] });
      if (behavior.stallRegistration) return;
      queueMicrotask(() => {
        if (this.destroyed) return;
        if (registry.has(id)) this.emit('error', { type: 'unavailable-id' });
        else { registry.set(id, this); this.emit('open', id); }
      });
    }
    connect(id, options) {
      assert.equal(options.serialization, 'raw', 'use the actual 1.5.5 serializer name');
      if (behavior.throwConnect) throw behavior.throwConnect;
      const remote = registry.get(id), ours = new Connection(id, options);
      this.connections.push(ours);
      if (!remote) {
        queueMicrotask(() => this.emit('error', { type: 'peer-unavailable' }));
        return ours;
      }
      const theirs = new Connection(this.id, { ...options, metadata: behavior.metadata ?? options.metadata });
      this.lastConnection = ours;
      ours.other = theirs; theirs.other = ours;
      remote.connections.push(theirs);
      queueMicrotask(() => {
        if (this.destroyed || remote.destroyed) return;
        remote.emit('connection', theirs);
        if (behavior.stallConnection) return;
        for (const connection of behavior.guestOpensFirst ? [ours, theirs] : [theirs, ours]) {
          if (connection.closed) continue;
          connection.open = true; connection.dataChannel.readyState = 'open';
          connection.emit('open');
        }
      });
      return ours;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (registry.get(this.id) === this) registry.delete(this.id);
      for (const connection of this.connections) connection.close();
      this.emit('close');
    }
  }
  function client(options = {}, build = 'abcdef01') {
    let frame = 0, seed = 0, roster = null;
    const statuses = [], roomStatuses = [];
    const engine = { selection: () => options.character || 'deepseek', config: () => '12345678', build: () => build,
      reset(s, r) { seed = s; roster = r; frame = 0; }, frame: () => frame,
      hash: () => configFingerprint({ seed, roster, frame }), step: () => { frame++; },
      rate: () => 1, ended: () => false };
    const session = createSession(engine, status => statuses.push(status));
    const rooms = createRooms(session, status => roomStatuses.push(status), {
      Peer, randomCode: () => String(nextCode++), ...options
    });
    const entry = { session, rooms, statuses, roomStatuses };
    clients.push(entry); return entry;
  }
  async function elapse(ms) {
    wall += ms;
    for (const timer of [...timers]) {
      if (timer.at <= wall && timers.delete(timer)) timer.callback();
    }
    await flush();
  }
  t.after(async () => {
    for (const client of clients) { client.rooms.close(); client.session.practice(); }
    await flush();
    assert.equal(timers.size, 0, 'all room and session deadlines are released');
    assert(peers.every(peer => peer.destroyed), 'every signaling peer is released');
    assert(connections.every(connection => connection.closed), 'all data connections are released');
  });
  return { client, peers, registry, connections, messages, timers, elapse, behavior };
}

async function pair(f) {
  const host = f.client(), guest = f.client();
  const code = await host.rooms.create();
  assert.match(code, /^\d{6}$/);
  assert.equal(await guest.rooms.join(code), true);
  await flush();
  return { host, guest, code };
}

test('room codes and invitation URLs normalize without accepting malformed input', () => {
  for (const input of ['123456', '123 456', '123-456', '  123 - 456  ', 'https://example.com/neon-fist/?v=1#room=123456']) {
    assert.equal(normalizeRoomCode(input), '123456');
  }
  assert.equal(normalizeRoomCode('000000'), '000000');
  for (const input of [null, undefined, 123456, '', '12345', '1234567', '12x456', '#room=123456',
    'javascript:alert(1)#room=123456', 'https://example.com/?room=123456',
    'https://example.com/#room=123456&room=654321', 'https://example.com/#room=12345', '1'.repeat(2049)]) {
    assert.equal(normalizeRoomCode(input), null, String(input));
  }
});

test('invitation links preserve the Pages path and query, replacing the old fragment', () => {
  assert.equal(roomLink('123-456', 'https://example.com/neon-fist/?v=2#old'),
    'https://example.com/neon-fist/?v=2#room=123456');
  assert.equal(roomLink('12345', 'https://example.com/'), null);
  assert.equal(roomLink('123456', 'file:///game/index.html'), null);
  assert.equal(roomLink('123456', 'bad URL'), null);
});

test('the real pinned bundle can negotiate raw strings and exposes both browser globals', async () => {
  const offers = [], sent = [], created = [];
  class RTC {
    constructor(config) { this.config = config; created.push(this); }
    createDataChannel(label, options) {
      return this.channel = { label, ...options, readyState: 'open', bufferedAmount: 0,
        addEventListener() {}, close() {}, send(value) { sent.push(value); } };
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=candidate:test' }; }
    async setLocalDescription(sdp) { this.localDescription = sdp; }
    close() {}
  }
  const context = { window: {}, navigator: { userAgent: 'node' }, console,
    setTimeout: () => 0, clearTimeout() {}, RTCPeerConnection: RTC,
    WebSocket: class { readyState = 0; close() { this.readyState = 3; } } };
  vm.runInNewContext(await readFile(new URL('../shared/vendor/peerjs.min.js', import.meta.url), 'utf8'), context);
  const Peer = context.window.peerjs.Peer;
  assert.equal(Peer, context.window.Peer);
  const peer = new Peer('local-test', { config: { iceServers: [] } });
  peer.socket.send = message => offers.push(message);
  assert.throws(() => peer.connect('target', { serialization: 'none' }), /not a constructor/);
  const connection = peer.connect('target', { label: 'fight', serialization: 'raw', reliable: true });
  await flush();
  assert.equal(connection.serialization, 'raw');
  assert.deepEqual(JSON.parse(JSON.stringify(created.at(-1).config)), { iceServers: [] });
  assert.equal(connection.dataChannel.ordered, true);
  connection.dataChannel.onopen();
  connection.send('raw game message');
  assert.deepEqual(sent, ['raw game message']);
  assert.equal(offers[0].type, 'OFFER');
  assert.equal(offers[0].payload.serialization, 'raw');
  peer.destroy();
});

test('constructing rooms and invalid input do not load PeerJS or open signaling', async t => {
  const f = fixture(t); let loads = 0;
  const { rooms, session } = f.client({ loadPeer: async () => { loads++; throw new Error('must not load'); } });
  assert.equal(rooms.state, 'idle'); assert.equal(rooms.code, ''); assert.equal(rooms.active, false);
  assert.equal(await rooms.join('123'), false);
  assert.equal(loads, 0); assert.equal(f.peers.length, 0); assert.equal(session.state, 'idle');
});

for (const guestOpensFirst of [false, true]) test('one reliable channel starts the existing protocol, open order guest-first=' + guestOpensFirst, async t => {
  const f = fixture(t, { guestOpensFirst });
  const { host, guest } = await pair(f);
  assert.deepEqual([host.session.state, guest.session.state], ['playing', 'playing']);
  assert.deepEqual(host.session.roster, ['deepseek', 'deepseek']);
  assert.equal(f.connections.length, 2, 'one connection at each end, no second native RTC');
  assert.deepEqual(host.session.checkpoints, guest.session.checkpoints);
  for (const connection of f.connections) assert.deepEqual(
    [connection.dataChannel.onopen, connection.dataChannel.onmessage, connection.dataChannel.onclose], connection.privateHandlers);
  assert.deepEqual(host.session.pc.getConfiguration(), { iceServers: [] });
  assert.equal((await guest.session.getStats()).size, 0);
  assert.equal(host.rooms.state, 'connected'); assert.equal(guest.rooms.state, 'connected');
});

test('a collision retries registration without disturbing the existing room', async t => {
  const f = fixture(t);
  const first = f.client({ randomCode: () => '123456' });
  await first.rooms.create();
  const codes = ['123456', '654321'];
  const next = f.client({ randomCode: () => codes.shift() });
  assert.equal(await next.rooms.create(), '654321');
  assert.equal(first.rooms.state, 'waiting'); assert.equal(f.peers[1].destroyed, true);
  assert.equal(f.registry.size, 2);
});

test('repeated collisions terminate after the bounded attempts', async t => {
  const f = fixture(t);
  await f.client({ randomCode: () => '123456' }).rooms.create();
  const next = f.client({ randomCode: () => '123456', maxAttempts: 3 });
  assert.equal(await next.rooms.create(), null);
  assert.equal(next.rooms.active, false); assert.equal(f.peers.length, 4);
  assert.match(next.roomStatuses.at(-1).message, /冲突/);
});

test('a third player sees full while the original game continues', async t => {
  const f = fixture(t); const { host, guest, code } = await pair(f);
  const third = f.client();
  assert.equal(await third.rooms.join(code), false);
  assert.match(third.roomStatuses.at(-1).message, /已满/);
  assert.deepEqual([host.session.state, guest.session.state], ['playing', 'playing']);
  assert.equal(host.rooms.active, true); assert.equal(f.registry.size, 2);
});

test('a second guest cannot replace a guest still negotiating', async t => {
  const f = fixture(t, { stallConnection: true });
  const host = f.client(), guest = f.client(), third = f.client();
  const code = await host.rooms.create();
  const joining = guest.rooms.join(code); await flush();
  const later = third.rooms.join(code); await flush();
  const rejected = f.peers[2].lastConnection;
  for (const conn of [rejected.other, rejected]) {
    conn.open = true; conn.dataChannel.readyState = 'open'; conn.emit('open');
  }
  assert.equal(await later, false); assert.match(third.roomStatuses.at(-1).message, /已满/);
  assert.equal(host.rooms.state, 'waiting'); assert.equal(guest.rooms.state, 'joining');
  guest.rooms.close(); assert.equal(await joining, false); await flush();
});

test('an unknown room has a useful error and releases the signaling peer', async t => {
  const f = fixture(t); const guest = f.client();
  assert.equal(await guest.rooms.join('654321'), false);
  assert.match(guest.roomStatuses.at(-1).message, /未找到/);
  assert.equal(guest.session.state, 'error');
  assert.match(guest.statuses.at(-1).message, /未找到/);
  assert.equal(guest.rooms.active, false); assert(f.peers[0].destroyed);
});

test('registration includes library loading in the 15 second deadline', async t => {
  const f = fixture(t); let resolveLibrary;
  const host = f.client({ loadPeer: () => new Promise(resolve => { resolveLibrary = resolve; }) });
  const creating = host.rooms.create(); await flush();
  await f.elapse(14999); assert.equal(host.rooms.state, 'creating');
  await f.elapse(1); assert.equal(await creating, null); assert.match(host.roomStatuses.at(-1).message, /注册超时/);
  resolveLibrary(class { constructor() { assert.fail('expired load cannot create a peer'); } });
  await flush(); assert.equal(f.peers.length, 0);
});

test('registration does not wait indefinitely for PeerServer open', async t => {
  const f = fixture(t, { stallRegistration: true }); const host = f.client();
  const creating = host.rooms.create(); await flush();
  await f.elapse(15000);
  assert.equal(await creating, null); assert.equal(host.rooms.state, 'error'); assert(f.peers[0].destroyed);
});

test('joining has a 20 second total deadline and no automatic reconnect loop', async t => {
  const f = fixture(t, { stallConnection: true }); const host = f.client(), guest = f.client();
  const code = await host.rooms.create(); const joining = guest.rooms.join(code); await flush();
  await f.elapse(19999); assert.equal(guest.rooms.state, 'joining');
  await f.elapse(1); assert.equal(await joining, false);
  assert.match(guest.roomStatuses.at(-1).message, /超时/); assert.equal(f.peers.length, 2);
});

test('cancel resolves registration before a delayed library load and isolates its completion', async t => {
  const f = fixture(t); let resolveLibrary;
  const host = f.client({ loadPeer: () => new Promise(resolve => { resolveLibrary = resolve; }) });
  const creating = host.rooms.create(); await flush();
  host.rooms.close(); assert.equal(await creating, null);
  resolveLibrary(class { constructor() { assert.fail('cancelled load cannot create a peer'); } });
  await flush(); assert.equal(host.rooms.state, 'idle'); assert.equal(f.peers.length, 0);
});

test('cancel and rebuild ignore old peer callbacks and stale deadlines', async t => {
  const f = fixture(t, { stallRegistration: true }); const host = f.client();
  const first = host.rooms.create(); await flush();
  const old = f.peers[0], oldOpen = old.listeners('open')[0], oldError = old.listeners('error')[0];
  host.rooms.close(); assert.equal(await first, null);
  f.behavior.stallRegistration = false;
  const code = await host.rooms.create();
  oldOpen(); oldError({ type: 'unavailable-id' });
  await f.elapse(20000);
  assert.equal(host.rooms.state, 'waiting'); assert.equal(host.rooms.code, code); assert.equal(f.peers.length, 2);
});

test('an old reservation cannot close a replacement session', async t => {
  const f = fixture(t); const { session } = f.client();
  let disposed = 0;
  const old = session.openTransport({ role: 'host', dispose() { disposed++; } });
  const replacement = session.openTransport({ role: 'guest', dispose() { disposed++; } });
  old.close(); assert.equal(session.state, 'signaling'); assert.equal(session.role, 'guest');
  assert.equal(disposed, 1); replacement.close(); assert.equal(disposed, 2);
});

test('beginning a manual connection cancels a pending room; later Rooms.close leaves it alone', async t => {
  const f = fixture(t); const host = f.client();
  await host.rooms.create();
  const saved = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class { close() {} };
  try {
    assert.equal(host.session.join(), true);
    assert.equal(host.rooms.active, false); assert.equal(host.rooms.state, 'idle'); assert(f.peers[0].destroyed);
    host.rooms.close(); assert.equal(host.session.state, 'signaling'); assert.equal(host.session.role, 'guest');
  } finally { host.session.practice(); globalThis.RTCPeerConnection = saved; }
});

test('cancel during an unfinished join cannot revive either connection', async t => {
  const f = fixture(t, { stallConnection: true }); const host = f.client(), guest = f.client();
  const code = await host.rooms.create(); const joining = guest.rooms.join(code); await flush();
  const conn = f.peers[1].lastConnection, savedData = conn.listeners('data')[0];
  guest.rooms.close(); assert.equal(await joining, false);
  savedData(JSON.stringify({ room: protocol, type: 'accepted' })); await flush();
  assert.equal(guest.rooms.state, 'idle'); assert.equal(guest.rooms.active, false); assert(conn.closed);
});

test('signaling disconnect while waiting ends the room with a clear error', async t => {
  const f = fixture(t); const host = f.client(); await host.rooms.create();
  f.peers[0].emit('disconnected');
  assert.equal(host.rooms.state, 'error'); assert.match(host.roomStatuses.at(-1).message, /信令.*断开/);
  assert.equal(host.rooms.active, false);
});

test('a signaling disconnect after direct connection keeps the match running', async t => {
  const f = fixture(t); const { host, guest } = await pair(f);
  f.peers[0].emit('disconnected'); f.peers[1].emit('error', { type: 'network' });
  assert.deepEqual([host.session.state, guest.session.state], ['playing', 'playing']);
  assert.equal(host.rooms.state, 'connected'); assert.equal(guest.rooms.state, 'connected');
});

test('data channel loss freezes the game and releases both room peers', async t => {
  const f = fixture(t); const { host, guest } = await pair(f);
  f.connections[0].close(); await flush();
  assert.equal(host.session.state, 'disconnected'); assert.equal(guest.session.state, 'disconnected');
  assert.equal(host.rooms.active, false); assert.equal(guest.rooms.active, false);
});

test('malformed metadata is rejected without occupying or closing the host', async t => {
  const f = fixture(t, { metadata: { room: protocol, id: 'not-a-session-id' } });
  const host = f.client(), guest = f.client(); const code = await host.rooms.create();
  assert.equal(await guest.rooms.join(code), false);
  assert.equal(host.rooms.state, 'waiting'); assert.equal(host.rooms.active, true);
  assert.match(guest.roomStatuses.at(-1).message, /不兼容/);
});

test('the original hello protocol refuses different builds and frees external resources', async t => {
  const f = fixture(t); const host = f.client(), guest = f.client({}, '87654321');
  const code = await host.rooms.create(); await guest.rooms.join(code); await flush();
  assert([host.session.state, guest.session.state].includes('error'));
  assert([...host.statuses, ...guest.statuses].some(({ message }) => /版本或配置不一致/.test(message)));
  assert.equal(host.rooms.active, false); assert.equal(guest.rooms.active, false);
});

test('unexpected connect exceptions retain diagnostics without leaking a pending room', async t => {
  const error = new Error('serializer not a constructor'); const f = fixture(t, { throwConnect: error });
  const log = t.mock.method(console, 'error', () => {});
  const guest = f.client(); assert.equal(await guest.rooms.join('123456'), false);
  assert.equal(log.mock.calls.length, 1); assert.equal(log.mock.calls[0].arguments[2], error);
  assert.equal(guest.rooms.state, 'error'); assert.equal(guest.rooms.active, false);
});
