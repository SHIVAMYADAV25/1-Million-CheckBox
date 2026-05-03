/**
 * ============================================================
 * 1 MILLION CHECKBOXES — Main Server Entry Point
 * ============================================================
 *
 * Architecture overview:
 * - Express HTTP server handles REST API + static files
 * - Socket.IO manages real-time WebSocket connections
 * - Redis stores checkbox state as a compact bitmask (Buffer)
 * - Redis Pub/Sub lets multiple server instances broadcast changes
 * - OIDC/OAuth handled via @oaauth/sdk
 * - Custom rate limiting via in-memory + Redis counters
 *
 * WHY THIS STRUCTURE:
 * Separating concerns (routes, middleware, utils, redis) keeps
 * each file focused, testable, and easy to understand during evals.
 */

import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";

import { publisher, redis, subscriber } from "./utils/redis-connection.js";
import { checkboxRouter } from "./routes/checkboxes.js";
import { authRouter, authMiddleware } from "./routes/auth.js";
import { socketRateLimit } from "./middleware/rate-limit.js";
import { PUBSUB_CHANNEL, CHECKBOX_COUNT } from "./utils/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Bootstrap ──────────────────────────────────────────────
async function main() {
  const app = express();
  const server = http.createServer(app);
  const port = process.env.PORT || 8000;

  // ─── Socket.IO Server ──────────────────────────────────────
  // cors: * is fine for a hackathon; tighten in production
  const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    // Compression reduces bandwidth for large payloads
    perMessageDeflate: true,
  });

  // ─── Redis Pub/Sub subscription ────────────────────────────
  // Subscribe ONCE here; every checkbox change published by ANY
  // server instance arrives here and is re-broadcast to all
  // local Socket.IO clients.  This is what makes multi-instance
  // horizontal scaling work.
  await subscriber.subscribe(PUBSUB_CHANNEL);

  subscriber.on("message", (_channel, message) => {
    // Parse the compact update: { index, checked }
    const update = JSON.parse(message);
    // Broadcast to every connected socket on this server instance
    io.emit("server:checkbox:change", update);
  });

  // ─── Socket.IO connection handler ──────────────────────────
  io.on("connection", (socket) => {
    console.log(`[socket] connected  ${socket.id}`);

    /**
     * SOCKET EVENT: client:checkbox:change
     *
     * Flow:
     * 1. Rate limit check (custom, no packages)
     * 2. Validate payload
     * 3. Update bitmask in Redis atomically via SETBIT
     * 4. Publish update to Redis channel
     *    → subscriber receives it → broadcasts to all clients
     *
     * WHY SETBIT?
     * Storing 1 million bits = 125 KB in Redis.
     * Storing 1 million JSON booleans ≈ 8–20 MB.
     * SETBIT/GETBIT are O(1) and perfectly atomic.
     */
    socket.on("client:checkbox:change", async (data) => {
      try {
        // ── 1. Rate limit ──────────────────────────────────
        const allowed = await socketRateLimit(socket.id, redis);
        if (!allowed) {
          socket.emit("server:error", {
            code: "RATE_LIMITED",
            message: "Too many changes. Please slow down.",
          });
          return;
        }

        // ── 2. Validate ────────────────────────────────────
        const { index, checked } = data;
        if (
          typeof index !== "number" ||
          index < 0 ||
          index >= CHECKBOX_COUNT ||
          typeof checked !== "boolean"
        ) {
          socket.emit("server:error", {
            code: "INVALID_PAYLOAD",
            message: "Invalid checkbox data.",
          });
          return;
        }

        // ── 3. Atomic bit update in Redis ─────────────────
        // SETBIT key offset value — O(1), no race condition
        await redis.setbit("checkbox:bits", index, checked ? 1 : 0);

        // ── 4. Publish to all server instances ────────────
        await publisher.publish(
          PUBSUB_CHANNEL,
          JSON.stringify({ index, checked })
        );
      } catch (err) {
        console.error("[socket] error handling checkbox change:", err);
        socket.emit("server:error", {
          code: "SERVER_ERROR",
          message: "Something went wrong.",
        });
      }
    });

    socket.on("disconnect", () => {
      console.log(`[socket] disconnected ${socket.id}`);
    });
  });

  // ─── Express Middleware ────────────────────────────────────
  app.use(express.json());
  app.use(cookieParser());

  // ─── Routes ────────────────────────────────────────────────
  // Auth endpoints: /auth/login, /auth/callback, /auth/me, /auth/logout
  app.use("/auth", authRouter);

  // Checkbox REST API: GET /checkboxes → returns full state
  app.use("/api", checkboxRouter);

  // Health check for load balancers / uptime monitors
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Serve static frontend (public/)
  app.use(
    express.static(path.resolve(__dirname, "../public"), {
      // Cache static assets aggressively; index.html never cached
      maxAge: "1d",
      index: false,
    })
  );

  // SPA fallback — serve index.html for any unmatched route
  app.get("*", (_req, res) => {
    res.sendFile(path.resolve(__dirname, "../public/index.html"));
  });

  // ─── Start ─────────────────────────────────────────────────
  server.listen(port, () => {
    console.log(`[server] running at http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});