const PROTOCOL = 'neon-fist-room-v1';
const PREFIX = 'neonfist-room-v1-';
const ID = /^[a-f0-9]{32}$/;
let library;

async function loadPeer() {
  if (!library) {
    library = import('./vendor/peerjs.min.js').then(() => {
      const Peer = globalThis.peerjs?.Peer || globalThis.Peer;
      if (typeof Peer !== 'function') throw new Error('PeerJS 未加载');
      return Peer;
    }).catch(() => {
      library = null;
      throw new Error('房间组件加载失败，请重试或使用手动连接');
    });
  }
  return library;
}

function randomID() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
}
function randomCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
}
function digits(value) {
  return /^[\d\s-]+$/.test(value) && /^\d{6}$/.test(value.replace(/[\s-]/g, '')) ? value.replace(/[\s-]/g, '') : null;
}

export function normalizeRoomCode(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const input = value.trim(), code = digits(input);
  if (code) return code;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const params = new URLSearchParams(url.hash.slice(1));
    return params.getAll('room').length === 1 ? digits(params.get('room')) : null;
  } catch { return null; }
}

export function roomLink(code, baseURL = globalThis.location?.href) {
  code = normalizeRoomCode(code);
  if (!code) return null;
  try {
    const url = new URL(baseURL);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = 'room=' + code;
    return url.href;
  } catch { return null; }
}

function reliable(connection) {
  const channel = connection.dataChannel;
  return connection.label === 'fight' && connection.serialization === 'raw' && connection.reliable === true &&
    channel?.label === 'fight' && channel.ordered === true &&
    channel.maxRetransmits == null && channel.maxPacketLifeTime == null && channel.readyState === 'open';
}

function adapt(connection) {
  const raw = connection.dataChannel;
  const channel = {
    label: raw.label, ordered: raw.ordered,
    maxRetransmits: raw.maxRetransmits, maxPacketLifeTime: raw.maxPacketLifeTime,
    get readyState() { return connection.open ? raw.readyState : 'closed'; },
    get bufferedAmount() { return raw.bufferedAmount; },
    get peerConnection() { return connection.peerConnection; },
    send(data) { connection.send(data); },
    close() {
      for (const [event, handler] of handlers) connection.off(event, handler);
      connection.close();
    }
  };
  const handlers = [
    ['data', data => channel.onmessage?.({ data })],
    ['close', () => channel.onclose?.()],
    ['error', () => channel.onerror?.()]
  ];
  for (const [event, handler] of handlers) connection.on(event, handler);
  return channel;
}

