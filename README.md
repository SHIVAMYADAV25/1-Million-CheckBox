# 1 Million Checkboxes

> A real-time collaborative grid of 1,000,000 checkboxes. Toggle any checkbox and every connected user sees it change — instantly.

**Live demo:** _[your deployed URL]_  
**Demo video:** https://youtu.be/JmngM9ame6s

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Features](#3-features)
4. [Architecture Deep Dive](#4-architecture-deep-dive)
   - 4.1 [System Architecture Diagram](#41-system-architecture-diagram)
   - 4.2 [How 1 Million Checkboxes Are Stored](#42-how-1-million-checkboxes-are-stored)
   - 4.3 [WebSocket Flow](#43-websocket-flow)
   - 4.4 [Redis Pub/Sub — Multi-Server Scaling](#44-redis-pubsub--multi-server-scaling)
   - 4.5 [Custom Rate Limiting](#45-custom-rate-limiting)
   - 4.6 [Authentication Flow (OIDC/OAuth 2.0)](#46-authentication-flow-oidcoauth-20)
   - 4.7 [Frontend Rendering Strategy](#47-frontend-rendering-strategy)
5. [How to Run Locally](#5-how-to-run-locally)
6. [Environment Variables](#6-environment-variables)
7. [Redis Setup](#7-redis-setup)
8. [Project Structure](#8-project-structure)
9. [Design Decisions & Trade-offs](#9-design-decisions--trade-offs)
10. [Screenshots](#10-screenshots)

---

## 1. Project Overview

This is a real-time web application built for the Web Dev Cohort 2026 hackathon. The premise is simple: 1,000,000 checkboxes on a shared canvas. Anyone who visits can see them all. Authenticated users can toggle any checkbox. The change propagates to every connected user in milliseconds.

The interesting part is not the checkboxes — it is the engineering required to make this work at scale:

- Storing a million state values in under 200 KB
- Rendering a million items without crashing the browser
- Synchronising state across multiple users in real time
- Handling horizontal server scaling without duplicating broadcasts
- Preventing abuse with custom rate limiting

---

## 2. Tech Stack

| Layer           | Technology                       | Why                                               |
|-----------------|----------------------------------|---------------------------------------------------|
| Frontend        | HTML + CSS + Vanilla JS          | No framework overhead; canvas for performance     |
| HTTP Server     | Node.js + Express                | Lightweight, excellent ecosystem                  |
| Real-time       | Socket.IO (WebSockets)           | Handles reconnection, rooms, fallbacks            |
| State Storage   | Redis (bitmask via SETBIT)       | 125 KB for 1M booleans; atomic; sub-millisecond   |
| Pub/Sub         | Redis Pub/Sub                    | Broadcasts across multiple server instances       |
| Auth            | OIDC / OAuth 2.0 via @oaauth/sdk | Standardised; handles token lifecycle             |
| Rate Limiting   | Custom (Redis counters)          | No external packages; works across server instances|

---

## 3. Features

- **1,000,000 checkbox grid** rendered via canvas (not DOM nodes)
- **Real-time sync** — toggle a checkbox and all connected users see it instantly
- **Bitmask storage** — 1M checkboxes stored in 125 KB in Redis (not 8 MB)
- **Redis Pub/Sub** — broadcasts work correctly across multiple server processes
- **OIDC / OAuth 2.0 authentication** — sign in to interact; anonymous = read-only
- **Custom rate limiting** — per-socket sliding window counter in Redis (no packages)
- **Virtual scrolling** — only renders visible cells; handles millions of rows
- **Zoom levels** — from 6 px to 30 px cells
- **Jump to checkbox** — enter any number 1–1,000,000 to scroll there
- **Live stats** — checked count, total, connected users, progress bar
- **Optimistic UI** — click feels instant; server confirms/rejects asynchronously
- **Responsive** — works on mobile and desktop
- **Clean editorial UI** — warm cream + sienna palette, Playfair Display + DM Mono fonts

---

## 4. Architecture Deep Dive

### 4.1 System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT BROWSER                          │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Canvas Grid (virtual scroll, draws only visible rows)   │  │
│  │  app.js: Uint8Array bitmask state, hit-test, redraw RAF  │  │
│  └────────────────────────┬─────────────────────────────────┘  │
│           HTTP GET         │         WebSocket (Socket.IO)      │
│      /api/checkboxes       │    client:checkbox:change          │
│      /api/stats            │    server:checkbox:change          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                   ┌────────▼────────┐
                   │   LOAD BALANCER │  (e.g. Nginx / Railway)
                   └────────┬────────┘
              ┌─────────────┼──────────────┐
              │             │              │
     ┌────────▼───┐ ┌───────▼────┐ ┌──────▼──────┐
     │  Server 1  │ │  Server 2  │ │  Server N   │
     │  Express   │ │  Express   │ │  Express    │
     │  Socket.IO │ │  Socket.IO │ │  Socket.IO  │
     └────────┬───┘ └───────┬────┘ └──────┬──────┘
              │  PUBLISH     │  SUBSCRIBE   │
              └──────────────┼──────────────┘
                             │
              ┌──────────────▼──────────────────────┐
              │               REDIS                  │
              │                                      │
              │  checkbox:bits  (bitmask, 125 KB)    │
              │  SETBIT / GETBIT / BITCOUNT          │
              │                                      │
              │  Pub/Sub Channel:                    │
              │  internal:checkbox:change            │
              │                                      │
              │  Rate limit keys:                    │
              │  rate:socket:{id}  → counter + TTL   │
              │  rate:http:{ip}    → counter + TTL   │
              └──────────────────────────────────────┘
                             │
              ┌──────────────▼──────────────────────┐
              │           AUTH SERVER                │
              │  OIDC Provider via @oaauth/sdk       │
              │  /auth/login → /auth/callback        │
              │  Access token (short-lived JWT)      │
              │  Refresh token (httpOnly cookie)     │
              └──────────────────────────────────────┘
```

---

### 4.2 How 1 Million Checkboxes Are Stored

**The problem:** 1,000,000 boolean values need to be stored and retrieved efficiently.

**Naïve approach:** `JSON.stringify(array)` → ~8–12 MB string. Too large to load on every page visit. Too slow to update per-checkbox.

**Our approach: Redis Bitmask**

Redis strings can store arbitrary binary data. The `SETBIT` / `GETBIT` / `BITCOUNT` commands treat the string as a packed bitmask.

```
1 checkbox  = 1 bit
1,000,000 checkboxes = 1,000,000 bits = 125,000 bytes = ~122 KB
Base64 encoded for JSON transport ≈ 167 KB
```

This is a **50–70× reduction** over a JSON boolean array.

**SETBIT key offset 0/1** — atomically flips one bit. No locks needed. O(1).  
**GETRANGE key 0 N** — fetches a byte range in one round trip. O(N).  
**BITCOUNT key** — counts all set bits in O(N) — used for the stats counter.

When the server receives a toggle event from a socket:
```js
await redis.setbit("checkbox:bits", index, checked ? 1 : 0);
```

When the client loads the page:
```js
const buf = await redis.getrangeBuffer("checkbox:bits", 0, 124999);
// → Buffer of 125,000 bytes (the entire 1M bitmask)
```

The client decodes bits:
```js
const isChecked = (buf[Math.floor(index / 8)] >> (7 - (index % 8))) & 1;
```

---

### 4.3 WebSocket Flow

```
USER CLICKS CHECKBOX #500000
         │
         ▼
app.js: setBit(localBits, 500000, true)   ← Optimistic update (instant feel)
app.js: drawCell(500000)                  ← Redraw just that cell
         │
         ▼
socket.emit("client:checkbox:change", { index: 500000, checked: true })
         │
         ▼ (WebSocket → Server)
         │
src/index.js: socket.on("client:checkbox:change")
  ├── socketRateLimit(socket.id, redis)     ← Check rate limit
  ├── Validate payload (index bounds, type)
  ├── redis.setbit("checkbox:bits", 500000, 1)   ← Persist to Redis
  └── publisher.publish("internal:checkbox:change", JSON.stringify({index, checked}))
         │
         ▼ (Redis Pub/Sub)
         │
subscriber.on("message")  ← Fires on every server instance
  └── io.emit("server:checkbox:change", { index: 500000, checked: true })
         │
         ▼ (WebSocket → All clients)
         │
app.js: socket.on("server:checkbox:change")
  ├── setBit(localBits, 500000, true)
  ├── state.pendingDraw.add(500000)
  └── scheduleRedraw() → requestAnimationFrame(flushDraw)
```

**Why not broadcast directly from the socket handler?**  
If `io.emit()` were called inside the socket handler (before publishing to Redis), only clients connected to *that specific server instance* would receive the update. By routing through Redis Pub/Sub, all server instances receive the message and broadcast to their own connected clients. This is what enables horizontal scaling.

---

### 4.4 Redis Pub/Sub — Multi-Server Scaling

Without Redis Pub/Sub, a checkbox toggled on Server 1 would only be seen by users connected to Server 1. Users on Server 2 and 3 would see stale state.

**The fix: one shared broadcast channel**

```
Server 1 receives toggle → PUBLISH to Redis channel
                                    ↓
                    Redis delivers message to ALL subscribers
                                    ↓
         Server 1 SUB   Server 2 SUB   Server 3 SUB
              ↓              ↓              ↓
         broadcasts     broadcasts     broadcasts
         to own         to own         to own
         Socket.IO      Socket.IO      Socket.IO
         clients        clients        clients
```

Three separate Redis client connections are needed:
- `redis` — general commands (SETBIT, GETRANGE, rate limit counters)
- `publisher` — `PUBLISH` to the channel
- `subscriber` — `SUBSCRIBE` to the channel

Once a Redis client calls `SUBSCRIBE`, it enters a special mode and cannot run other commands. This is a Redis protocol constraint, not a library limitation — hence three separate connections.

---

### 4.5 Custom Rate Limiting

**No external packages.** The limiter is built from scratch using Redis counters and TTLs.

**Strategy: Sliding Window Counter**

For each socket (or IP for HTTP), we maintain a Redis key:
```
rate:socket:{socketId}   → integer counter
rate:http:{clientIp}     → integer counter
```

On each event:
1. `INCR rate:socket:{id}` → atomically increments and returns new value
2. If `count === 1` → first event in this window; `EXPIRE key 10` sets a 10-second TTL
3. If `count > 15` → reject the event; emit `server:error` to the socket

After 10 seconds, the key expires and the counter resets. The user gets a fresh 15-event window.

**Why Redis counters instead of an in-memory Map?**  
An in-memory Map is per-process. With 3 server instances, each would have its own Map. A user could send 15 events to Server 1 and another 15 to Server 2, bypassing the limit. Redis is shared globally across all instances.

**Socket vs HTTP limiting:**

| Limiter | Key | Max Events | Window |
|---------|-----|-----------|--------|
| Socket  | `rate:socket:{socketId}` | 15 | 10s |
| HTTP    | `rate:http:{ip}` | 30 | 10s |

HTTP limit is higher because page loads (fetching `/api/checkboxes`) are legitimate high-frequency events.

**Fail-open policy:** If Redis is unavailable, the rate limiter allows the request rather than blocking all users. The error is logged for visibility.

---

### 4.6 Authentication Flow (OIDC/OAuth 2.0)

```
User clicks "Sign in"
       │
       ▼
GET /auth/login
  └── SDK redirects to Identity Provider (IdP) login page
       │
       ▼ (User authenticates at IdP)
       │
IdP redirects to: GET /auth/callback?code=xxx
  ├── SDK exchanges code for tokens (Authorization Code flow)
  ├── accessToken  → short-lived JWT (minutes)
  ├── refreshToken → long-lived (days), stored in httpOnly cookie
  └── Redirect to /?token={accessToken}
       │
       ▼
app.js detects ?token= in URL
  ├── Stores accessToken in JS memory (NOT localStorage — XSS risk)
  ├── Removes token from URL (history.replaceState)
  ├── Reconnects Socket.IO with auth: { token }
  └── Fetches /auth/me to confirm identity
       │
       ▼
Socket.IO handshake
  └── verifySocketToken middleware validates JWT
      ├── Valid → socket.data.isAuthenticated = true
      └── Invalid/missing → anonymous (read-only)
```

**Why not store the access token in localStorage?**  
localStorage is readable by any JavaScript on the page, including injected scripts via XSS vulnerabilities. Keeping the token in memory (a JS variable) means it is cleared on page refresh and inaccessible to third-party scripts.

**Why httpOnly for the refresh token?**  
The refresh token is long-lived and valuable. Setting it as `httpOnly; SameSite=Lax` means it cannot be accessed by JavaScript at all — only sent automatically by the browser on same-origin requests to `/auth/refresh`.

**Anonymous users:**  
They can connect via WebSocket and see real-time updates (broadcasts reach all clients), but the server rejects their `client:checkbox:change` events. The frontend shows a banner prompting them to sign in.

---

### 4.7 Frontend Rendering Strategy

**Problem:** 1,000,000 `<input type="checkbox">` DOM nodes would consume several GB of memory and render in minutes.

**Solution: Canvas + Virtual Scrolling**

Instead of DOM nodes we:
1. Draw a `<canvas>` the size of the viewport
2. Listen for scroll events and redraw only the visible rows
3. Handle clicks by converting mouse coordinates back to checkbox indices

```
viewport height = 800px, cell size = 16px
→ visible rows = ceil(800/16) = 50 rows
→ at 80 cols per row: 50 × 80 = 4,000 cells drawn at a time
→ out of 1,000,000 — that is 0.4%
```

**requestAnimationFrame batching:**  
When multiple socket events arrive in rapid succession (e.g. another user quickly toggling many boxes), we accumulate dirty indices in a `Set` and flush them in one `requestAnimationFrame` call. This prevents 100 redraws per second and keeps everything smooth at 60 fps.

**Bitmask in the browser:**  
The server returns a base64 string. The client decodes it to a `Uint8Array` (125,000 bytes). Reading and writing individual bits is O(1) and requires no heap allocations. Total memory for the state: ~125 KB — negligible.

**Optimistic UI:**  
When a user clicks a checkbox, the local bit is flipped and the cell is redrawn before the server responds. The latency feels like zero. If the server rejects the action (rate limit), the canvas is redrawn from the server's true state on the next broadcast.

---

## 5. How to Run Locally

### Prerequisites
- Node.js 18+
- Redis running locally (`redis-server`) or a managed instance

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/your-username/1-million-checkboxes.git
cd 1-million-checkboxes

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env with your values (see Environment Variables section)

# 4. Start Redis (if running locally)
redis-server

# 5. Start the server
npm run dev       # development (auto-restart on file changes)
# or
npm start         # production

# 6. Open your browser
open http://localhost:8000
```

---

## 6. Environment Variables

Copy `.env.example` to `.env` and fill in the values.

| Variable          | Required | Description                                    |
|-------------------|----------|------------------------------------------------|
| `PORT`            | No       | Server port (default: 8000)                    |
| `REDIS_HOST`      | No       | Redis hostname (default: localhost)            |
| `REDIS_PORT`      | No       | Redis port (default: 6379)                     |
| `REDIS_PASSWORD`  | No       | Redis password (leave blank for local)         |
| `SDK_KEY`         | Yes      | @oaauth/sdk API key                            |
| `SDK_GATEWAY_URL` | Yes      | OIDC gateway URL from your auth provider       |
| `OIDC_REDIRECT_URI` | Yes   | Callback URL (must match IdP config)           |
| `JWT_SECRET`      | Yes      | Secret for JWT verification (dev only)        |
| `APP_URL`         | No       | Public URL of the app (used in redirects)      |
| `NODE_ENV`        | No       | `development` or `production`                  |

---

## 7. Redis Setup

### Local (macOS)
```bash
brew install redis
brew services start redis
redis-cli ping  # should return PONG
```

### Local (Ubuntu/WSL)
```bash
sudo apt install redis-server
sudo service redis-server start
redis-cli ping
```

### Managed Redis (Railway, Upstash, Render)
1. Create a Redis instance on your chosen provider
2. Copy the connection URL
3. Set `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` in your `.env`

### Verify the bitmask key after running
```bash
redis-cli
> STRLEN checkbox:bits   # should grow as checkboxes are toggled
> BITCOUNT checkbox:bits # number of checked boxes
```

---

## 8. Project Structure

```
.
├── src/
│   ├── index.js                 # Main server entry point
│   ├── routes/
│   │   ├── auth.js              # OIDC auth routes + socket auth middleware
│   │   └── checkboxes.js        # GET /api/checkboxes, GET /api/stats
│   ├── middleware/
│   │   └── rate-limit.js        # Custom rate limiter (socket + HTTP)
│   └── utils/
│       ├── redis-connection.js  # Redis client setup (3 connections)
│       └── constants.js         # Shared constants (CHECKBOX_COUNT etc.)
├── public/
│   ├── index.html               # SPA shell
│   ├── style.css                # Warm editorial theme
│   └── app.js                   # Canvas grid, socket client, auth
├── .env.example                 # Environment variable template
├── package.json
└── README.md
```

---

## 9. Design Decisions & Trade-offs

### Why vanilla JS instead of React/Vue?
React's virtual DOM is excellent for component trees. Here the "component" is a million checkboxes — React would spend more time diffing than drawing. Vanilla canvas + typed arrays is dramatically faster and simpler for this use case.

### Why SETBIT instead of storing a JSON array?
- JSON array of 1M booleans: **~8–12 MB** in Redis, ~10 MB over the wire
- Bitmask: **125 KB** in Redis, ~167 KB base64 over the wire
- SETBIT is **atomic** — no need for WATCH/MULTI/EXEC transactions
- GETRANGE fetches the entire state in **one Redis round trip**

### Why three Redis connections?
Redis's protocol requires a client to be in either command mode or subscribe mode — not both. Publisher and subscriber must be separate connections. The third (`redis`) handles all other commands without being blocked by the subscribe state.

### Why not use Socket.IO rooms?
Rooms are useful when you want to send to a subset of users. Here every update goes to every user — `io.emit()` is simpler and faster. Rooms would add overhead without benefit.

### Why optimistic UI?
The round trip (click → server → Redis → Pub/Sub → broadcast → client) takes ~5–50 ms depending on network. Waiting for confirmation would make the UI feel sluggish. Reverting on rejection (rate limit) is acceptable UX — users see the box flash back, which also communicates the rate limit visually.

### Why canvas instead of virtualised DOM?
Even virtualised DOM (e.g. react-window) renders actual DOM nodes for visible items. At 80 columns × 50 rows = 4,000 nodes, this is manageable, but canvas drawing is faster, consumes less memory, and gives pixel-level control over the checkmark rendering style.

---

## 10. Screenshots

_Add screenshots of:_
- _Login page / auth flow_
- _Grid at different zoom levels_
- _Two browser windows showing real-time sync_
- _Mobile view_

---

## License

MIT
