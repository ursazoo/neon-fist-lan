import { Lockstep } from './lockstep.js';
import { isCharacter } from './characters.js';

const VERSION = 2;
const CODE_LIMIT = 65536;
const MESSAGE_LIMIT = 4096;
const TIMEOUT = 15000;
const SIGNAL_TIMEOUT = 180000;
const RUNNING = new Set(['playing', 'waiting']);
const LIVE = new Set(['connecting', 'handshake', 'playing', 'waiting', 'ended']);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{8}$/.test(value);
const validEpoch = value => Number.isSafeInteger(value) && value >= 0;

export function createSession(engine, onStatus) {
  let state = 'idle', role = null, id = '', epoch = 0, generation = 0;
  let pc = null, dc = null, queue = null, timer = null, connectTimer = null;
  let externalDispose = null;
  let config = '', build = '', stage = '', hello = false, busy = false;
  let votes = [false, false], remoteEnd = null;
  let localCharacter = null, remoteCharacter = null, roster = null;
  let acc = 0, last = null, progress = 0, received = 0, opened = 0;
  let history = [], hashes = new Map(), pendingHashes = new Map();
  const player = () => role === 'host' ? 0 : 1;
  const clock = () => performance.now();
  const identity = () => ({ v: VERSION, id, build, config });

  function status(next, message) {
    state = next;
    onStatus({ state, role, epoch, message });
  }
  function resetClock() { acc = 0; last = null; }
  function dispose(reason = { state: 'idle', message: '连接已取消' }) {
    generation++;
    clearInterval(timer); timer = null;
    clearTimeout(connectTimer); connectTimer = null;
    const oldDC = dc, oldPC = pc, release = externalDispose;
    dc = null; pc = null; externalDispose = null;
    if (oldDC) {
      oldDC.onopen = oldDC.onmessage = oldDC.onclose = oldDC.onerror = null;
      try { oldDC.close(); } catch {}
    }
    if (oldPC) {
      oldPC.onconnectionstatechange = oldPC.oniceconnectionstatechange = oldPC.ondatachannel = null;
      oldPC.close();
    }
    busy = false;
    resetClock();
    release?.(reason);
  }
  function stop(message, next = 'error', notify = true) {
    if (notify && dc?.readyState === 'open') {
      try { dc.send(JSON.stringify({ v: VERSION, id, epoch, type: 'leave', reason: message })); } catch {}
    }
    dispose({ state: next, message });
    status(next, message + '。可重新创建或加入连接');
  }
  function send(type, fields = {}) {
    if (dc?.readyState !== 'open') throw new Error('连接已断开');
    if (dc.bufferedAmount > 262144) throw new Error('发送队列过长');
    dc.send(JSON.stringify({ v: VERSION, id, epoch, type, ...fields }));
  }
  function compare(frame, hash) {
    const ours = hashes.get(frame);
    if (ours !== undefined) {
      if (ours !== hash) throw new Error('同步校验失败，帧 ' + frame);
      pendingHashes.delete(frame);
    } else {
      if (frame < engine.frame() - 119) throw new Error('校验帧已过期');
      pendingHashes.set(frame, hash);
    }
  }
  function checkpoint() {
    const frame = engine.frame(), hash = engine.hash();
    history.push({ epoch, frame, hash });
    hashes.set(frame, hash);
    if (history.length > 120) hashes.delete(history.shift().frame);
    if (pendingHashes.has(frame)) compare(frame, pendingHashes.get(frame));
    return hash;
  }
  function resetMatch(nextEpoch, seed, characters) {
    roster = Object.freeze([...characters]);
    epoch = nextEpoch;
    queue = new Lockstep(player());
    votes = [false, false]; remoteEnd = null;
    history = []; hashes = new Map(); pendingHashes = new Map();
    resetClock();
    engine.reset(seed, [...roster]);
    opened = progress = clock();
    stage = 'prepared';
    status('handshake', '正在同步开局');
    return checkpoint();
  }
  function prepare() {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    const hash = resetMatch(epoch + 1, seed, roster || [localCharacter, remoteCharacter]);
    send('start', { seed, hash, roster });
  }
  function play() {
    stage = 'running';
    resetClock(); progress = clock();
    status('playing', '已同步');
  }
  function maybeRematch() {
    if (role === 'host' && state === 'ended' && remoteEnd && votes.every(Boolean)) prepare();
  }
  function verifyEnd() {
    if (!remoteEnd) return;
    if (remoteEnd.frame < engine.frame() ||
        (state === 'ended' && remoteEnd.frame !== engine.frame())) {
      throw new Error('比赛结束帧不同');
    }
    compare(remoteEnd.frame, remoteEnd.hash);
    if (state === 'ended') maybeRematch();
  }
  function receive(raw) {
    if (typeof raw !== 'string' || raw.length > MESSAGE_LIMIT) throw new Error('消息过大或格式错误');
    const m = JSON.parse(raw);
    if (!m || m.v !== VERSION || m.id !== id || !validEpoch(m.epoch)) throw new Error('连接消息不匹配');
    if (m.epoch < epoch) return;
    if (m.type === 'hello') {
      if (hello || state !== 'handshake' || m.epoch !== 0 || m.role === role ||
          !['host', 'guest'].includes(m.role) || m.build !== build || m.config !== config ||
          !isCharacter(m.character)) {
        throw new Error('游戏版本或配置不一致');
      }
      remoteCharacter = m.character;
      hello = true;
      if (role === 'host') prepare();
      return;
    }
    if (m.type === 'start') {
      if (m.epoch <= epoch) return;
      if (!hello || role !== 'guest' || m.epoch !== epoch + 1 ||
          !(state === 'handshake' && epoch === 0 || state === 'ended' && votes.every(Boolean)) ||
          !Number.isInteger(m.seed) || m.seed < 1 || m.seed > 0xffffffff || !validHash(m.hash) ||
          !Array.isArray(m.roster) || m.roster.length !== 2 || !m.roster.every(isCharacter) ||
          m.roster[0] !== remoteCharacter || m.roster[1] !== localCharacter) {
        throw new Error('开局消息无效');
      }
      const hash = resetMatch(m.epoch, m.seed, m.roster);
      if (hash !== m.hash) throw new Error('开局状态校验失败');
      send('ready', { hash });
      return;
    }
    if (m.epoch !== epoch) throw new Error('比赛编号不匹配');
    switch (m.type) {
      case 'leave':
        stop(typeof m.reason === 'string' ? '对方结束连接：' + m.reason.slice(0, 180) : '对方已离开', 'disconnected', false); break;
      case 'ready':
        if (role !== 'host' || stage !== 'prepared' || m.hash !== hashes.get(0)) throw new Error('准备状态校验失败');
        stage = 'awaitingAck'; send('go'); break;
      case 'go':
        if (role !== 'guest' || stage !== 'prepared') throw new Error('启动顺序错误');
        send('ack'); play(); break;
      case 'ack':
        if (role !== 'host' || stage !== 'awaitingAck') throw new Error('启动确认错误');
        play(); break;
      case 'input':
        if (!queue || !['running', 'awaitingAck'].includes(stage)) throw new Error('尚未开始接收输入');
        queue.receive(m.frame, m.mask); break;
      case 'hash':
        if (!queue || !validHash(m.hash) || !Number.isSafeInteger(m.frame) || m.frame < 0 ||
            m.frame > queue.frame + 64) throw new Error('校验消息无效');
        compare(m.frame, m.hash); break;
      case 'end':
        if (!queue || !validHash(m.hash) || !Number.isSafeInteger(m.frame) ||
            m.frame < engine.frame() || m.frame > queue.frame + 64) throw new Error('结束消息无效');
        remoteEnd = { frame: m.frame, hash: m.hash }; verifyEnd(); break;
      case 'rematch':
        if (!remoteEnd || !['playing', 'waiting', 'ended'].includes(state)) throw new Error('重赛顺序错误');
        votes[1 - player()] = true;
        if (state === 'ended') status('ended', votes[player()] ? '双方已同意重赛' : '对方想再来一局，按 Enter 同意');
        maybeRematch(); break;
      case 'ping': break;
      default: throw new Error('未知消息');
    }
  }
  function wire(channel, token) {
    if (token !== generation) { channel.close(); return; }
    if (dc || channel.label !== 'fight' || !channel.ordered ||
        channel.maxRetransmits != null || channel.maxPacketLifeTime != null) {
      channel.close(); throw new Error('需要可靠有序的对战通道');
    }
    dc = channel;
    let didOpen = false;
    dc.onopen = () => {
      if (token !== generation || didOpen) return;
      didOpen = true;
      try {
        clearTimeout(connectTimer); connectTimer = null;
        opened = progress = received = clock();
        status('handshake', '正在核对游戏版本');
        send('hello', { ...identity(), role, character: localCharacter });
        timer = setInterval(() => {
          if (token !== generation) return;
          const now = clock();
          if (now - received > TIMEOUT || RUNNING.has(state) && now - progress > TIMEOUT ||
              state === 'handshake' && now - opened > TIMEOUT) {
            stop('同步超时，比赛已冻结', 'disconnected'); return;
          }
          try { send('ping'); } catch (e) { stop(e.message, 'disconnected'); }
        }, 1000);
      } catch (e) { stop(e.message); }
    };
    dc.onmessage = event => {
      if (token !== generation) return;
      try { received = clock(); receive(event.data); } catch (e) { stop(e.message); }
    };
    dc.onclose = dc.onerror = () => {
      if (token === generation) stop('连接已断开，比赛已冻结', 'disconnected', false);
    };
    if (dc.readyState === 'open') queueMicrotask(dc.onopen);
  }
  function begin(nextRole, external = false) {
    dispose();
    role = nextRole; id = ''; epoch = 0; hello = false; stage = '';
    queue = null; history = []; hashes.clear(); pendingHashes.clear();
    localCharacter = engine.selection(); remoteCharacter = null; roster = null;
    if (!isCharacter(localCharacter)) throw new Error('角色选择无效');
    config = engine.config(); build = engine.build();
    if (!config || !build) throw new Error('游戏资源尚未加载');
    status('signaling', external ? '正在连接房间' : role === 'host' ? '正在生成主机连接码' : '粘贴主机连接码，再点击接受');
    const token = generation;
    if (external) return token;
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = () => {
      if (token !== generation) return;
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) ||
          ['failed', 'closed', 'disconnected'].includes(pc.iceConnectionState)) {
        stop('网络中断，比赛已冻结', 'disconnected', false);
      }
    };
    pc.ondatachannel = event => {
      if (token !== generation) { event.channel.close(); return; }
      try { wire(event.channel, token); } catch (e) { stop(e.message); }
    };
    return token;
  }
  async function gather(connection, token) {
    await new Promise((resolve, reject) => {
      let timeout;
      function done(error) {
        clearTimeout(timeout);
        connection.removeEventListener('icegatheringstatechange', check);
        error ? reject(error) : resolve();
      }
      function check() {
        if (token !== generation) done(new Error('连接已取消'));
        else if (connection.iceGatheringState === 'complete') done();
      }
      timeout = setTimeout(() => done(new Error('ICE 收集超时，请重试')), 10000);
      connection.addEventListener('icegatheringstatechange', check);
      check();
    });
    if (token !== generation || connection !== pc) throw new Error('连接已取消');
    if (!connection.localDescription?.sdp?.includes('a=candidate:')) throw new Error('没有局域网候选地址，请检查网络后重试');
    return btoa(JSON.stringify({ ...identity(), role, sdp: connection.localDescription.toJSON() }));
  }
  function decode(code) {
    if (typeof code !== 'string' || code.length > CODE_LIMIT || !code.trim()) throw new Error('请粘贴有效连接码');
    let data;
    try { data = JSON.parse(atob(code.trim())); } catch { throw new Error('连接码格式错误，请重新粘贴'); }
    if (!data || data.v !== VERSION || typeof data.id !== 'string' || !/^[a-f0-9]{32}$/.test(data.id) ||
        !['host', 'guest'].includes(data.role) || !data.sdp ||
        data.sdp.type !== (data.role === 'host' ? 'offer' : 'answer') ||
        typeof data.sdp.sdp !== 'string' || data.sdp.sdp.length > 45000 ||
        !data.sdp.sdp.startsWith('v=0') || !data.sdp.sdp.includes('a=candidate:')) throw new Error('连接码不完整或版本不支持');
    if (data.build !== build || data.config !== config) throw new Error('游戏版本或配置不一致，请双方刷新同一页面');
    return data;
  }
  function watchConnection(token, awaitingHost = false) {
    status('connecting', awaitingHost ? '等待主机接受回传码，请保持窗口打开' : '正在直连对方，请保持两个窗口打开');
    connectTimer = setTimeout(() => {
      if (token === generation && state === 'connecting') stop(awaitingHost ?
        '回传码等待超过 3 分钟，请重新连接' : '直连超时，请检查同一 Wi-Fi 和防火墙后重试', 'disconnected');
    }, awaitingHost ? SIGNAL_TIMEOUT : TIMEOUT);
  }

  return Object.freeze({
    openTransport({ role: nextRole, dispose: release }) {
      if (!['host', 'guest'].includes(nextRole) || typeof release !== 'function') {
        throw new Error('外部连接参数无效');
      }
      let token;
      try { token = begin(nextRole, true); }
      catch (e) { stop(e.message); return null; }
      externalDispose = release;
      return Object.freeze({
        attach({ id: sessionID, channel }) {
          if (token !== generation) { channel.close(); return false; }
          try {
            if (typeof sessionID !== 'string' || !/^[a-f0-9]{32}$/.test(sessionID)) throw new Error('房间会话编号无效');
            id = sessionID;
            watchConnection(token);
            wire(channel, token);
            return true;
          } catch (e) {
            channel.close(); stop(e.message); return false;
          }
        },
        close(reason) {
          if (token === generation) stop(reason?.message || '已离开对局，比赛已冻结',
            reason?.state === 'error' ? 'error' : 'disconnected');
        }
      });
    },
    async host() {
      let token;
      try {
        token = begin('host'); busy = true;
        id = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
        const connection = pc;
        wire(connection.createDataChannel('fight', { ordered: true }), token);
        await connection.setLocalDescription(await connection.createOffer());
        const code = await gather(connection, token);
        if (token === generation) status('signaling', '主机连接码已生成。发给客机，等待客机回传连接码');
        return token === generation ? code : null;
      } catch (e) { if (token === generation || token === undefined) stop(e.message); return null; }
      finally { if (token === generation) busy = false; }
    },
    join() {
      try { begin('guest'); return true; } catch (e) { stop(e.message); return false; }
    },
    async accept(code) {
      if (busy) { status(state, '正在处理，请稍候'); return null; }
      if (state !== 'signaling' || !pc) { status(state, '请先创建连接或选择加入'); return null; }
      let data;
      try {
        data = decode(code);
        if (data.role === role || role === 'host' && data.id !== id) throw new Error('连接码角色或会话不匹配');
      } catch (e) { status(state, e.message); return null; }
      const token = generation, connection = pc;
      busy = true;
      try {
        if (role === 'guest') id = data.id;
        else watchConnection(token);
        await connection.setRemoteDescription(data.sdp);
        if (token !== generation) return null;
        if (role === 'guest') {
          await connection.setLocalDescription(await connection.createAnswer());
          const answer = await gather(connection, token);
          if (token !== generation) return null;
          watchConnection(token, true);
          status(state, '客机连接码已生成。请在 3 分钟内复制回传给主机，由主机粘贴接受');
          return answer;
        }
      } catch (e) { if (token === generation) stop(e.message); }
      finally { if (token === generation) busy = false; }
      return null;
    },
    tick(now, mask, hidden = false) {
      if (!RUNNING.has(state) || hidden) { resetClock(); return; }
      try {
        if (now - progress > TIMEOUT) { stop('等待输入超时，比赛已冻结', 'disconnected'); return; }
        if (last === null) { last = now; return; }
        const dt = Math.min(100, Math.max(0, now - last)); last = now;
        if (state === 'waiting') {
          if (!queue.ready) { acc = 0; return; }
          resetClock(); last = now; status('playing', '已同步'); return;
        }
        acc += dt * engine.rate();
        let steps = 0;
        while (acc >= 1000 / 60 && steps < 5 && RUNNING.has(state)) {
          const captured = queue.capture(mask);
          if (captured) send('input', captured);
          if (!queue.ready) { resetClock(); status('waiting', '等待对方输入，请保持对方窗口可见'); break; }
          queue.advance(engine.step);
          progress = now;
          const hash = checkpoint(), frame = engine.frame();
          if (frame !== queue.frame) throw new Error('模拟帧号不同');
          acc -= 1000 / 60; steps++;
          if (engine.ended()) {
            send('hash', { frame, hash });
            send('end', { frame, hash });
            resetClock();
            status('ended', '比赛结束，按 Enter 请求重赛，双方同意后开始');
            verifyEnd();
          } else if (frame % 30 === 0) send('hash', { frame, hash });
        }
        if (steps === 5) acc = 0;
      } catch (e) { stop(e.message); }
    },
    suspend() { resetClock(); },
    rematch() {
      if (state !== 'ended' || votes[player()]) return;
      try {
        votes[player()] = true;
        send('rematch');
        status('ended', '已请求重赛，等待对方同意');
        maybeRematch();
      } catch (e) { stop(e.message); }
    },
    close() { stop('已离开对局，比赛已冻结', 'disconnected'); },
    practice() { dispose(); role = null; epoch = 0; history = []; status('idle', '本地练习'); },
    get active() { return LIVE.has(state); },
    get state() { return state; },
    get role() { return role; },
    get epoch() { return epoch; },
    get roster() { return roster ? [...roster] : null; },
    get frame() { return engine.frame(); },
    get waiting() { return state === 'waiting'; },
    get config() { return config; },
    get build() { return build; },
    get checkpoints() { return history.map(item => ({ ...item })); },
    get pc() { return pc || dc?.peerConnection || null; },
    getStats() { return (pc || dc?.peerConnection)?.getStats(); }
  });
}
