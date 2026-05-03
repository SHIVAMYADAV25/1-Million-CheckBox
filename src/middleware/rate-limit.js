/**
 * Custom Rate Limiter
 * ===================
 * NO external packages (express-rate-limit etc.) — built from scratch.
 *
 * Strategy: Sliding Window Counter stored in Redis
 * ─────────────────────────────────────────────────
 * For each socket/IP/user we store a Redis key:
 *   rate:{socketId}
 * Value: integer counter (number of events in current window)
 * TTL:   RATE_LIMIT_WINDOW seconds (auto-expires, no cleanup needed)
 *
 * On each event:
 *   1. INCR the counter   → atomic, safe under concurrent requests
 *   2. If counter === 1   → first event in window; SET TTL via EXPIRE
 *   3. If counter > MAX   → reject
 *
 * WHY REDIS (not in-memory Map)?
 * In-memory Maps are per-process.  With multiple Node workers / servers
 * behind a load balancer, each would have its own Map.  Redis is shared
 * across all instances, giving correct global rate limits.
 *
 * HTTP rate limiter works the same way but keys on IP address.
 */

import { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX } from "../utils/constants.js";

/**
 * Rate limit a Socket.IO event.
 * @param {string} socketId
 * @param {import("ioredis").Redis} redisClient
 * @returns {Promise<boolean>} true = allowed, false = blocked
 */
export async function socketRateLimit(socketId, redisClient) {
  const key = `rate:socket:${socketId}`;
  return _checkLimit(key, redisClient, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
}

/**
 * Rate limit an HTTP request by IP.
 * Returns Express middleware.
 * @param {number} [max]    max requests per window (default: RATE_LIMIT_MAX)
 * @param {number} [window] window in seconds (default: RATE_LIMIT_WINDOW)
 */
export function httpRateLimit(max = RATE_LIMIT_MAX, window = RATE_LIMIT_WINDOW) {
  return async (req, res, next) => {
    // Prefer X-Forwarded-For (set by reverse proxies) over socket IP
    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const key = `rate:http:${ip}`;
    const allowed = await _checkLimit(key, req.app.locals.redis, max, window);

    if (!allowed) {
      return res.status(429).json({
        error: "Too many requests. Please slow down.",
        retryAfter: window,
      });
    }
    next();
  };
}

/**
 * Core sliding-window logic shared by socket and HTTP limiters.
 * @private
 */
async function _checkLimit(key, redisClient, max, windowSeconds) {
  try {
    // Atomically increment the counter
    const count = await redisClient.incr(key);

    // On the very first increment, set the TTL so the window expires
    // automatically.  We only set it once (when count === 1) to avoid
    // resetting the window on every request (that would be a fixed window,
    // not a sliding one).
    if (count === 1) {
      await redisClient.expire(key, windowSeconds);
    }

    return count <= max;
  } catch (err) {
    // If Redis is down, fail open (allow the request) to avoid locking out
    // all users.  Log it so the outage is visible.
    console.error("[rate-limit] Redis error — failing open:", err.message);
    return true;
  }
}