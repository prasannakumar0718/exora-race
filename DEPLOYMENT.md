# Lane Rush — Production Deployment Guide

This guide covers deploying the **Lane Rush authoritative multiplayer server** to public cloud hosting so two or more physical devices (phones, laptops, tablets) can race against each other over the public internet.

---

## 1. Architecture & Protocol Overview

- **Server Role:** Authoritative Node.js game server owning world simulation, traffic spawning, coin distribution, scoring, collision detection, and synchronized rematches.
- **Protocols:**
  - `HTTP / HTTPS`: Serves the game client HTML (`/`) and health check (`/health`).
  - `WebSocket (WS / WSS)`: Real-time 20 Hz bidirectional race state synchronization (`/ws`).
- **Dynamic Protocol Negotiation in Browser:**
  When hosted online over HTTPS (e.g., `https://lanerush.onrender.com`), the client browser automatically connects via secure WebSocket `wss://lanerush.onrender.com/ws`.
  If accessed locally over HTTP, it automatically connects via `ws://localhost:8080/ws`.
  If opening the game from a separate domain or `file://`, supply the query parameter:
  `?server=wss://your-hosted-server.example.com/ws`

---

## 2. Environment Variables

The server reads standard environment variables with sensible defaults:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port for HTTP & WebSocket server. Set automatically by Render, Railway, Fly, Heroku. |
| `HOST` | `0.0.0.0` | Bind address. `0.0.0.0` binds all container/public network interfaces. |
| `ALLOWED_ORIGINS` | `""` (permissive) | Optional comma-separated origins (e.g. `https://mygame.com`). Leave empty for automatic local/same-origin. |
| `MAX_ROOMS` | `500` | Maximum concurrent rooms kept in server memory. |
| `RECONNECT_GRACE_MS`| `45000` | Reconnection window before disconnected driver is marked out (45 seconds). |
| `TICK_MS` | `50` | Server simulation tick duration in milliseconds (50 ms = 20 Hz updates). |

---

## 3. Recommended Hosting Providers & Free-Tier Reality

### A. Render (Recommended for Simplicity)
- **Support:** Native Node.js web services with persistent WebSockets.
- **Free Tier Behavior:**
  - Render free tier instances **spin down (sleep) after 15 minutes of inactivity**.
  - When sleeping, the first incoming HTTP request takes ~50 seconds to cold start.
  - While an active WebSocket connection is open, the service remains awake.
  - **For commercial / reliable production use:** The **Starter plan ($7/mo)** prevents sleeping and provides uninterrupted persistent multiplayer operation.
- **Deployment via Git:**
  1. Push this repository to GitHub or GitLab.
  2. In Render Dashboard, click **New +** -> **Web Service**.
  3. Select your repository.
  4. Build Command: Leave blank (zero native dependencies required).
  5. Start Command: `npm start`
  6. Health Check Path: `/health`
  7. Click **Create Web Service**.

### B. Railway (Recommended for Performance)
- **Support:** Persistent containers, zero cold starts, automatic HTTPS/WSS proxy.
- **Free Tier Behavior:**
  - $5 free monthly credit. Instances do **not** sleep while active credit exists.
- **Deployment via CLI or Dashboard:**
  ```bash
  npm i -g @railway/cli
  railway login
  railway init
  railway up
  ```
  Set custom domain or generate a Railway domain in the project settings.

### C. Fly.io (Low-Latency Global Edge)
- **Support:** Global Docker containers with persistent WebSockets.
- **Deployment:**
  ```bash
  fly launch
  fly deploy
  ```
  Fly automatically detects the `Dockerfile` and binds port 8080 with automated TLS certificates.

### D. Self-Hosted VPS / Docker (Ubuntu / Debian / DigitalOcean)
```bash
# Clone and build container
docker build -t lane-rush:latest .

# Run on public port 80 or 8080
docker run -d --name lane-rush -p 8080:8080 --restart unless-stopped lane-rush:latest
```

---

## 4. Verifying Server Health

Once deployed, visit your health endpoint in any browser or terminal:

```bash
curl -i https://<your-service-url>/health
```

Expected HTTP `200 OK` JSON response:
```json
{
  "ok": true,
  "service": "lane-rush",
  "rooms": 0,
  "connections": 0,
  "tickHz": 20,
  "reconnectGraceMs": 45000,
  "uptimeSeconds": 142,
  "timestamp": 1776100000000
}
```

---

## 5. Live Two-Device Testing Procedure (Public Internet)

To verify real online multiplayer across two distinct devices (e.g. your computer and your mobile phone):

1. **Open the game URL** on Device 1 (Computer):
   `https://<your-service-url>`
2. Click **Create online race**.
3. The server generates a unique **6-character room code** (e.g. `K7X9Q2`).
4. On Device 2 (Mobile phone, over 4G/5G or separate Wi-Fi):
   Open `https://<your-service-url>`.
5. Enter the 6-character room code into the **ROOM CODE** input box and tap **Join**.
6. **Verify Synchronized Countdown:** Both devices display the countdown ("Race starts in 3…") simultaneously.
7. **Verify Shared World:** Both drivers observe the exact same traffic obstacles and coins passing by.
8. **Verify Disconnection & Reconnection:**
   - Turn off Wi-Fi on Device 2 or refresh the browser tab.
   - Device 1 immediately sees the race freeze with the message: *"A driver lost connection. The server has frozen the shared race while reconnect is available (45s remaining)."*
   - Turn Wi-Fi back on or reload the tab on Device 2: the session token stored in `localStorage` automatically resumes the race slot with the full score intact.
9. **Verify Game Over & Rematch:**
   - When both players crash, both screens show the final score, coins, and winner.
   - Both tap **Request rematch** -> countdown starts synchronously for a fresh race.
