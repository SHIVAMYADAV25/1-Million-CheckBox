/**
 * Checkbox REST API
 * =================
 * Single endpoint: GET /api/checkboxes
 *
 * Returns the full checkbox state as a compact binary buffer encoded
 * in base64.  The client decodes this and renders the grid.
 *
 * WHY BASE64 BITMASK INSTEAD OF JSON ARRAY?
 * ──────────────────────────────────────────
 * 1 000 000 checkboxes as JSON booleans:
 *   [true, false, true, …]  ≈ 8–12 MB over the wire
 *
 * 1 000 000 bits as a bitmask:
 *   125 000 bytes = 122 KB
 *   Base64 encoded: ~167 KB
 *
 * That's a 50-70x reduction in payload size, which matters on first load.
 *
 * The client reads individual bits:
 *   checked = (buffer[Math.floor(index / 8)] >> (7 - (index % 8))) & 1
 *
 * This is standard bit manipulation — fast and allocation-free.
 */

import express from "express";
import { redis } from "../utils/redis-connection.js";
import { httpRateLimit } from "../middleware/rate-limit.js";
import { BITMASK_KEY, CHECKBOX_COUNT } from "../utils/constants.js";

export const checkboxRouter = express.Router();

// Attach the redis instance to req.app.locals so the rate limiter can use it
checkboxRouter.use((req, _res, next) => {
  req.app.locals.redis = redis;
  next();
});

/**
 * GET /api/checkboxes
 * Returns the full checkbox state as a base64-encoded bitmask.
 *
 * Rate limited: 30 requests per 10 seconds per IP
 * (loading the page on refresh counts as 1 call)
 */
checkboxRouter.get(
  "/checkboxes",
  httpRateLimit(30, 10),
  async (_req, res) => {
    try {
      // GETRANGE fetches a byte range from the Redis string (bitmask).
      // We fetch all bytes: offset 0 to (CHECKBOX_COUNT/8 - 1).
      // Redis returns a Buffer.
      const byteLength = Math.ceil(CHECKBOX_COUNT / 8);

      // Redis GETRANGE returns a Buffer.  If the key doesn't exist yet,
      // it returns an empty Buffer — we pad it to the expected size.
      let buf = await redis.getrangeBuffer(BITMASK_KEY, 0, byteLength - 1);

      if (!buf || buf.length === 0) {
        // All checkboxes default to unchecked (all zeros)
        buf = Buffer.alloc(byteLength, 0);
      } else if (buf.length < byteLength) {
        // Redis only stores up to the highest set bit; pad trailing zeros
        const padded = Buffer.alloc(byteLength, 0);
        buf.copy(padded);
        buf = padded;
      }

      res.json({
        total: CHECKBOX_COUNT,
        // Base64 is safe to transport in JSON without escaping issues
        state: buf.toString("base64"),
      });
    } catch (err) {
      console.error("[checkboxes] GET error:", err);
      res.status(500).json({ error: "Failed to load checkbox state." });
    }
  }
);

/**
 * GET /api/stats
 * Returns lightweight statistics without sending the full bitmask.
 * Used by the header to show "X checked / 1 000 000".
 */
checkboxRouter.get("/stats", async (_req, res) => {
  try {
    // BITCOUNT counts all set bits — O(N) on the key length but fast enough
    const checkedCount = await redis.bitcount(BITMASK_KEY);
    res.json({ checked: checkedCount, total: CHECKBOX_COUNT });
  } catch (err) {
    console.error("[stats] error:", err);
    res.status(500).json({ error: "Failed to fetch stats." });
  }
});