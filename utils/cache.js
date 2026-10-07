const NodeCache = require("node-cache");
const redis = require("../config/redis");


const NAMESPACE = "cache:";

const DEFAULT_TTL_SECONDS = 300; 
const PRODUCTS_CACHE_TTL_SECONDS = Math.min(Math.max(Number(process.env.PRODUCTS_CACHE_TTL_SECONDS) || 60, 1), 3600);
const PRODUCTS_EPOCH_KEY = "cache_epoch:products";
let localProductsEpoch = 0;
// When Redis is temporarily unavailable, remember that a logical flush is
// owed. The first request after Redis returns commits it with INCR so every
// worker starts using a fresh product-list key.
let productsEpochDirty = false;

const localCache = new NodeCache({
    stdTTL: DEFAULT_TTL_SECONDS,
    checkperiod: 60,      
    // Controllers only serialize cache values; they must not mutate a value
    // returned from this cache when cloning is disabled.
    useClones: false
});

function namespacedKey(key) {
    return `${NAMESPACE}${key}`;
}

/**
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function get(key) {

    if (redis.isRedisConfigured()) {


        if (!redis.isRedisReady()) {
            return null;
        }

        try {
            const raw = await redis.client.get(namespacedKey(key));
            return raw === null ? null : JSON.parse(raw);
        } catch (err) {
            console.error("cache.get (redis) error:", err.message);

            return null;
        }
    }

    try {
        const value = localCache.get(key);
        return value === undefined ? null : value;
    } catch (err) {
        console.error("cache.get (local) error:", err.message);
        return null; 
    }
}

/**
 * @param {string} key
 * @param {any} value
 * @param {number} ttlSeconds
 * @returns {Promise<boolean>}
 */
async function set(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {

    if (redis.isRedisConfigured()) {

        if (!redis.isRedisReady()) {
            return false;
        }

        try {
            await redis.client.set(
                namespacedKey(key),
                JSON.stringify(value),
                "EX",
                ttlSeconds
            );
            return true;
        } catch (err) {
            console.error("cache.set (redis) error:", err.message);
            return false;
        }
    }

    try {
        localCache.set(key, value, ttlSeconds);
        return true;
    } catch (err) {
        console.error("cache.set (local) error:", err.message);
        return false;
    }
}

/**
 * @param {string} key
 */
async function del(key) {

    if (redis.isRedisConfigured()) {

        if (!redis.isRedisReady()) {
            return;
        }

        try {
            await redis.client.del(namespacedKey(key));
        } catch (err) {
            console.error("cache.del (redis) error:", err.message);
        }
        return;
    }

    try {
        localCache.del(key);
    } catch (err) {
        console.error("cache.del (local) error:", err.message);
    }
}

/**

 * @param {string} prefix
 */
async function delByPrefix(prefix) {

    if (prefix === "products") {
        await bumpProductsEpoch();
        return;
    }

    if (redis.isRedisConfigured()) {

        if (!redis.isRedisReady()) {
            return;
        }

        try {
            const pattern = `${namespacedKey(prefix)}*`;
            let cursor = "0";

            do {
                const [nextCursor, keys] = await redis.client.scan(
                    cursor,
                    "MATCH",
                    pattern,
                    "COUNT",
                    100
                );

                cursor = nextCursor;

                if (keys.length) {
                    await redis.client.del(...keys);
                }
            } while (cursor !== "0");
        } catch (err) {
            console.error("cache.delByPrefix (redis) error:", err.message);
        }
        return;
    }

    try {
        const matchingKeys = localCache
            .keys()
            .filter((key) => key.startsWith(prefix));

        if (matchingKeys.length) {
            localCache.del(matchingKeys);
        }
    } catch (err) {
        console.error("cache.delByPrefix (local) error:", err.message);
    }
}

async function getProductsEpoch() {
    if (redis.isRedisConfigured()) {
        if (!redis.isRedisReady()) {
            console.error("cache epoch read skipped: Redis is not ready");
            return localProductsEpoch;
        }
        try {
            if (productsEpochDirty) {
                localProductsEpoch = await redis.client.incr(namespacedKey(PRODUCTS_EPOCH_KEY));
                productsEpochDirty = false;
                return localProductsEpoch;
            }
            const value = await redis.client.get(namespacedKey(PRODUCTS_EPOCH_KEY));
            localProductsEpoch = Number.parseInt(value, 10) || 0;
            return localProductsEpoch;
        } catch (error) {
            console.error("cache epoch read failed:", error.message);
            return localProductsEpoch;
        }
    }
    return localProductsEpoch;
}

async function bumpProductsEpoch() {
    localProductsEpoch++;
    if (redis.isRedisConfigured()) {
        if (!redis.isRedisReady()) {
            productsEpochDirty = true;
            console.error("cache epoch invalidation deferred: Redis is not ready");
            return localProductsEpoch;
        }
        try {
            localProductsEpoch = await redis.client.incr(namespacedKey(PRODUCTS_EPOCH_KEY));
            productsEpochDirty = false;
        } catch (error) {
            productsEpochDirty = true;
            console.error("cache epoch invalidation failed:", error.message);
        }
    }
    return localProductsEpoch;
}


async function flushAll() {
    await delByPrefix("");
}

module.exports = {
    get,
    set,
    del,
    delByPrefix,
    flushAll,
    getProductsEpoch,
    bumpProductsEpoch,
    PRODUCTS_CACHE_TTL_SECONDS,
    client: redis.client
};
