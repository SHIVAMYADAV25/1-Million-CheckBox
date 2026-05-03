/**
 * Redis Connection Utility
 * ========================
 * We create THREE separate Redis clients:
 *
 *  1. `redis`      — General purpose: SETBIT / GETRANGE / counters
 *  2. `publisher`  — Publishes checkbox changes to the Pub/Sub channel
 *  3. `subscriber` — Subscribes to the channel (a subscribed client
 *                    cannot issue regular commands — Redis protocol rule)
 *
 * WHY THREE CLIENTS?
 * Once a Redis client calls SUBSCRIBE it enters a special mode and can
 * ONLY issue subscription-related commands.  Mixing pub/sub with regular
 * commands on the same connection causes "ERR Command not allowed" errors.
 * Using separate connections is the standard pattern.
 *
 * WHY ioredis?
 * Built-in auto-reconnect, promise-based API, and first-class support for
 * binary-safe commands like SETBIT / GETRANGE that we use for the bitmask.
 */

import Redis from "ioredis";

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  // Retry connection up to 10 times before giving up
  retryStrategy: (times) => (times > 10 ? null : Math.min(times * 100, 3000)),
  // Keep connection alive — avoids idle-timeout disconnects on managed Redis
  keepAlive: 10000,
  // Reconnect automatically on disconnect
  enableOfflineQueue: true,
};

export const redis      = new Redis(redisConfig);
export const publisher  = new Redis(redisConfig);
export const subscriber = new Redis(redisConfig);

// Log connection events so we know Redis is alive
for (const [name, client] of [
  ["redis", redis],
  ["publisher", publisher],
  ["subscriber", subscriber],
]) {
  client.on("connect",     () => console.log(`[redis:${name}] connected`));
  client.on("error",  (err) => console.error(`[redis:${name}] error:`, err.message));
  client.on("reconnecting",() => console.log(`[redis:${name}] reconnecting…`));
}