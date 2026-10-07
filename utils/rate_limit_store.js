const { rateLimit } = require("express-rate-limit");
const redis = require("../config/redis");

/*
 * Rate-limit storage.
 *
 *  - REDIS_URL not set  -> express-rate-limit's default per-process memory store
 *                          (unchanged behaviour).
 *  - REDIS_URL set      -> ResilientRedisStore: counters live in Redis (one atomic
 *                          Lua round trip per request, on the ONE shared ioredis
 *                          client from config/redis.js). While Redis is not ready,
 *                          or a Redis command fails/times out, the request is
 *                          counted in a bounded per-process fallback instead.
 *                          A limiter therefore never "fails open": it degrades to
 *                          a local limit (per worker) and returns to Redis by
 *                          itself once Redis answers again.
 *
 * Lifecycle (one shared state machine for every limiter, logged on transitions only):
 *    initial -> starting   Redis not ready yet at startup: fallback in use, nothing is sent to Redis.
 *    starting/fallback -> redis   Redis is ready: every limiter switches to the shared store on its next
 *                          request. No restart, and limiters are NOT re-created.
 *    redis -> fallback     connection closed or a command failed/timed out: local fallback + short breaker.
 *
 * No store work happens at construction time (the old RedisStore sent
 * SCRIPT LOAD while the module was being required, which timed out when Redis
 * was down), and nothing is retried in a loop: a failure opens a short breaker
 * so requests go straight to the fallback instead of waiting on a sick Redis.
 */

const REDIS_COMMAND_TIMEOUT_MS = 750;   // per rate-limit command (client-level commandTimeout is 5s)
const REDIS_BREAKER_COOLDOWN_MS = 3000; // after a failure, skip Redis for this long
const FALLBACK_MAX_KEYS = 50_000;       // hard cap per limiter
const FALLBACK_SWEEP_INTERVAL_MS = 30_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

const INCREMENT_LUA = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;

