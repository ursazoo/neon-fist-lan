import assert from 'node:assert/strict';
import test from 'node:test';
import { CHARACTERS, isCharacter } from '../shared/characters.js';
import { createSession } from '../shared/netplay.js';
import { configFingerprint } from '../shared/integrity.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

function pair(t, choices = ['deepseek', 'claude'], transform = message => message) {
  const peers = [], messages = [], statuses = [[], []];
  class Channel {
    label = 'fight'; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
    readyState = 'connecting'; bufferedAmount = 0;
    send(raw) {
      const message = transform(JSON.parse(raw), this.owner);
      messages.push(message);
      queueMicrotask(() => this.other.onmessage?.({ data: JSON.stringify(message) }));
    }
    close() { this.readyState = 'closed'; }
  }
  class Peer {
    iceGatheringState = 'complete';
    constructor() { this.number = peers.push(this) - 1; }
    createDataChannel() {
      this.channel = new Channel(); this.channel.owner = this.number;
      return this.channel;
    }
    description(type) { return { type, sdp: 'v=0\r\na=candidate:test\r\npeer=' + this.number }; }
    async createOffer() { return this.description('offer'); }
    async createAnswer() { return this.description('answer'); }
    async setLocalDescription(description) {
      this.localDescription = { ...description, toJSON: () => description };
    }
    async setRemoteDescription(description) {
      const other = peers[Number(description.sdp.split('peer=')[1])];
      if (description.type === 'offer') {
        this.createDataChannel();
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
  t.mock.method(globalThis, 'setInterval', () => 0);
  const nativeRTC = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = Peer;
  const engines = choices.map(choice => ({
    choice, resets: [],
    selection() { return this.choice; },
    reset(seed, roster) { this.resets.push({ seed, roster }); },
    hash() { return configFingerprint(this.resets.at(-1)); },
    frame: () => 0, config: () => '12345678', build: () => 'abcdef01'
  }));
  const sessions = engines.map((engine, index) => createSession(engine, status => statuses[index].push(status)));
  t.after(() => {
    sessions.forEach(session => session.close());
    globalThis.RTCPeerConnection = nativeRTC;
  });
  return {
    engines, sessions, messages, statuses,
    async connect() {
      const offer = await sessions[0].host();
      assert(offer); assert(sessions[1].join());
      const answer = await sessions[1].accept(offer);
      assert(answer); await sessions[0].accept(answer); await flush();
    }
  };
}

test('registry contains only the three selectable characters and stable image paths', () => {
  assert.deepEqual(CHARACTERS.map(({ id, name, image }) => ({ id, name, image })), [
    { id: 'deepseek', name: 'DeepSeek', image: 'assets/fighters/deepseek.png' },
    { id: 'claude', name: 'Claude', image: 'assets/fighters/claude.png' },
    { id: 'chatgpt', name: 'ChatGPT', image: 'assets/fighters/chatgpt.png' }
  ]);
  for (const id of [null, undefined, '__proto__', 'DEEPSEEK', '', 0]) assert.equal(isCharacter(id), false);
});

for (const choices of [['deepseek', 'claude'], ['chatgpt', 'deepseek'], ['claude', 'claude']]) {
  test('both peers start with the host/guest choices ' + choices.join('/'), async t => {
    const fixture = pair(t, choices);
    const { engines, sessions, messages } = fixture;
    await fixture.connect();
    assert.deepEqual(sessions.map(session => session.state), ['playing', 'playing']);
    assert.deepEqual(engines.map(engine => engine.resets[0].roster), [choices, choices]);
    assert.equal(engines[0].hash(), engines[1].hash());
    assert(messages.every(message => message.v === 2));
    const view = sessions[0].roster; view[0] = 'forged';
    assert.deepEqual(sessions[0].roster, choices);
  });
}


test('choices freeze at begin before signaling finishes', async t => {
  const { engines, sessions, messages } = pair(t);
  const offer = await sessions[0].host();
  sessions[1].join();
  engines.forEach(engine => { engine.choice = 'chatgpt'; });
  const answer = await sessions[1].accept(offer);
  await sessions[0].accept(answer); await flush();
  assert.deepEqual(sessions.map(session => session.state), ['playing', 'playing']);
  assert.deepEqual(sessions.map(session => session.roster), [['deepseek', 'claude'], ['deepseek', 'claude']]);
  assert.deepEqual(messages.filter(message => message.type === 'hello').map(message => message.character).sort(), ['claude', 'deepseek']);
});

test('invalid local choice fails before producing a connection code', async t => {
  const { sessions, statuses } = pair(t, ['unknown', 'claude']);
  assert.equal(await sessions[0].host(), null);
  assert.equal(sessions[0].state, 'error');
  assert.match(statuses[0].at(-1).message, /角色选择无效/);
});

test('hello refuses an unknown character before resetting the match', async t => {
  const fixture = pair(t, undefined, (message, sender) => message.type === 'hello' && sender === 1 ? { ...message, character: 'unknown' } : message);
  await fixture.connect();
  assert.equal(fixture.sessions[0].state, 'error');
  assert.equal(fixture.engines[0].resets.length, 0);
  assert.equal(fixture.engines[1].resets.length, 0);
});

for (const roster of [undefined, ['deepseek'], ['deepseek', 'unknown'], ['claude', 'deepseek'], ['deepseek', 'chatgpt'], ['deepseek', 'claude', 'chatgpt']]) {
  test('guest refuses a forged start roster ' + JSON.stringify(roster), async t => {
    const fixture = pair(t, undefined, message => message.type === 'start' ? { ...message, roster } : message);
    await fixture.connect();
    assert.equal(fixture.sessions[1].state, 'error');
    assert.equal(fixture.engines[1].resets.length, 0, 'reject before reset and initial hash');
    assert.match(fixture.statuses[1].at(-1).message, /开局消息无效/);
  });
}

test('old protocol connection codes cannot join', async t => {
  const { sessions, statuses } = pair(t);
  const offer = JSON.parse(atob(await sessions[0].host()));
  assert.equal(offer.v, 2);
  offer.v = 1; sessions[1].join();
  assert.equal(await sessions[1].accept(btoa(JSON.stringify(offer))), null);
  assert.equal(sessions[1].state, 'signaling');
  assert.match(statuses[1].at(-1).message, /版本不支持/);
});
