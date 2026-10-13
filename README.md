# Exora Race — Server-Authoritative Online Multiplayer Driver

Exora Race is a fast, responsive browser arcade driving game featuring solo endless mode and synchronized, server-authoritative online multiplayer races.

---

## Features

- **Authoritative Server Physics & Simulation:** The Node.js server controls world speed progression, obstacle spawning, coin positions, lane changes, collision detection, and winner calculation.
- **Cheat-Resistant Architecture:** Clients cannot alter their own score, manipulate positions, or spoof coin pickups. Client actions are strictly validated and clamped.
- **Client Prediction & Visual Smoothing:** Immediate steering feedback on local client with server reconciliation. Smooth interpolation for rival cars and road progression.
- **Session-Resilient Reconnection:** 45-second reconnection grace period secured by crypto session tokens (`localStorage`). Accidental tab closures or page refreshes reconnect instantly without losing race position or score.
- **Clear Connection States:** Real-time badge indicators for `Connecting`, `Connected`, `Reconnecting`, `Connection Lost`, and `Race Finished`.
- **Harden for Public Release:** Frame-level payload size limits (4 KB max), rate-limiting flood protection (35 msgs/s), CSWSH origin verification, proactive ping/pong heartbeats, and graceful process shutdown.
- **Solo Endless Play:** Full local single-player experience with high-score tracking and instant restarts.
- **Fully Responsive & Touch Ready:** Optimized for desktop (keyboard arrows / A & D) and mobile devices (touch screen buttons & swipe gestures).

---

## Quick Start (Local Development)

### Prerequisites
- Node.js 20 or newer
- Any modern desktop or mobile browser (Chrome, Edge, Safari, Firefox)

### 1. Installation
```bash
npm install
```
*(Dependencies are minimal: pure Node.js core modules for the server and `playwright-core` for end-to-end browser testing).*

### 2. Start the Game Server
```bash
npm start
```
By default, the server listens at <http://localhost:8080> and WebSocket endpoint `ws://localhost:8080/ws`.

### 3. Play Locally or with Two Browser Windows
1. Open <http://localhost:8080> in your first browser window.
2. Click **Create online race** to generate a 6-character room code (e.g., `AB12CD`).
3. Open <http://localhost:8080> in a second browser window, tab, or incognito profile.
4. Enter the room code and click **Join**.
5. Both screens will countdown in sync and race in the exact same world!

---

## Controls

| Action | Desktop Keys | Mobile / Touch |
|---|---|---|
| **Steer Left** | `←` Left Arrow or `A` | Left `‹` button or swipe left |
| **Steer Right** | `→` Right Arrow or `D` | Right `›` button or swipe right |
| **Pause / Resume** | `P` or `Escape` | Pause icon button (solo mode) |
| **Quick Restart** | `Enter` | Tap restart button |

---

## Automated Test Suites

Lane Rush includes two automated test suites with zero placeholder mocks:

### 1. Integration & Security Suite
Runs 14 automated assertions verifying room codes, steering validation, temporary disconnect freeze, rapid session takeover, rate limits, multi-room isolation, and collision outcomes:
```bash
npm test
```

### 2. Playwright End-to-End Browser UI Suite
Launches two independent browser contexts in real headless Chromium to verify start UI, touch controls, synchronized race countdown, multi-client steering, browser reload session recovery, and crash/rematch workflows:
```bash
npm run test:browser
```

### 3. Run All Tests & Syntax Checks
```bash
npm run check
npm run test:all
```

---

## Production Deployment

Lane Rush is ready for 1-click or automated deployment on platforms that support persistent Node.js and WebSockets:

- **Render:** Configuration blueprint available in `render.yaml`. Use `npm start` as start command.
- **Railway / Fly.io / Docker:** Production multi-stage `Dockerfile` included. Run `docker build -t lane-rush . && docker run -p 8080:8080 lane-rush`.
- **Health Check Endpoint:** `GET /health` provides uptime, active room counts, and tick frequency.

See [DEPLOYMENT.md](file:///e:/lane-rush/DEPLOYMENT.md) for detailed platform walkthroughs, free-tier limitations (Render spin-down vs. persistent instances), and live two-device testing instructions.

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Server listening port |
| `HOST` | `0.0.0.0` | Bind address for container/cloud platforms |
| `ALLOWED_ORIGINS` | `""` | Comma-separated allowed WebSocket origins |
| `MAX_ROOMS` | `500` | Maximum concurrent active rooms in memory |
| `RECONNECT_GRACE_MS`| `45000` | Reconnection grace window (45 seconds) |
| `TICK_MS` | `50` | Server simulation tick rate (50ms = 20 Hz) |