// Never drives a counter below zero and never creates a key without a TTL.
const DECREMENT_LUA = `
local value = tonumber(redis.call('GET', KEYS[1]))
if value and value > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

// ---- bounded per-process fallback ----------------------------------------------------------
// Fixed window per key. Every entry of one store has the same length, so Map
// insertion order is also expiry order and pruning only walks expired entries.

const fallbackStores = new Set();
let fallbackSweeper = null;

function ensureFallbackSweeper(store) {
    fallbackStores.add(store);
    if (fallbackSweeper) return;
    // ONE timer for the process, unref'd so it never blocks shutdown.
    fallbackSweeper = setInterval(() => {
        const now = Date.now();
        for (const registered of fallbackStores) registered.prune(now);
    }, FALLBACK_SWEEP_INTERVAL_MS);
    fallbackSweeper.unref();
}

class LocalWindowStore {
    constructor() {
        this.windowMs = 60_000;
        this.entries = new Map(); // key -> { totalHits, resetAt }
    }

    prune(now) {
        for (const [key, entry] of this.entries) {
            if (entry.resetAt > now) break;
            this.entries.delete(key);
        }
    }

    live(key, now) {
        const entry = this.entries.get(key);
        if (entry && entry.resetAt <= now) {
            this.entries.delete(key);
            return undefined;
        }
        return entry;
    }

    increment(key) {
        const now = Date.now();
        let entry = this.live(key, now);
        if (!entry) {
            if (this.entries.size >= FALLBACK_MAX_KEYS) {
                this.prune(now);
                if (this.entries.size >= FALLBACK_MAX_KEYS) {
                    this.entries.delete(this.entries.keys().next().value);
                }
            }
            entry = { totalHits: 0, resetAt: now + this.windowMs };
            this.entries.set(key, entry);
            ensureFallbackSweeper(this);
        }
        entry.totalHits += 1;
        return { totalHits: entry.totalHits, resetTime: new Date(entry.resetAt) };
    }

    get(key) {
        const entry = this.live(key, Date.now());
        return entry ? { totalHits: entry.totalHits, resetTime: new Date(entry.resetAt) } : undefined;
    }

    decrement(key) {
        const entry = this.live(key, Date.now());
        if (entry && entry.totalHits > 0) entry.totalHits -= 1;
    }

    resetKey(key) {
        this.entries.delete(key);
    }
}

// ---- Redis health, shared by every limiter (they all use the same client) --------------------

const LIFECYCLE_FLAG = Symbol.for("rateLimitStore.lifecycleAttached");

let breakerOpenUntil = 0;
let mode = "initial"; // "initial" | "starting" (fallback before first ready) | "redis" | "fallback" (outage)
let commandsDefined = false;
let lastErrorLogAt = 0;
let suppressedErrors = 0;

// Both functions log only when the state actually changes, never once per request.
function enterFallback() {
    if (mode === "initial") {
        mode = "starting";
        // Expected during the first connect handshake (TCP+TLS+AUTH), so informational, not a warning.
        console.log("[rate-limit] Redis not ready; using temporary fallback.");
    } else if (mode === "redis") {
        mode = "fallback";
        // The reason is not repeated here; the throttled "command failed" line / [redis] logs carry it.
        console.warn("[rate-limit] Redis unavailable; using fallback (per-process limits).");
    }
    // "starting" / "fallback": already degraded, stay quiet.
}

function enterRedis() {
    if (mode === "redis") return;
    const recovered = mode === "fallback";
    mode = "redis";
    console.log(recovered
        ? "[rate-limit] Redis recovered; shared rate limiting active."
        : "[rate-limit] using Redis store.");
}

function markFailed(error) {
    breakerOpenUntil = Date.now() + REDIS_BREAKER_COOLDOWN_MS;
    enterFallback();
    // Observable, but at most one line per minute however many requests fail.
    const now = Date.now();
    if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
        console.error(`[rate-limit] Redis command failed: ${error.message}` +
            (suppressedErrors ? ` (${suppressedErrors} similar errors suppressed)` : ""));
        lastErrorLogAt = now;
        suppressedErrors = 0;
    } else {
        suppressedErrors += 1;
    }
}

// Subscribes ONCE per client (flag on the client itself, so even a re-required copy of this
// module cannot add a second listener). Events only make the state transition immediate; the
// per-request readiness check below stays authoritative, so a client without an event API
// (e.g. a test double) still works.
function attachLifecycle() {
    const client = redis.client;
    if (!client || typeof client.on !== "function" || client[LIFECYCLE_FLAG]) return;
    client[LIFECYCLE_FLAG] = true;
    client.on("ready", () => {
        breakerOpenUntil = 0; // fresh, handshaken connection: let traffic go to Redis immediately
        enterRedis();
    });
    client.on("close", () => {
        if (client.manuallyClosing) return; // graceful quit() during shutdown is not an outage
        enterFallback();
    });
    if (redis.isRedisReady()) enterRedis();
}

function redisUsable() {
    if (!redis.isRedisReady()) {
        enterFallback();
        return false;
    }
    // Ready before any command succeeded (first request after startup): the shared store is live.
    if (mode === "initial" || mode === "starting") enterRedis();
    return Date.now() >= breakerOpenUntil;
}

function ensureCommands(client) {
    if (commandsDefined) return;
    client.defineCommand("rateLimitIncrement", { numberOfKeys: 1, lua: INCREMENT_LUA });
    client.defineCommand("rateLimitDecrement", { numberOfKeys: 1, lua: DECREMENT_LUA });
    commandsDefined = true;
}

function withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`rate-limit Redis command timed out after ${REDIS_COMMAND_TIMEOUT_MS}ms`)),
            REDIS_COMMAND_TIMEOUT_MS,
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs one Redis operation; resolves { ok: true, value } or { ok: false } and never throws.
async function tryRedis(operation) {
    if (!redisUsable()) return { ok: false };
    try {
        ensureCommands(redis.client);
        const value = await withTimeout(operation(redis.client));
        enterRedis();
        return { ok: true, value };
    } catch (error) {
        markFailed(error);
        return { ok: false };
    }
}

class ResilientRedisStore {
    constructor(prefix) {
        this.prefix = `ratelimit:${prefix}:`;
        this.localKeys = false;
        this.windowMs = 60_000;
        this.fallback = new LocalWindowStore();
    }

    init(options) {
        this.windowMs = options.windowMs;
        this.fallback.windowMs = options.windowMs;
    }

    async increment(key) {
        const result = await tryRedis((client) => client.rateLimitIncrement(this.prefix + key, this.windowMs));
        if (result.ok && Array.isArray(result.value) && result.value.length === 2) {
            const [hits, ttl] = result.value;
            return { totalHits: Number(hits), resetTime: new Date(Date.now() + Math.max(Number(ttl), 0)) };
        }
        if (result.ok) markFailed(new Error("unexpected reply from the rate-limit script"));
        return this.fallback.increment(key);
    }

    async get(key) {
        const result = await tryRedis((client) =>
            Promise.all([client.get(this.prefix + key), client.pttl(this.prefix + key)]));
        if (result.ok) {
            const [value, ttl] = result.value;
            if (value === null || value === undefined) return undefined;
            return { totalHits: Number(value), resetTime: new Date(Date.now() + Math.max(Number(ttl), 0)) };
        }
        return this.fallback.get(key);
    }

    async decrement(key) {
        const result = await tryRedis((client) => client.rateLimitDecrement(this.prefix + key));
        if (!result.ok) this.fallback.decrement(key);
    }

    async resetKey(key) {
        this.fallback.resetKey(key);
        await tryRedis((client) => client.del(this.prefix + key));
    }
}

function storeFor(prefix) {
    if (redis.isRedisConfigured()) {
        attachLifecycle();
        return new ResilientRedisStore(prefix);
    }
    if (process.env.NODE_ENV === "production") {
        console.warn(`[rate-limit] Redis is not configured; ${prefix} uses per-process memory limits.`);
    }
    return undefined;
}

function createRateLimiter(options) {
    const { prefix, ...config } = options;
    if (!prefix) throw new Error("Rate limiter prefix is required");
    // No passOnStoreError: the store handles Redis failures itself (local
    // fallback), so a limiter is never silently skipped.
    return rateLimit({ ...config, store: storeFor(prefix) });
}

const authenticatedUserKey = (req) => String(req.user._id);

module.exports = { createRateLimiter, storeFor, authenticatedUserKey };