/**
 * config/redis.js
 * ------------------------------------------------------------------
 * Optional shared Redis client used by utils/cache.js as a shared
 * cache between PM2 cluster workers.
 *
 * Behaviour:
 *  - REDIS_URL set      -> connect to Redis, used as the shared cache.
 *  - REDIS_URL not set  -> client stays null. utils/cache.js falls
 *                          back to a local, per-process node-cache.
 *                          That fallback is only safe for a single
 *                          process (no PM2 cluster mode, no multiple
 *                          instances/dynos).
 *
 * If Redis IS configured but becomes unreachable at runtime, we do
 * NOT silently switch to the local cache: with several PM2 workers
 * that would let each worker cache different data and disagree with
 * each other. Instead utils/cache.js treats every failed Redis call
 * as a cache miss and lets callers fall through to MongoDB, which
 * stays correct even if slower until Redis comes back.
 * ------------------------------------------------------------------
 */

require("dotenv").config();

const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL;

let client = null;
let wasReady = false;

// ioredis emits "error" on every failed reconnect attempt. Log the first one
// immediately, then at most one line per minute (with a count), so a Redis
// outage is visible without flooding the logs.
const ERROR_LOG_INTERVAL_MS = 60_000;
let lastErrorLogAt = 0;
let suppressedErrors = 0;
let downSince = 0;

if (REDIS_URL) {

    client = new Redis(REDIS_URL, {
        // Don't let a stuck Redis hang API requests forever - fail
        // fast so callers can fall back to MongoDB instead.
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,


        connectTimeout: 10000,
        enableOfflineQueue: true,

        commandTimeout: 5000,

        // Exponential-ish backoff between reconnect attempts, capped
        // at 5s, so a dead Redis doesn't spam reconnect attempts.
        // Jitter keeps PM2 workers from reconnecting in lockstep.
        retryStrategy(times) {
            return Math.min(times * 200, 5000) + Math.floor(Math.random() * 200);
        },

        // Only a failover (replica promoted/demoted) needs a new connection.
        // Returning true for EVERY error reply (WRONGTYPE, NOSCRIPT, OOM, ...)
        // dropped a healthy connection and caused reconnect storms.
        reconnectOnError(err) {
            return err.message.includes("READONLY") ? 2 : false;
        }
    });

    client.on("connect", () => {
        if (!downSince) console.log("[redis] connecting...");
    });

    client.on("ready", () => {
        console.log(downSince
            ? `[redis] connected and ready again after ${Math.round((Date.now() - downSince) / 1000)}s`
            : "[redis] connected and ready (shared cache active)");
        downSince = 0;
        suppressedErrors = 0;
        lastErrorLogAt = 0;
        if (wasReady) {
            client.incr("cache:cache_epoch:products").catch((error) =>
                console.error("[redis] product cache epoch refresh failed:", error.message)
            );
        }
        wasReady = true;
    });

    client.on("error", (err) => {
        if (!downSince) downSince = Date.now();
        const now = Date.now();
        if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
            console.error("[redis] error:", err.message +
                (suppressedErrors ? ` (${suppressedErrors} similar errors suppressed)` : ""));
            lastErrorLogAt = now;
            suppressedErrors = 0;
        } else {
            suppressedErrors += 1;
        }
    });

    client.on("close", () => {
        // One line when the connection drops; later retries stay quiet.
        // (wasReady must stay true: "ready" uses it to refresh the product
        // cache epoch after an outage.)
        if (wasReady && !downSince) console.warn("[redis] connection closed");
        if (!downSince) downSince = Date.now();
    });

} else {

    console.warn(
        "[redis] REDIS_URL not set - using per-process in-memory cache (node-cache) instead. " +
        "This is NOT safe if you run more than one process/worker at the same time " +
        "(PM2 cluster mode with instances > 1, multiple Railway instances, etc.), " +
        "since each worker would keep its own separate cache and could serve stale/ " +
        "inconsistent data. Set REDIS_URL before scaling beyond a single worker."
    );

}

if (!REDIS_URL && process.env.NODE_ENV === "production") {
    console.error("[redis] REDIS_URL is missing in production; cache and rate limits are per-process.");
    if (process.env.REQUIRE_REDIS === "1") process.exit(1);
}

function isRedisConfigured() {
    return client !== null;
}

function isRedisReady() {
    return client !== null && client.status === "ready";
}

async function closeRedis() {
    if (client) {
        try {
            await client.quit();
        } catch (err) {
            client.disconnect();
        }
    }
}

module.exports = {
    client,
    isRedisConfigured,
    isRedisReady,
    closeRedis
};