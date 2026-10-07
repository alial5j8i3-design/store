"use strict";

const assert = require("assert");
const { bootServer, createRunner } = require("./security_harness");

const { test, section, finish } = createRunner("coupons");
const id = (value) => String(value);
const future = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

(async () => {
    const h = await bootServer();
    const { call, models } = h;
    const sellerA = h.mkUser("CouponSellerA", "seller");
    const sellerB = h.mkUser("CouponSellerB", "seller");
    const buyer = h.mkUser("CouponBuyer", "user");

    const create = (as, body) => call("POST", "/api/seller/coupons", { as, body });

    section("coupon authorization and seller isolation");
    await test("only sellers can list or create coupons", async () => {
        const list = await call("GET", "/api/seller/coupons", { as: buyer });
        assert.strictEqual(list.status, 403);
        assert.strictEqual(list.body.success, false);
        const createAsBuyer = await create(buyer, { coupon_name: "BUYER10", discount: 10, end_time: future() });
        assert.strictEqual(createAsBuyer.status, 403);
        assert.strictEqual(models.coupons.__docs.length, 0);
    });

    let couponA;
    await test("a seller creates a normalized coupon owned by the authenticated seller only", async () => {
        const response = await create(sellerA, {
            coupon_name: "  save_10  ", discount: "10.125", end_time: future(), seller_id: id(sellerB._id),
        });
        assert.strictEqual(response.status, 201);
        assert.strictEqual(response.body.success, true);
        assert.strictEqual(response.body.data.name, "SAVE_10");
        assert.strictEqual(response.body.data.discount, 10.13);
        couponA = response.body.data;
        const stored = models.coupons.__docs.find((doc) => id(doc._id) === id(couponA._id));
        assert.strictEqual(id(stored.seller_id), id(sellerA._id));
    });

    await test("coupon lists are scoped to the requesting seller", async () => {
        const response = await call("GET", "/api/seller/coupons", { as: sellerB });
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(response.body.data, []);
        assert.strictEqual(response.body.success, true);
    });

    await test("one seller cannot update or delete another seller's coupon", async () => {
        const update = await call("PUT", `/api/seller/coupons/${couponA._id}`, {
            as: sellerB, body: { discount: 50, seller_id: id(sellerB._id) },
        });
        assert.strictEqual(update.status, 404);
        const storedAfterUpdate = models.coupons.__docs.find((doc) => id(doc._id) === id(couponA._id));
        assert.strictEqual(storedAfterUpdate.discount, 10.13);
        assert.strictEqual(id(storedAfterUpdate.seller_id), id(sellerA._id));

        const remove = await call("DELETE", `/api/seller/coupons/${couponA._id}`, { as: sellerB });
        assert.strictEqual(remove.status, 404);
        assert.ok(models.coupons.__docs.some((doc) => id(doc._id) === id(couponA._id)));
    });

    section("coupon validation and boundaries");
    await test("creation rejects missing, malformed, expired, and out-of-range fields", async () => {
        const invalidBodies = [
            { discount: 10, end_time: future() },
            { coupon_name: "NO SPACES", discount: 10, end_time: future() },
            { coupon_name: "SHORT", discount: 0, end_time: future() },
            { coupon_name: "OVER", discount: 100.01, end_time: future() },
            { coupon_name: "BOOL", discount: true, end_time: future() },
            { coupon_name: "DATE", discount: 10, end_time: "not-a-date" },
            { coupon_name: "PAST", discount: 10, end_time: new Date(Date.now() - 1000).toISOString() },
        ];
        for (const body of invalidBodies) {
            const response = await create(sellerA, body);
            assert.strictEqual(response.status, 400, JSON.stringify(body));
            assert.strictEqual(response.body.success, false);
        }
    });

    await test("the inclusive maximum discount and code length boundaries are accepted", async () => {
        const response = await create(sellerA, { coupon_name: "A".repeat(30), discount: 100, end_time: future() });
        assert.strictEqual(response.status, 201);
        assert.strictEqual(response.body.data.discount, 100);
        const tooLong = await create(sellerA, { coupon_name: "B".repeat(31), discount: 1, end_time: future() });
        assert.strictEqual(tooLong.status, 400);
    });

    await test("codes are globally case-insensitive and duplicate creation is rejected", async () => {
        const first = await create(sellerB, { coupon_name: "global-code", discount: 5, end_time: future() });
        assert.strictEqual(first.status, 201);
        const duplicate = await create(sellerA, { coupon_name: "GLOBAL-CODE", discount: 6, end_time: future() });
        assert.strictEqual(duplicate.status, 409);
        assert.strictEqual(duplicate.body.success, false);
    });

    await test("owner can update valid fields but cannot submit an empty update or invalid id", async () => {
        const empty = await call("PUT", `/api/seller/coupons/${couponA._id}`, { as: sellerA, body: { seller_id: id(sellerB._id) } });
        assert.strictEqual(empty.status, 400);
        const badId = await call("PUT", "/api/seller/coupons/not-an-id", { as: sellerA, body: { discount: 12 } });
        assert.strictEqual(badId.status, 400);
        const updated = await call("PUT", `/api/seller/coupons/${couponA._id}`, { as: sellerA, body: { discount: 12.345 } });
        assert.strictEqual(updated.status, 200);
        assert.strictEqual(updated.body.data.discount, 12.35);
    });

    await h.stop();
    process.exitCode = finish();
})();
