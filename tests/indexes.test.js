"use strict";

const assert = require("assert");
const Users = require("../models/users");
const Products = require("../models/products");
const Orders = require("../models/order");
const Store = require("../models/store");

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS - ${name}`); passed += 1; }
    catch (error) { console.log(`  FAIL - ${name}\n         ${error.message}`); failed += 1; }
}

function findIndex(model, key) {
    return model.schema.indexes().find(([keys]) => JSON.stringify(keys) === JSON.stringify(key));
}

(async () => {
    console.log("\n=== PERF-01 declared Mongoose indexes ===");
    await test("user email is unique and super-admin role has its partial unique guard", () => {
        assert.strictEqual(Users.schema.path("email").options.unique, true);
        const roleIndex = findIndex(Users, { role: 1 });
        assert.ok(roleIndex);
        assert.strictEqual(roleIndex[1].unique, true);
        assert.deepStrictEqual(roleIndex[1].partialFilterExpression, { role: "super_admin" });
    });

    await test("products declare seller, store, section, active-listing, and chronological query indexes", () => {
        for (const key of [
            { seller_id: 1, createdAt: -1 },
            { store_id: 1, createdAt: -1 },
            { section: 1, createdAt: -1 },
            { is_active: 1, createdAt: -1 },
            { createdAt: -1 },
        ]) assert.ok(findIndex(Products, key), `missing ${JSON.stringify(key)}`);
    });

    await test("orders declare seller, customer, and per-user idempotency indexes", () => {
        assert.strictEqual(Orders.schema.path("orderNumber").options.unique, true);
        assert.ok(findIndex(Orders, { "products.seller_id": 1, createdAt: -1 }));
        assert.ok(findIndex(Orders, { user_id: 1, createdAt: -1 }));
        const idempotency = findIndex(Orders, { user_id: 1, idempotency_key: 1 });
        assert.ok(idempotency);
        assert.strictEqual(idempotency[1].unique, true);
        assert.deepStrictEqual(idempotency[1].partialFilterExpression, { idempotency_key: { $type: "string" } });
    });

    await test("stores enforce unique slugs and one store per owner with a partial unique index", () => {
        assert.strictEqual(Store.schema.path("slug").options.unique, true);
        const ownerIndex = findIndex(Store, { owner_id: 1 });
        assert.ok(ownerIndex);
        assert.strictEqual(ownerIndex[1].unique, true);
        assert.deepStrictEqual(ownerIndex[1].partialFilterExpression, { owner_id: { $exists: true } });
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
})();