// Net owns the reservation before registration, so a manual session also cancels pending room work.
export function createRooms(session, onStatus, options = {}) {
  const getPeer = options.loadPeer || (options.Peer ? async () => options.Peer : loadPeer);
  const generateCode = options.randomCode || randomCode;
  const registrationTimeout = options.registrationTimeout ?? 15000;
  const joinTimeout = options.joinTimeout ?? 20000;
  const maxAttempts = options.maxAttempts ?? 5;
  let current = null, snapshot = { state: 'idle', code: '', message: '' };

  function publish(state, message, code = current?.code || '') {
    snapshot = { state, code, message };
    onStatus({ ...snapshot });
  }
  function alive(op) { return current === op; }
  function listen(op, target, event, callback) {
    const handler = (...args) => { if (alive(op)) callback(...args); };
    target.on(event, handler);
    const remove = () => { target.off(event, handler); op.cleanups.delete(remove); };
    op.cleanups.add(remove);
    return remove;
  }
  function later(op, callback, ms) {
    const timer = setTimeout(() => {
      op.timers.delete(timer);
      if (alive(op)) callback();
    }, ms);
    op.timers.add(timer);
    return timer;
  }
  function cancelTimer(op, timer) { clearTimeout(timer); op.timers.delete(timer); }
  function settle(op, value) { op.resolve?.(value); op.resolve = null; }
  function finish(op, state, message) {
    if (!alive(op)) return;
    current = null;
    for (const timer of op.timers) clearTimeout(timer);
    for (const remove of [...op.cleanups]) remove();
    for (const connection of op.connections) { try { connection.close(); } catch {} }
    try { op.peer?.destroy(); } catch {}
    op.scope?.close({ state, message });
    settle(op, op.role === 'host' ? null : false);
    publish(state, message, state === 'idle' ? '' : op.code);
  }
  function fail(op, message) { finish(op, 'error', message); }
  function failed(op, message, error) {
    if (!alive(op)) return;
    console.error('[NeonFist rooms]', message, error);
    fail(op, message);
  }
  function start(role, code = '') {
    if (current) finish(current, 'idle', '房间已关闭');
    const op = { role, code, peer: null, attempts: 0, connection: null, attached: false,
      timers: new Set(), cleanups: new Set(), connections: new Set(), scope: null };
    op.promise = new Promise(resolve => { op.resolve = resolve; });
    current = op;
    publish(role === 'host' ? 'creating' : 'joining', role === 'host' ? '正在创建房间' : '正在加入房间');
    try {
      op.scope = session.openTransport({ role, dispose(reason) {
        finish(op, ['error', 'disconnected'].includes(reason.state) ? 'error' : 'idle', reason.message);
      } });
      if (!op.scope) { fail(op, '无法开始联机，请等待游戏资源加载后重试'); return op; }
      op.deadline = later(op, () => fail(op, role === 'host' ?
        '房间注册超时，请重试或使用手动连接' : '加入超时，请检查同一 Wi-Fi 和防火墙后重试'),
      role === 'host' ? registrationTimeout : joinTimeout);
      Promise.resolve().then(getPeer).then(Peer => {
        if (alive(op)) register(op, Peer);
      }).catch(error => failed(op, error.message || '信令服务不可用，请重试或使用手动连接', error));
    } catch (error) { fail(op, error.message); }
    return op;
  }

  function attach(op, connection, id, removeListeners) {
    if (!alive(op)) { connection.close(); return; }
    if (!reliable(connection)) { fail(op, '需要可靠有序的对战通道'); return; }
    for (const remove of removeListeners) remove();
    op.attached = true;
    if (!op.scope.attach({ id, channel: adapt(connection) }) || !alive(op)) return;
    cancelTimer(op, op.deadline);
    publish('connected', '已直连，正在同步对局');
    settle(op, op.role === 'host' ? op.code : true);
  }

  function reject(op, connection, reason) {
    op.connections.add(connection);
    let sent = false;
    const removers = [];
    let timer;
    function close() {
      cancelTimer(op, timer);
      for (const remove of removers) remove();
      op.connections.delete(connection);
      try { connection.close(); } catch {}
    }
    function send() {
      if (sent) return;
      sent = true;
      cancelTimer(op, timer);
      try { connection.send(JSON.stringify({ room: PROTOCOL, type: 'rejected', reason })); }
      catch { close(); return; }
      // Keep the channel alive long enough for the reliable rejection to reach the guest.
      timer = later(op, close, 1000);
    }
    removers.push(listen(op, connection, 'open', send), listen(op, connection, 'close', close), listen(op, connection, 'error', close));
    timer = later(op, close, joinTimeout);
    if (connection.open) send();
  }

  function incoming(op, connection) {
    if (op.connection) { reject(op, connection, 'full'); return; }
    const metadata = connection.metadata;
    if (!metadata || Array.isArray(metadata) || metadata.room !== PROTOCOL ||
        typeof metadata.id !== 'string' || !ID.test(metadata.id) ||
        connection.label !== 'fight' || connection.serialization !== 'raw' || connection.reliable !== true) {
      reject(op, connection, 'invalid'); return;
    }
    op.connection = connection;
    op.connections.add(connection);
    op.deadline = later(op, () => fail(op, '直连超时，请检查同一 Wi-Fi 和防火墙后重试'), joinTimeout);
    const removers = [];
    function open() {
      if (op.attached) return;
      if (!reliable(connection)) { fail(op, '需要可靠有序的对战通道'); return; }
      try {
        connection.send(JSON.stringify({ room: PROTOCOL, type: 'accepted' }));
        attach(op, connection, metadata.id, removers);
      } catch { fail(op, '连接已断开，请重试'); }
    }
    removers.push(listen(op, connection, 'open', open),
      listen(op, connection, 'close', () => fail(op, '对方已取消加入，请重新创建房间')),
      listen(op, connection, 'error', () => fail(op, '直连失败，请检查同一 Wi-Fi 和防火墙后重试')));
    if (connection.open) open();
  }

  function outgoing(op) {
    const id = randomID();
    const connection = op.peer.connect(PREFIX + op.code, {
      label: 'fight', reliable: true, serialization: 'raw', metadata: { room: PROTOCOL, id }
    });
    if (!connection) { fail(op, '无法加入房间，请重试'); return; }
    op.connection = connection;
    op.connections.add(connection);
    const removers = [];
    removers.push(listen(op, connection, 'data', data => {
      let message;
      try {
        if (typeof data !== 'string' || data.length > 512) throw new Error();
        message = JSON.parse(data);
      } catch { fail(op, '房间响应无效，请重试'); return; }
      if (message?.room !== PROTOCOL) { fail(op, '房间响应无效，请重试'); return; }
      if (message.type === 'rejected') {
        fail(op, message.reason === 'full' ? '房间已满，请让对方重新创建房间' : '房间连接不兼容，请双方刷新后重试');
      } else if (message.type === 'accepted') attach(op, connection, id, removers);
      else fail(op, '房间响应无效，请重试');
    }), listen(op, connection, 'close', () => fail(op, '房间连接已关闭，请重试')),
    listen(op, connection, 'error', () => fail(op, '直连失败，请检查同一 Wi-Fi 和防火墙后重试')));
  }

  function register(op, Peer) {
    if (!alive(op)) return;
    op.attempts++;
    const candidate = op.role === 'host' ? normalizeRoomCode(generateCode()) : '';
    if (op.role === 'host' && !candidate) { fail(op, '无法生成房间号，请重试'); return; }
    const peer = new Peer(op.role === 'host' ? PREFIX + candidate : 'neonfist-guest-' + randomID(), {
      config: { iceServers: [] }, debug: 0
    });
    op.peer = peer;
    listen(op, peer, 'open', () => {
      if (op.peer !== peer) return;
      if (op.role === 'host') {
        op.code = candidate;
        cancelTimer(op, op.deadline);
        publish('waiting', '等待对方输入房间号');
        settle(op, op.code);
      } else {
        try { outgoing(op); } catch (error) { failed(op, '无法加入房间，请重试或使用手动连接', error); }
      }
    });
    listen(op, peer, 'connection', connection => {
      if (op.peer !== peer) { connection.close(); return; }
      if (op.role === 'host' && snapshot.state !== 'creating') incoming(op, connection);
      else reject(op, connection, 'invalid');
    });
    listen(op, peer, 'call', call => call.close());
    listen(op, peer, 'error', error => {
      if (op.peer !== peer || op.attached) return;
      if (op.role === 'host' && snapshot.state === 'creating' && error.type === 'unavailable-id') {
        op.peer = null;
        peer.destroy();
        if (op.attempts < maxAttempts) {
          try { register(op, Peer); } catch { fail(op, '信令服务不可用，请重试或使用手动连接'); }
        } else fail(op, '房间号注册冲突，请重试');
      } else fail(op, error.type === 'peer-unavailable' ? '未找到房间，请核对房间号或让对方重新创建' :
        '信令服务不可用，请重试或使用手动连接');
    });
    for (const event of ['disconnected', 'close']) listen(op, peer, event, () => {
      if (op.peer === peer && !op.attached) fail(op, '信令服务已断开，请重试或使用手动连接');
    });
  }

  return Object.freeze({
    async create() { return start('host').promise; },
    async join(value) {
      const code = normalizeRoomCode(value);
      if (!code) {
        if (!current) publish('error', '请输入 6 位数字房间号或有效邀请链接', '');
        return false;
      }
      return start('guest', code).promise;
    },
    close() {
      if (current) finish(current, 'idle', '房间已关闭');
      else publish('idle', '', '');
    },
    get state() { return snapshot.state; },
    get code() { return snapshot.code; },
    get active() { return current !== null; }
  });
}
