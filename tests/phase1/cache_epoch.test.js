const assert = require("assert");

const redisPath = require.resolve("../../config/redis");
require.cache[redisPath] = {
    id: redisPath,
    filename: redisPath,
    loaded: true,
    exports: { client: null, isRedisConfigured: () => false, isRedisReady: () => false },
};
const cache = require("../../utils/cache");

(async () => {
    const firstEpoch = await cache.getProductsEpoch();
    const firstKey = `products:v${firstEpoch}:page=1:limit=20`;
    await cache.set(firstKey, { price: 100 }, 60);
    assert.deepStrictEqual(await cache.get(firstKey), { price: 100 });

    await cache.delByPrefix("products");
    const secondEpoch = await cache.getProductsEpoch();
    const secondKey = `products:v${secondEpoch}:page=1:limit=20`;
    assert.notStrictEqual(secondEpoch, firstEpoch);
    assert.strictEqual(await cache.get(secondKey), null);

    console.log("PASS - product epoch invalidation makes stale listing keys unreachable");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
