"use strict";

const assert = require("assert");
const path = require("path");
const { createRunner } = require("./security_harness");

const { test, section, finish } = createRunner("cache");
const project = path.join(__dirname, "..");
const redisPath = require.resolve(path.join(project, "config/redis.js"));
const cachePath = require.resolve(path.join(project, "utils/cache.js"));

function loadCache(redis) {
    require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: redis };
    delete require.cache[cachePath];
    return require(cachePath);
}

(async () => {
    section("local cache operations and epoch invalidation");
    const local = loadCache({ client: null, isRedisConfigured: () => false, isRedisReady: () => false });
    await test("local cache writes, reads, and deletes a concrete key", async () => {
        assert.strictEqual(await local.set("settings:store", { color: "blue" }, 60), true);
        assert.deepStrictEqual(await local.get("settings:store"), { color: "blue" });
        await local.del("settings:store");
        assert.strictEqual(await local.get("settings:store"), null);
    });

    await test("prefix invalidation removes old non-product entries", async () => {
        await local.set("sections:one", ["Phones"]);
        await local.set("sections:two", ["Laptops"]);
        await local.set("other:one", true);
        await local.delByPrefix("sections:");
        assert.strictEqual(await local.get("sections:one"), null);
        assert.strictEqual(await local.get("sections:two"), null);
        assert.strictEqual(await local.get("other:one"), true);
    });

    await test("product invalidation advances the epoch, making a prior epoch key stale", async () => {
        const before = await local.getProductsEpoch();
        const oldKey = `products:v${before}:page=1`;
        await local.set(oldKey, { products: ["old"] });
        await local.delByPrefix("products");
        const after = await local.getProductsEpoch();
        assert.strictEqual(after, before + 1);
        assert.deepStrictEqual(await local.get(oldKey), { products: ["old"] });
        assert.strictEqual(await local.get(`products:v${after}:page=1`), null);
    });

    section("configured Redis failure and recovery behavior");
    const state = { ready: false, values: new Map(), increments: 0 };
    const redis = {
        client: {
            async get(key) { return state.values.get(key) ?? null; },
            async set(key, value) { state.values.set(key, value); },
            async del(...keys) { keys.forEach((key) => state.values.delete(key)); },
            async incr(key) { state.increments += 1; const next = Number(state.values.get(key) || 0) + 1; state.values.set(key, String(next)); return next; },
            async scan() { return ["0", []]; },
        },
        isRedisConfigured: () => true,
        isRedisReady: () => state.ready,
    };
    const shared = loadCache(redis);

    await test("configured but unavailable Redis is a cache miss, never an unsafe local fallback", async () => {
        assert.strictEqual(await shared.set("shared", { secret: "no" }), false);
        assert.strictEqual(await shared.get("shared"), null);
        await shared.delByPrefix("products");
        assert.strictEqual(await shared.getProductsEpoch(), 1);
        assert.strictEqual(state.values.size, 0);
    });

    await test("on Redis recovery, a deferred product invalidation is committed before the epoch is used", async () => {
        state.ready = true;
        const epoch = await shared.getProductsEpoch();
        assert.strictEqual(epoch, 1);
        assert.strictEqual(state.increments, 1);
        assert.strictEqual(state.values.get("cache:cache_epoch:products"), "1");
        assert.strictEqual(await shared.set("shared", { current: true }, 60), true);
        assert.deepStrictEqual(await shared.get("shared"), { current: true });
    });

    process.exitCode = finish();
})();
