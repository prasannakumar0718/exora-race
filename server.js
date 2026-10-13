'use strict';

// Production-ready, dependency-free WebSocket + HTTP authoritative server for Lane Rush.
// The server owns road progression, traffic/coin simulation, scoring, collisions,
// reconnection sessions, rate limiting, and race state.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim().toLowerCase()) : null;
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const TICK_MS = Number(process.env.TICK_MS || 50); // 20 authoritative updates / second
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 45_000);
const ROOM_IDLE_MS = 10 * 60_000;
const MAX_MSG_SIZE = 4096; // 4 KB max incoming WebSocket payload
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MSGS = 35;

const CLIENT_PATH = path.join(__dirname, 'index.html');
const LANES = [340, 480, 620];
const CAR_Y = 500;
const COLORS = ['#ff5e87', '#ffb34f', '#a78bfa', '#43e2c1', '#c5d3e8'];

const rooms = new Map();
const activeConnections = new Set();

const httpServer = http.createServer((req, res) => {
  const hostHeader = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${hostHeader}`);

  if (url.pathname === '/health') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({
      ok: true,
      service: 'lane-rush',
      rooms: rooms.size,
      connections: activeConnections.size,
      tickHz: Math.round(1000 / TICK_MS),
      reconnectGraceMs: RECONNECT_GRACE_MS,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: Date.now()
    }));
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(CLIENT_PATH, (err, body) => {
      if (err) {
        res.writeHead(500);
        res.end('Could not load game client');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

function frame(opcode, data = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsSend(conn, obj) {
  if (!conn || conn.closed || conn.socket.destroyed) return false;
  try {
    conn.socket.write(frame(1, JSON.stringify(obj)));
    return true;
  } catch (_) {
    return false;
  }
}

function wsClose(conn, code = 1000, reason = '') {
  if (!conn || conn.closed) return;
  conn.closed = true;
  activeConnections.delete(conn);
  const reasonBuf = Buffer.from(String(reason).slice(0, 100));
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  try { conn.socket.write(frame(8, payload)); } catch (_) {}
  try { conn.socket.end(); } catch (_) {}
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), b => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}

function isConnected(p) {
  return Boolean(p && p.connection && !p.connection.closed && !p.connection.socket.destroyed);
}

function sendNotice(conn, message, level = 'info') {
  wsSend(conn, { type: 'notice', message, level });
}

function allConnected(room) {
  return room.players.every(isConnected);
}

function sendSession(room, p) {
  wsSend(p.connection, {
    type: 'session',
    code: room.code,
    slot: p.slot,
    token: p.token,
    reconnectGraceMs: RECONNECT_GRACE_MS
  });
}

function addPlayer(room, slot, conn) {
  const p = {
    slot,
    token: randomToken(),
    connection: conn,
    lane: 1,
    score: 0,
    coins: 0,
    active: true,
    disconnectedAt: null,
    expired: false,
    lastInputAt: 0,
    rematchRequested: false
  };
  room.players[slot - 1] = p;
  conn.player = p;
  conn.room = room;
  return p;
}

function worldReset(room) {
  room.elapsed = 0;
  room.roadOffset = 0;
  room.spawnTimer = 0.65;
  room.coinTimer = 1.1;
  room.traffic = [];
  room.pickups = [];
  room.nextEntityId = 1;
  for (const p of room.players) {
    if (p) {
      p.lane = 1;
      p.score = 0;
      p.coins = 0;
      p.active = true;
      p.expired = false;
      p.rematchRequested = false;
      p.disconnectedAt = null;
    }
  }
}

function beginCountdown(room, mode) {
  room.status = 'countdown';
  room.countdownMode = mode;
  room.startAt = Date.now() + 2500;
  room.lastActiveAt = Date.now();
  for (const p of room.players) {
    if (p && isConnected(p)) {
      wsSend(p.connection, {
        type: 'notice',
        message: mode === 'new'
          ? 'Both drivers connected. Race starts in 3…'
          : 'Connection restored. Resuming in 3…',
        level: 'info'
      });
    }
  }
}

function handleDisconnect(conn) {
  const p = conn.player;
  if (!p || p.connection !== conn) return;
  const room = conn.room;
  p.connection = null;
  p.disconnectedAt = Date.now();
  if (room && rooms.has(room.code)) {
    if (room.status === 'racing' || room.status === 'countdown') {
      room.suspendedMode = room.status === 'countdown' ? room.countdownMode : 'resume';
      room.status = 'reconnecting';
    }
    room.lastActiveAt = Date.now();
  }
  conn.player = null;
  conn.room = null;
}

function snapshot(room) {
  const now = Date.now();
  let reconnectGraceRemainingMs = 0;
  if (room.status === 'reconnecting') {
    const dcTimes = room.players
      .filter(p => p && !isConnected(p) && p.disconnectedAt && !p.expired)
      .map(p => Math.max(0, RECONNECT_GRACE_MS - (now - p.disconnectedAt)));
    if (dcTimes.length) reconnectGraceRemainingMs = Math.min(...dcTimes);
  }

  return {
    type: 'state',
    code: room.code,
    status: room.status,
    countdownMs: room.status === 'countdown' ? Math.max(0, room.startAt - now) : 0,
    reconnectGraceRemainingMs,
    elapsed: room.elapsed,
    roadOffset: room.roadOffset,
    players: room.players.map(p => p ? ({
      slot: p.slot,
      lane: p.lane,
      score: Math.floor(p.score),
      coins: p.coins,
      active: p.active,
      connected: isConnected(p),
      expired: p.expired,
      rematchRequested: p.rematchRequested
    }) : null),
    traffic: room.traffic.map(t => ({
      id: t.id,
      lane: t.lane,
      y: t.y,
      w: t.w,
      h: t.h,
      speed: t.speed,
      color: t.color,
      truck: t.truck,
      passed: t.passed
    })),
    pickups: room.pickups.map(c => ({
      id: c.id,
      lane: c.lane,
      y: c.y,
      r: c.r,
      spin: c.spin,
      collectedBy: Array.isArray(c.collectedBy) ? c.collectedBy : []
    })),
    winner: room.winner || null
  };
}

function broadcast(room) {
  const state = snapshot(room);
  for (const p of room.players) {
    if (isConnected(p)) wsSend(p.connection, state);
  }
}

function sendState(room) {
  broadcast(room);
}

function initRoom(code, p) {
  return {
    code,
    players: [p, null],
    status: 'waiting',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    elapsed: 0,
    roadOffset: 0,
    spawnTimer: 0.65,
    coinTimer: 1.1,
    traffic: [],
    pickups: [],
    nextEntityId: 1,
    countdownMode: 'new',
    suspendedMode: 'resume',
    startAt: 0,
    winner: null
  };
}

function checkRateLimit(conn) {
  const now = Date.now();
  if (now - conn.rateWindowStart > RATE_LIMIT_WINDOW_MS) {
    conn.rateWindowStart = now;
    conn.msgCount = 1;
    return true;
  }
  conn.msgCount++;
  if (conn.msgCount > RATE_LIMIT_MAX_MSGS) {
    if (conn.msgCount === RATE_LIMIT_MAX_MSGS + 1) {
      sendNotice(conn, 'Too many messages sent. Please slow down.', 'error');
    }
    if (conn.msgCount > RATE_LIMIT_MAX_MSGS * 2) {
      wsClose(conn, 1008, 'Rate limit exceeded');
    }
    return false;
  }
  return true;
}

function handleMessage(conn, msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;

  const ALLOWED_TYPES = new Set(['create', 'join', 'reconnect', 'input', 'rematch', 'ping']);
  if (!ALLOWED_TYPES.has(msg.type)) return;

  if (msg.type === 'ping') {
    wsSend(conn, { type: 'pong' });
    return;
  }

  if (msg.type === 'create') {
    if (rooms.size >= MAX_ROOMS) {
      sendNotice(conn, 'The server is currently full. Try again later.', 'error');
      return;
    }
    if (conn.player) {
      sendNotice(conn, 'This connection already belongs to a race.');
      return;
    }
    const code = generateCode();
    const player = {
      slot: 1,
      token: randomToken(),
      connection: conn,
      lane: 1,
      score: 0,
      coins: 0,
      active: true,
      disconnectedAt: null,
      expired: false,
      lastInputAt: 0,
      rematchRequested: false
    };
    const room = initRoom(code, player);
    rooms.set(code, room);
    conn.player = player;
    conn.room = room;
    sendSession(room, player);
    sendNotice(conn, `Room ${code} created. Share the code and wait for the other driver.`);
    sendState(room);
    return;
  }

  if (msg.type === 'join') {
    const rawCode = typeof msg.code === 'string' ? msg.code : '';
    const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code.length !== 6) {
      sendNotice(conn, 'Invalid room code format. Must be 6 characters.', 'error');
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      sendNotice(conn, 'Room not found. Ask the host to create a new room.', 'error');
      return;
    }
    if (room.status !== 'waiting' || room.players[1]) {
      sendNotice(conn, 'This room is already full or its race has already started.', 'error');
      return;
    }
    if (conn.player) {
      sendNotice(conn, 'This connection already belongs to a race.');
      return;
    }
    const p = addPlayer(room, 2, conn);
    room.lastActiveAt = Date.now();
    sendSession(room, p);
    sendNotice(conn, `Joined room ${code}. Waiting for the race to start.`);
    if (allConnected(room)) beginCountdown(room, 'new');
    sendState(room);
    return;
  }

  if (msg.type === 'reconnect') {
    const rawCode = typeof msg.code === 'string' ? msg.code : '';
    const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const token = typeof msg.token === 'string' ? msg.token : '';
    if (code.length !== 6 || !token || token.length > 64) {
      sendNotice(conn, 'Invalid reconnection parameters.', 'error');
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      sendNotice(conn, 'Room no longer exists. Create or join a new race.', 'error');
      return;
    }
    const p = room.players.find(x => x && x.token === token);
    if (!p) {
      sendNotice(conn, 'Invalid session token for this room.', 'error');
      return;
    }
    if (p.expired) {
      sendNotice(conn, 'The reconnect window for this session has expired.', 'error');
      return;
    }
    const now = Date.now();
    if (p.disconnectedAt && (now - p.disconnectedAt) > RECONNECT_GRACE_MS) {
      p.expired = true;
      p.active = false;
      sendNotice(conn, 'The 45-second reconnect window expired. Create or join a new race.', 'error');
      return;
    }
    if (conn.player && conn.player !== p) {
      sendNotice(conn, 'This connection already belongs to a race.');
      return;
    }
    // If the old socket is still alive (e.g. rapid page refresh), cleanly close old connection
    if (p.connection && p.connection !== conn) {
      const old = p.connection;
      old.player = null;
      old.room = null;
      wsClose(old, 4000, 'Replaced by new connection');
    }

    p.connection = conn;
    p.disconnectedAt = null;
    conn.player = p;
    conn.room = room;
    room.lastActiveAt = now;
    sendSession(room, p);
    sendNotice(conn, 'Reconnected to your race session.', 'success');

    if (room.status === 'reconnecting') {
      const unexpired = room.players.filter(x => x && !x.expired);
      if (unexpired.every(isConnected)) {
        beginCountdown(room, room.suspendedMode || 'resume');
      }
    } else if (room.status === 'waiting') {
      if (allConnected(room)) beginCountdown(room, 'new');
    }
    sendState(room);
    return;
  }

  const p = conn.player, room = conn.room;
  if (!p || !room || p.connection !== conn) {
    sendNotice(conn, 'Create or join a room first.', 'error');
    return;
  }
  room.lastActiveAt = Date.now();

  if (msg.type === 'input') {
    if (room.status !== 'racing' || !p.active) return;
    const direction = Number(msg.direction);
    if (direction !== -1 && direction !== 1) return;
    const now = Date.now();
    if (now - p.lastInputAt < 65) return;
    p.lastInputAt = now;
    p.lane = Math.max(0, Math.min(2, p.lane + direction));
    return;
  }

  if (msg.type === 'rematch') {
    if (room.status !== 'finished') {
      sendNotice(conn, 'Wait until both drivers have finished before starting a rematch.');
      return;
    }
    const unexpired = room.players.filter(x => x && !x.expired);
    if (!unexpired.every(isConnected)) {
      sendNotice(conn, 'Both drivers must be connected before requesting a rematch.');
      return;
    }
    p.rematchRequested = true;
    sendNotice(conn, 'Rematch requested. Waiting for the other driver.');
    if (unexpired.every(x => x.rematchRequested && isConnected(x))) {
      room.winner = null;
      beginCountdown(room, 'new');
    }
    sendState(room);
    return;
  }
}

function sendCarCrashMessage(p) {
  if (isConnected(p)) {
    wsSend(p.connection, {
      type: 'crash',
      score: Math.floor(p.score),
      coins: p.coins
    });
  }
}

function moveWorld(room, dt) {
  room.elapsed += dt;
  const worldSpeed = 420 + Math.min(380, room.elapsed * 4.5);
  room.roadOffset = (room.roadOffset + worldSpeed * dt) % 120;
  for (const p of room.players) {
    if (p && p.active) p.score += dt * (10 + Math.min(25, room.elapsed * 0.18));
  }

  room.spawnTimer -= dt;
  const spawnGap = Math.max(0.48, 1.05 - room.elapsed * 0.005);
  if (room.spawnTimer <= 0) {
    let lane = crypto.randomInt(0, 3);
    const atTop = room.traffic.filter(t => t.y < 125);
    if (atTop.some(t => t.lane === lane)) {
      lane = (lane + 1 + crypto.randomInt(0, 2)) % 3;
    }
    const truck = Math.random() < Math.min(0.18, 0.06 + room.elapsed * 0.0008);
    room.traffic.push({
      id: room.nextEntityId++,
      lane,
      y: -100,
      w: truck ? 72 : 60,
      h: truck ? 108 : 94,
      speed: (truck ? 205 : 235) + Math.random() * 30,
      color: COLORS[crypto.randomInt(0, COLORS.length)],
      truck,
      passed: false
    });
    room.spawnTimer = spawnGap * (0.78 + Math.random() * 0.5);
  }

  room.coinTimer -= dt;
  if (room.coinTimer <= 0) {
    let lane = crypto.randomInt(0, 3);
    const active = room.players.filter(p => p && p.active);
    if (active.length && Math.random() < 0.6) {
      lane = active[crypto.randomInt(0, active.length)].lane;
    }
    const count = Math.random() < 0.45 ? 3 : 1;
    for (let i = 0; i < count; i++) {
      room.pickups.push({
        id: room.nextEntityId++,
        lane,
        y: -45 - i * 43,
        r: 13,
        spin: Math.random() * 6,
        collectedBy: []
      });
    }
    room.coinTimer = 1.6 + Math.random() * 1.65;
  }

  for (const t of room.traffic) {
    t.y += (worldSpeed + t.speed * 0.23) * dt;
    if (!t.passed && t.y > CAR_Y + 50) {
      t.passed = true;
      for (const p of room.players) {
        if (p && p.active) p.score += 5;
      }
    }
    for (const p of room.players) {
      if (!p || !p.active || p.lane !== t.lane) continue;
      if (Math.abs(CAR_Y - t.y) < t.h * 0.5 + 34) {
        p.active = false;
        sendCarCrashMessage(p);
      }
    }
  }
  room.traffic = room.traffic.filter(t => t.y < 790);

  for (const c of room.pickups) {
    c.y += worldSpeed * dt;
    c.spin += dt * 6;
    if (!Array.isArray(c.collectedBy)) c.collectedBy = [];
    for (const p of room.players) {
      if (!p || !p.active || c.collectedBy.includes(p.slot) || p.lane !== c.lane || Math.abs(CAR_Y - c.y) >= 39) {
        continue;
      }
      c.collectedBy.push(p.slot);
      p.coins++;
      p.score += 75;
    }
  }
  room.pickups = room.pickups.filter(c => c.y < 690);

  if (room.players.every(p => !p || !p.active)) {
    room.status = 'finished';
    const p1 = room.players[0], p2 = room.players[1];
    if (p1 && p2) {
      room.winner = p1.score === p2.score ? 'tie' : (p1.score > p2.score ? 1 : 2);
    } else {
      room.winner = null;
    }
  }
}

function fixedTick() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.status === 'reconnecting') {
      for (const p of room.players) {
        if (p && !isConnected(p) && p.disconnectedAt && now - p.disconnectedAt > RECONNECT_GRACE_MS && !p.expired) {
          p.expired = true;
          p.active = false;
        }
      }
      const unexpired = room.players.filter(p => p && !p.expired);
      if (unexpired.length === 0) {
        room.status = 'finished';
      } else if (unexpired.every(isConnected)) {
        const someoneStillRacing = unexpired.some(p => p.active);
        if (someoneStillRacing) {
          beginCountdown(room, room.suspendedMode || 'resume');
        } else {
          room.status = 'finished';
        }
      }
    } else if (room.status === 'countdown' && now >= room.startAt) {
      const unexpired = room.players.filter(p => p && !p.expired);
      if (unexpired.every(isConnected)) {
        if (room.countdownMode === 'new') worldReset(room);
        room.status = 'racing';
        room.lastActiveAt = now;
      }
    } else if (room.status === 'racing') {
      moveWorld(room, TICK_MS / 1000);
    }

    // Room cleanup rules
    if (room.status === 'waiting' && now - room.createdAt > 90_000 && !room.players.some(isConnected)) {
      rooms.delete(code);
    } else if (room.status === 'finished' && now - room.lastActiveAt > ROOM_IDLE_MS && !room.players.some(isConnected)) {
      rooms.delete(code);
    } else if (room.status === 'reconnecting' && room.players.every(p => !p || p.expired) && now - room.lastActiveAt > 60_000 && !room.players.some(isConnected)) {
      rooms.delete(code);
    } else {
      sendState(room);
    }
  }
}

// Proactive ping interval to detect silent TCP drops and keep connections warm
const heartbeatInterval = setInterval(() => {
  for (const conn of activeConnections) {
    if (conn.closed || conn.socket.destroyed) {
      activeConnections.delete(conn);
      continue;
    }
    if (!conn.isAlive) {
      wsClose(conn, 1006, 'Ping timeout');
      activeConnections.delete(conn);
      handleDisconnect(conn);
      continue;
    }
    conn.isAlive = false;
    try { conn.socket.write(frame(9)); } catch (_) {}
  }
}, 15_000);
heartbeatInterval.unref();

httpServer.on('upgrade', (req, socket) => {
  const hostHeader = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${hostHeader}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // Cross-Site WebSocket Hijacking (CSWSH) Origin Protection
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS && origin) {
    const originLower = origin.toLowerCase();
    const isAllowed = ALLOWED_ORIGINS.includes('*') ||
                      ALLOWED_ORIGINS.includes(originLower) ||
                      ALLOWED_ORIGINS.some(o => originLower.startsWith(o));
    if (!isAllowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

  const conn = {
    socket,
    buffer: Buffer.alloc(0),
    fragments: [],
    fragmentOpcode: 0,
    closed: false,
    player: null,
    room: null,
    isAlive: true,
    rateWindowStart: Date.now(),
    msgCount: 0
  };

  activeConnections.add(conn);
  socket.setNoDelay(true);

  socket.on('data', chunk => {
    if (conn.closed) return;
    conn.isAlive = true;
    conn.buffer = Buffer.concat([conn.buffer, chunk]);

    while (conn.buffer.length >= 2) {
      const b0 = conn.buffer[0], b1 = conn.buffer[1];
      const fin = Boolean(b0 & 0x80), opcode = b0 & 0x0f, masked = Boolean(b1 & 0x80);
      let length = b1 & 0x7f, offset = 2;

      if (!masked) {
        wsClose(conn, 1002, 'Client frames must be masked');
        return;
      }

      if (length === 126) {
        if (conn.buffer.length < 4) return;
        length = conn.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (conn.buffer.length < 10) return;
        const wide = conn.buffer.readBigUInt64BE(2);
        if (wide > BigInt(MAX_MSG_SIZE)) {
          wsClose(conn, 1009, 'Message too large');
          return;
        }
        length = Number(wide);
        offset = 10;
      }

      if (length > MAX_MSG_SIZE) {
        wsClose(conn, 1009, 'Message too large');
        return;
      }

      if (conn.buffer.length < offset + 4 + length) return;

      const mask = conn.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(conn.buffer.subarray(offset, offset + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      conn.buffer = conn.buffer.subarray(offset + length);

      if (opcode === 8) {
        wsClose(conn, 1000, 'Closed by client');
        return;
      }
      if (opcode === 9) {
        conn.isAlive = true;
        try { socket.write(frame(10, payload)); } catch (_) {}
        continue;
      }
      if (opcode === 10) {
        conn.isAlive = true;
        continue;
      }
      if (opcode === 0) {
        if (!conn.fragmentOpcode) {
          wsClose(conn, 1002, 'Unexpected continuation');
          return;
        }
        conn.fragments.push(payload);
        const totalLen = conn.fragments.reduce((sum, b) => sum + b.length, 0);
        if (totalLen > MAX_MSG_SIZE) {
          wsClose(conn, 1009, 'Message too large');
          return;
        }
        if (fin) {
          const combined = Buffer.concat(conn.fragments);
          const finalOpcode = conn.fragmentOpcode;
          conn.fragments = [];
          conn.fragmentOpcode = 0;
          if (finalOpcode === 1) parseClientMessage(conn, combined);
        }
      } else if (opcode === 1) {
        if (!fin) {
          conn.fragmentOpcode = 1;
          conn.fragments = [payload];
        } else {
          parseClientMessage(conn, payload);
        }
      } else {
        wsClose(conn, 1003, 'Unsupported frame type');
        return;
      }
    }
  });

  const cleanupConn = () => {
    if (!conn.closed) conn.closed = true;
    activeConnections.delete(conn);
    handleDisconnect(conn);
  };

  socket.on('close', cleanupConn);
  socket.on('error', cleanupConn);
});

function parseClientMessage(conn, payload) {
  if (!checkRateLimit(conn)) return;
  try {
    const msg = JSON.parse(payload.toString('utf8'));
    handleMessage(conn, msg);
  } catch (_) {
    sendNotice(conn, 'Invalid message format. Refresh the game and try again.', 'error');
  }
}

const tickInterval = setInterval(fixedTick, TICK_MS);
tickInterval.unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`Lane Rush authoritative server listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/ws`);
});

function shutdown() {
  clearInterval(tickInterval);
  clearInterval(heartbeatInterval);
  for (const conn of activeConnections) {
    wsClose(conn, 1001, 'Server shutting down');
  }
  for (const room of rooms.values()) {
    for (const p of room.players) {
      if (p && isConnected(p)) wsClose(p.connection, 1001, 'Server shutting down');
    }
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
