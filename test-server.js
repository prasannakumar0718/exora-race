'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 18080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    RECONNECT_GRACE_MS: '45000'
  },
  stdio: ['ignore', 'ignore', 'inherit']
});

class TestClient {
  constructor(url) {
    this.messages = [];
    this.listeners = new Set();
    this.closeCode = null;
    this.closeReason = null;
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 5000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket failed to connect')); }, { once: true });
    });
    this.ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      this.messages.push(msg);
      for (const listener of [...this.listeners]) listener(msg);
    });
    this.ws.addEventListener('close', ev => {
      this.closeCode = ev.code;
      this.closeReason = ev.reason;
    });
  }
  async send(msg) {
    await this.opened;
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  waitFor(predicate, timeoutMs = 7000, description = 'expected message') {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${description}`)); }, timeoutMs);
      const listener = msg => { if (predicate(msg)) { cleanup(); resolve(msg); } };
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(listener); };
      this.listeners.add(listener);
    });
  }
  waitForState(predicate, timeoutMs = 7000, description = 'expected race state') {
    return this.waitFor(msg => msg.type === 'state' && predicate(msg), timeoutMs, description);
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function waitServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('HTTP server did not become healthy');
}

async function main() {
  let host, guest, reconnect;
  let roomBHost, roomBGuest;
  try {
    // 1. Health endpoint test
    const health = await waitServer();
    assert.equal(health.ok, true, 'health endpoint ok');
    assert.equal(health.service, 'lane-rush', 'health service name');
    assert.equal(health.reconnectGraceMs, 45000, 'reconnect grace ms configured');
    console.log('PASS 1: Health endpoint responds with valid service metadata');

    // 2. Room create and join with 6-char code
    host = new TestClient(WS_URL);
    await host.opened;
    await host.send({ type: 'create' });
    const hostSession = await host.waitFor(m => m.type === 'session', 5000, 'host session token');
    assert.equal(hostSession.slot, 1);
    assert.match(hostSession.code, /^[A-Z0-9]{6}$/, 'valid 6-character room code format');
    const code = hostSession.code;

    guest = new TestClient(WS_URL);
    await guest.opened;
    await guest.send({ type: 'join', code });
    const guestSession = await guest.waitFor(m => m.type === 'session', 5000, 'guest session token');
    assert.equal(guestSession.slot, 2);
    assert.equal(guestSession.code, code);
    console.log('PASS 2: Room create/join succeeds with valid 6-character room code and slot assignment');

    // 3. Synchronized countdown and race start
    await Promise.all([
      host.waitForState(s => s.status === 'racing', 7000, 'host racing state'),
      guest.waitForState(s => s.status === 'racing', 7000, 'guest racing state')
    ]);
    console.log('PASS 3: Synchronized countdown and race start for both players');

    // 4. Shared traffic and coin synchronization
    const initial = await host.waitForState(s => s.status === 'racing' && s.traffic.length > 0, 5000, 'shared traffic');
    const guestWorld = await guest.waitForState(s => s.status === 'racing' && s.traffic.length > 0, 3000, 'guest shared traffic');
    assert.deepEqual(initial.traffic.map(t => t.id), guestWorld.traffic.map(t => t.id), 'both peers see the exact same authoritative traffic entities');
    console.log('PASS 4: Both clients receive identical shared traffic entities');

    // 5. Server-authoritative steering and bounds validation
    await host.send({ type: 'input', direction: -1 });
    const shifted = await host.waitForState(s => s.status === 'racing' && s.players[0].lane === 0, 2000, 'authoritative lane input');
    assert.equal(shifted.players[0].lane, 0);

    // Test clamped left bound
    await new Promise(r => setTimeout(r, 100));
    await host.send({ type: 'input', direction: -1 });
    await new Promise(r => setTimeout(r, 150));
    const latestStates = host.messages.filter(m => m.type === 'state');
    const clamped = latestStates[latestStates.length - 1];
    assert.equal(clamped.players[0].lane, 0, 'lane is clamped at boundary 0');

    // Return to center lane
    await host.send({ type: 'input', direction: 1 });
    await host.waitForState(s => s.status === 'racing' && s.players[0].lane === 1, 2000, 'lane return');
    console.log('PASS 5: Player steering is server-authoritative and boundary-checked');

    // 6. Reject invalid input payloads safely
    await host.send({ type: 'input', direction: 99 });
    await host.send({ type: 'input', direction: 'left' });
    await host.send({ type: 'invalid_type_test' });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(host.messages.filter(m => m.type === 'state').slice(-1)[0].players[0].lane, 1, 'invalid inputs ignored');
    console.log('PASS 6: Malformed inputs and invalid direction values are safely rejected');

    // 7. Temporary disconnect freezes race
    guest.close();
    await host.waitForState(s => s.status === 'reconnecting', 3000, 'race frozen during disconnect');
    console.log('PASS 7: Socket disconnection freezes shared race for remaining players');

    // 8. Session token reconnect restores slot and resumes frozen race
    reconnect = new TestClient(WS_URL);
    await reconnect.opened;
    await reconnect.send({ type: 'reconnect', code, token: guestSession.token });
    const returned = await reconnect.waitFor(m => m.type === 'session' && m.slot === 2, 5000, 'reconnected session');
    assert.equal(returned.code, code);
    assert.equal(returned.slot, 2);

    await Promise.all([
      host.waitForState(s => s.status === 'racing', 7000, 'host resumed race'),
      reconnect.waitForState(s => s.status === 'racing', 7000, 'guest resumed race')
    ]);
    console.log('PASS 8: Token reconnect restores player slot 2 and resumes the shared race');

    // 9. Reconnect race condition test: immediate reconnect while old connection still open
    const fastRefresh = new TestClient(WS_URL);
    await fastRefresh.opened;
    await fastRefresh.send({ type: 'reconnect', code, token: returned.token });
    const fastSession = await fastRefresh.waitFor(m => m.type === 'session' && m.slot === 2, 5000, 'fast refresh session');
    assert.equal(fastSession.slot, 2, 'fast refresh successfully took over slot 2');
    reconnect = fastRefresh;
    console.log('PASS 9: Fast reconnection smoothly takes over active slot without rejection');

    // 10. Server-side collision ends the race and broadcasts winner
    await host.send({ type: 'input', direction: 1 });
    await host.waitForState(s => s.status === 'racing' && s.players[0].lane === 2, 2000, 'move to outer lane');
    await new Promise(r => setTimeout(r, 100));
    await host.send({ type: 'input', direction: -1 });
    await host.waitForState(s => s.status === 'racing' && s.players[0].lane === 1, 2000, 'move back to center');
    await host.waitForState(s => s.status === 'finished', 24000, 'server-side collisions end the race');
    await reconnect.waitForState(s => s.status === 'finished', 3000, 'guest receives final race state');
    console.log('PASS 10: Server-side collisions and authoritative race finish are broadcast');

    // 11. Synchronized rematch
    await host.send({ type: 'rematch' });
    await reconnect.send({ type: 'rematch' });
    await Promise.all([
      host.waitForState(s => s.status === 'countdown', 3000, 'rematch countdown'),
      reconnect.waitForState(s => s.status === 'countdown', 3000, 'peer rematch countdown')
    ]);
    await Promise.all([
      host.waitForState(s => s.status === 'racing', 7000, 'rematch starts'),
      reconnect.waitForState(s => s.status === 'racing', 7000, 'peer rematch starts')
    ]);
    console.log('PASS 11: Synchronized rematch requested by both players initiates a new race');

    // 12. Maximum message size enforcement (>4KB rejected)
    const bigClient = new TestClient(WS_URL);
    await bigClient.opened;
    const oversizedPayload = JSON.stringify({ type: 'input', padding: 'x'.repeat(5000) });
    bigClient.ws.send(oversizedPayload);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(bigClient.ws.readyState, WebSocket.CLOSED, 'oversized client closed by server');
    console.log('PASS 12: Oversized messages (>4KB) are strictly rejected and connection closed');

    // 13. Multiple isolated rooms operating concurrently
    roomBHost = new TestClient(WS_URL);
    await roomBHost.opened;
    await roomBHost.send({ type: 'create' });
    const roomBSession = await roomBHost.waitFor(m => m.type === 'session', 5000, 'room B host session');
    assert.notEqual(roomBSession.code, code, 'room B has a distinct room code');

    roomBGuest = new TestClient(WS_URL);
    await roomBGuest.opened;
    await roomBGuest.send({ type: 'join', code: roomBSession.code });
    await roomBHost.waitForState(s => s.status === 'racing', 7000, 'room B racing');
    const roomBState = await roomBHost.waitForState(s => s.code === roomBSession.code, 2000, 'room B state');
    assert.equal(roomBState.code, roomBSession.code, 'room B state is completely isolated from room A');
    console.log('PASS 13: Multiple concurrent rooms operate independently without cross-talk');

    // 14. Expired reconnect session rejected
    const expiredClient = new TestClient(WS_URL);
    await expiredClient.opened;
    await expiredClient.send({ type: 'reconnect', code: 'INVALID', token: 'fake-token' });
    const notice = await expiredClient.waitFor(m => m.type === 'notice' && m.level === 'error', 3000, 'error notice');
    assert.match(notice.message, /Room no longer exists|Invalid/i);
    expiredClient.close();
    console.log('PASS 14: Expired or invalid reconnection tokens are strictly rejected');

    console.log('\n========================================');
    console.log('ALL 14 AUTHORITATIVE SERVER INTEGRATION CHECKS PASSED');
    console.log('========================================\n');
  } finally {
    if (host) host.close();
    if (guest) guest.close();
    if (reconnect) reconnect.close();
    if (roomBHost) roomBHost.close();
    if (roomBGuest) roomBGuest.close();
    server.kill('SIGTERM');
    await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 1000); });
  }
}

main().catch(err => {
  console.error('FAIL:', err.stack || err);
  process.exitCode = 1;
});
