// Order lifecycle + order security tests.
//
//   node tests/order_lifecycle.test.js
//
// What runs: the REAL controllers (order / update_status_of_order / delete_order) and the REAL
// utils/order_stock.js, wired to the project's strict in-memory model fake
// (tests/phase1/mock_models.js) built from the REAL Mongoose schemas.
//
// IMPORTANT LIMITATION (same as tests/phase1): no mongod binary is obtainable offline, so nothing
// here talks to a real MongoDB. To keep the fake faithful where the order lifecycle depends on
// real-Mongoose behaviour, this file adds a small shim on the orders model that emulates:
//   * schema casting of user_id (ObjectId -> String)
//   * `timestamps: true` (createdAt/updatedAt on save, updatedAt bumped by findOneAndUpdate)
//     -> needed for the optimistic lock used by delete_order.controller.js
//   * the partial UNIQUE index { user_id, idempotency_key } declared in models/order.js
// Unique-index enforcement and atomicity are therefore emulated, not proven against a real DB.
// Run the same scenarios against a staging MongoDB before relying on them for production.
const assert = require("assert");
const path = require("path");
const crypto = require("crypto");
const { makeFakeModel, realSchema, ObjectId } = require("./phase1/mock_models");

const PROJECT = path.join(__dirname, "..");

// Load the real schemas BEFORE any fake is injected into require.cache.
const FakeProducts = makeFakeModel("products", { schema: realSchema("products") });
// models/order.js: unique orderNumber + partial unique { user_id, idempotency_key } (only when the key is a string).
const FakeOrders = makeFakeModel("orders", {
    schema: realSchema("order"),
    uniqueFields: ["orderNumber"],
    uniqueIndexes: [{ fields: ["user_id", "idempotency_key"], when: (d) => typeof d.idempotency_key === "string" }],
});
const FakeCoupons = makeFakeModel("coupons", { schema: realSchema("coupon"), uniqueFields: ["name"] });
const FakeUsers = makeFakeModel("users", { schema: realSchema("users") });
// models/order_archive.js: unique { order_id, order_updated_at }. Real schema => order_id / removed_by are
// cast to ObjectId and required/enum rules apply, exactly like orderArchive.create() in production.
const FakeArchive = makeFakeModel("order_archive", {
    schema: realSchema("order_archive"),
    uniqueIndexes: [{ fields: ["order_id", "order_updated_at"] }],
});
const archived = FakeArchive.__docs;

// ---- orders-model shim (see header) ----------------------------------------------------------
let clock = Date.now();
const tick = () => new Date(++clock);
const hooks = { beforeOrderSave: null, beforeOrderDelete: null };

const rawSave = FakeOrders.prototype.save;
FakeOrders.prototype.save = async function save() {
    if (typeof hooks.beforeOrderSave === "function") await hooks.beforeOrderSave(this);
    if (this.user_id !== undefined && this.user_id !== null) this.user_id = String(this.user_id);
    if (!this.createdAt) this.createdAt = tick();
    this.updatedAt = tick();
    return rawSave.call(this);
};
const rawFindOneAndUpdate = FakeOrders.findOneAndUpdate;
FakeOrders.findOneAndUpdate = (filter, update, opts) => {
    const hasOps = Object.keys(update || {}).some((k) => k.startsWith("$"));
    const withStamp = hasOps ? { ...update, $set: { ...(update.$set || {}), updatedAt: tick() } } : { $set: { ...update, updatedAt: tick() } };
    return rawFindOneAndUpdate(filter, withStamp, opts);
};
const rawFindOneAndDelete = FakeOrders.findOneAndDelete;
FakeOrders.findOneAndDelete = async (filter) => {
    if (typeof hooks.beforeOrderDelete === "function") await hooks.beforeOrderDelete(filter);
    return rawFindOneAndDelete(filter);
};

function inject(rel, exportsValue) {
    const abs = require.resolve(path.join(PROJECT, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsValue };
}
inject("models/products.js", FakeProducts);
inject("models/order.js", FakeOrders);
inject("models/coupon.js", FakeCoupons);
inject("models/users.js", FakeUsers);
inject("models/order_archive.js", FakeArchive);
inject("utils/cache.js", { delByPrefix: async () => {} });

const createOrder = require(path.join(PROJECT, "controller/order.controller.js"));
const updateStatus = require(path.join(PROJECT, "controller/update_status_of_order.controller.js"));
const deleteOrder = require(path.join(PROJECT, "controller/delete_order.controller.js"));

// Controllers log expected failures with console.log/console.error; keep the report readable.
const out = (s) => process.stdout.write(s + "\n");
console.log = () => {};
console.error = () => {};

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        out(`  PASS - ${name}`);
        passed++;
    } catch (error) {
        out(`  FAIL - ${name}\n         ${String(error.message).split("\n").join("\n         ")}`);
        failed++;
    }
}

// ---- fixtures --------------------------------------------------------------------------------
const sellerA = new ObjectId();
const sellerB = new ObjectId();
const mkBuyer = (name = "Buyer") => ({ _id: new ObjectId(), name, role: "user", phone_number: "0100000000", GPS_URL: "https://maps.test/l", whatsApp_number: "0100000000" });
let buyer = mkBuyer();

function reset() {
    FakeProducts.__docs.splice(0);
    FakeOrders.__docs.splice(0);
    FakeCoupons.__docs.splice(0);
    FakeUsers.__docs.splice(0);
    FakeArchive.__docs.splice(0);
    FakeProducts.__beforeFindOneAndUpdate = null;
    hooks.beforeOrderSave = null;
    hooks.beforeOrderDelete = null;
    FakeUsers.__seed([{ _id: sellerA, role: "seller" }, { _id: sellerB, role: "seller" }]);
    buyer = mkBuyer();
}

const product = (seller, extra = {}) => ({
    _id: new ObjectId(), seller_id: seller, store_id: new ObjectId(), name: "Used phone", price: 100, discount: 0,
    quantity: 5, images: ["https://images.test/p.jpg"], section: new ObjectId(), description: "good", ...extra,
});
const coupon = (seller, extra = {}) => ({
    _id: new ObjectId(), name: "SAVE10", discount: 10, end_time: new Date(Date.now() + 3600 * 1000), seller_id: seller, ...extra,
});
const res = () => ({
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
});
function ioSpy() {
    const emitted = [];
    return { emitted, to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
}
async function place(items, { user = buyer, key, body = {}, io = ioSpy() } = {}) {
    const r = res();
    await createOrder({ user, body: { products: items, ...body }, headers: key ? { "idempotency-key": key } : {}, io }, r);
    return r;
}
const line = (p, quantity = 1) => ({ id: String(p._id), quantity });
const sellerReq = (seller, body) => ({ user: { _id: seller, role: "seller" }, body, io: null });
const setStatus = async (seller, orderId, status) => { const r = res(); await updateStatus(sellerReq(seller, { order_id: String(orderId), status_order: status }), r); return r; };
const removeOrder = async (seller, orderId) => { const r = res(); await deleteOrder(sellerReq(seller, { order_id: String(orderId) }), r); return r; };
const stockOf = (p) => FakeProducts.__docs.find((d) => String(d._id) === String(p._id)).quantity;
const stored = () => FakeOrders.__docs;
const storedIdOf = (r) => String(r.body.data._id);
const cents = (n) => Math.round(n * 100);

(async () => {
    // ===================================================================================== 1
    out("\n=== 1. Price integrity & client-field tampering ===");
    await test("price comes from the database, client price/discount/name are ignored", async () => {
        reset();
        const p = product(sellerA, { price: 100, discount: 10, name: "Real name" });
        FakeProducts.__seed([p]);
        const r = await place([{ id: String(p._id), quantity: 2, price: 0.01, discount: 100, name: "Hacked", total: 1 }]);
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(stored().length, 1);
        assert.strictEqual(stored()[0].products[0].price, 90);
        assert.strictEqual(stored()[0].products[0].name, "Real name");
        assert.strictEqual(stored()[0].total_price, 180);
    });
    await test("client seller_id on a line item and in the body is ignored; snapshot comes from the product", async () => {
        reset();
        const p = product(sellerA);
        FakeProducts.__seed([p]);
        const r = await place([{ id: String(p._id), quantity: 1, seller_id: String(sellerB) }], { body: { seller_id: String(sellerB) } });
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(stored()[0].products[0].seller_id, String(sellerA));
        assert.ok(!JSON.stringify(r.body.data.products).includes(String(sellerA)), "buyer response must not expose seller_id");
    });
    await test("top-level body fields (total_price, status, user_id, user_name, orderNumber, idempotency_key) cannot alter the order", async () => {
        reset();
        const p = product(sellerA);
        FakeProducts.__seed([p]);
        const victim = new ObjectId();
        const r = await place([line(p)], {
            body: { total_price: 0.01, price: 0.01, status: "delivered", user_id: String(victim), user_name: "Mallory", orderNumber: "ORD-1", idempotency_key: "body-key", coupon_discount_percent: 100, stock_restored: true },
        });
        assert.strictEqual(r.statusCode, 201);
        const o = stored()[0];
        assert.strictEqual(o.total_price, 100);
        assert.strictEqual(o.status, "new");
        assert.strictEqual(o.user_id, String(buyer._id));
        assert.strictEqual(o.user_name, "Buyer");
        assert.notStrictEqual(o.orderNumber, "ORD-1");
        assert.strictEqual(o.idempotency_key, undefined, "idempotency key is read from the header only");
        assert.strictEqual(o.coupon_discount_percent, undefined);
        assert.strictEqual(o.stock_restored, undefined);
    });
    await test("buyer address/phone come from the authenticated account, not the body", async () => {
        reset();
        const p = product(sellerA);
        FakeProducts.__seed([p]);
        await place([line(p)], { body: { phone_number: "999", GPS_URL: "https://evil.test", whatsApp_number: "999" } });
        assert.strictEqual(stored()[0].phone_number, "0100000000");
        assert.strictEqual(stored()[0].GPS_URL, "https://maps.test/l");
    });
    await test("unauthenticated request is rejected and touches nothing", async () => {
        reset();
        const p = product(sellerA);
        FakeProducts.__seed([p]);
        const r = res();
        await createOrder({ user: undefined, body: { products: [line(p)] }, headers: {}, io: null }, r);
        assert.strictEqual(r.statusCode, 401);
        assert.strictEqual(stockOf(p), 5);
        assert.strictEqual(stored().length, 0);
    });

    // ===================================================================================== 2
    out("\n=== 2. Multi-seller cart ===");
    await test("cart with products from two sellers is rejected, no stock change, no order", async () => {
        reset();
        const a = product(sellerA);
        const b = product(sellerB);
        FakeProducts.__seed([a, b]);
        const r = await place([line(a), line(b)]);
        assert.strictEqual(r.statusCode, 400);
        assert.match(r.body.message, /more than one seller/i);
        assert.strictEqual(stockOf(a), 5);
        assert.strictEqual(stockOf(b), 5);
        assert.strictEqual(stored().length, 0);
    });
    await test("multi-seller rejection happens before coupon handling (no stock touched even with a valid coupon)", async () => {
        reset();
        const a = product(sellerA);
        const b = product(sellerB);
        FakeProducts.__seed([a, b]);
        FakeCoupons.__seed([coupon(sellerA)]);
        const r = await place([line(a), line(b)], { body: { coupon: "SAVE10" } });
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(a), 5);
        assert.strictEqual(stockOf(b), 5);
    });
    await test("several different products of ONE seller are accepted", async () => {
        reset();
        const a = product(sellerA);
        const b = product(sellerA, { price: 50 });
        FakeProducts.__seed([a, b]);
        const r = await place([line(a, 1), line(b, 2)]);
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(stored()[0].total_price, 200);
        assert.strictEqual(stockOf(a), 4);
        assert.strictEqual(stockOf(b), 3);
    });

    // ===================================================================================== 3
    out("\n=== 3. Insufficient stock ===");
    await test("quantity above stock fails and stock is untouched", async () => {
        reset();
        const p = product(sellerA, { quantity: 3 });
        FakeProducts.__seed([p]);
        const r = await place([line(p, 4)]);
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(r.body.success, false);
        assert.strictEqual(stockOf(p), 3);
        assert.strictEqual(stored().length, 0);
    });
    await test("ordering exactly the available quantity succeeds and leaves 0 (never negative)", async () => {
        reset();
        const p = product(sellerA, { quantity: 3 });
        FakeProducts.__seed([p]);
        const r = await place([line(p, 3)]);
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(stockOf(p), 0);
    });
    await test("duplicate lines of the same product are merged BEFORE the stock check (2+2 > 3 fails, stock intact)", async () => {
        reset();
        const p = product(sellerA, { quantity: 3 });
        FakeProducts.__seed([p]);
        const r = await place([line(p, 2), line(p, 2)]);
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(p), 3);
        assert.strictEqual(stored().length, 0);
    });
    await test("one product short in a multi-product order: the in-stock product is NOT reduced", async () => {
        reset();
        const a = product(sellerA, { quantity: 5 });
        const b = product(sellerA, { quantity: 1 });
        FakeProducts.__seed([a, b]);
        const r = await place([line(a, 2), line(b, 2)]);
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(a), 5);
        assert.strictEqual(stockOf(b), 1);
    });
    await test("stock drained by a concurrent buyer AFTER validation: reservation fails and earlier reservations are rolled back", async () => {
        reset();
        const a = product(sellerA, { quantity: 5 });
        const b = product(sellerA, { quantity: 1 });
        FakeProducts.__seed([a, b]);
        FakeProducts.__beforeFindOneAndUpdate = async (filter) => {
            if (String(filter._id) === String(b._id)) {
                FakeProducts.__beforeFindOneAndUpdate = null;
                await FakeProducts.updateOne({ _id: b._id }, { $inc: { quantity: -1 } }); // somebody else bought it
            }
        };
        const r = await place([line(a, 2), line(b, 1)]);
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(a), 5, "product A reservation must be rolled back");
        assert.strictEqual(stockOf(b), 0);
        assert.strictEqual(stored().length, 0);
    });
    await test("two buyers race for the last unit: exactly one order, stock 0, never negative", async () => {
        reset();
        const p = product(sellerA, { quantity: 1 });
        FakeProducts.__seed([p]);
        const [r1, r2] = await Promise.all([place([line(p)], { user: mkBuyer("B1") }), place([line(p)], { user: mkBuyer("B2") })]);
        assert.deepStrictEqual([r1.statusCode, r2.statusCode].sort(), [201, 400]);
        assert.strictEqual(stockOf(p), 0);
        assert.strictEqual(stored().length, 1);
    });
    await test("invalid quantities (0, negative, fractional, huge, NaN) and bad ids are rejected without touching stock", async () => {
        reset();
        const p = product(sellerA);
        FakeProducts.__seed([p]);
        for (const quantity of [0, -1, 1.5, 1001, "abc", null]) {
            const r = await place([{ id: String(p._id), quantity }]);
            assert.strictEqual(r.statusCode, 400, `quantity ${quantity}`);
        }
        assert.strictEqual((await place([{ id: "not-an-id", quantity: 1 }])).statusCode, 400);
        assert.strictEqual(stockOf(p), 5);
        assert.strictEqual(stored().length, 0);
    });

    // ===================================================================================== 4
    out("\n=== 4. Duplicate identifiers ===");
    await test("malformed Idempotency-Key is rejected (400) before any stock change", async () => {
        reset();
        const p = product(sellerA);
        FakeProducts.__seed([p]);
        for (const key of ["has space", "bad!key", "x".repeat(129)]) {
            const r = await place([line(p)], { key });
            assert.strictEqual(r.statusCode, 400, key);
            assert.match(r.body.message, /Idempotency-Key/);
        }
        assert.strictEqual(stockOf(p), 5);
        assert.strictEqual(stored().length, 0);
    });
    await test("same Idempotency-Key from a DIFFERENT user is a different request (key is per-user)", async () => {
        reset();
        const p = product(sellerA);
        FakeProducts.__seed([p]);
        const r1 = await place([line(p)], { user: mkBuyer("B1"), key: "shared-key" });
        const r2 = await place([line(p)], { user: mkBuyer("B2"), key: "shared-key" });
        assert.strictEqual(r1.statusCode, 201);
        assert.strictEqual(r2.statusCode, 201);
        assert.strictEqual(stored().length, 2);
        assert.strictEqual(stockOf(p), 3);
    });
    await test("order number collision is retried with a fresh number; stock is deducted once", async () => {
        reset();
        const p = product(sellerA);
        FakeProducts.__seed([p]);
        FakeOrders.__seed([{ _id: new ObjectId(), orderNumber: "ORD-111111111", user_id: "x", products: [], total_price: 1, status: "new" }]);
        const original = crypto.randomInt;
        const numbers = [111111111, 222222222];
        crypto.randomInt = () => numbers.shift();
        try {
            const r = await place([line(p)]);
            assert.strictEqual(r.statusCode, 201);
            assert.strictEqual(r.body.data.orderNumber, "ORD-222222222");
        } finally { crypto.randomInt = original; }
        assert.strictEqual(stockOf(p), 4);
        assert.strictEqual(stored().length, 2);
    });
    await test("order number collision on EVERY attempt -> 500 and the reserved stock is restored", async () => {
        reset();
        const p = product(sellerA);
        FakeProducts.__seed([p]);
        FakeOrders.__seed([{ _id: new ObjectId(), orderNumber: "ORD-111111111", user_id: "x", products: [], total_price: 1, status: "new" }]);
        const original = crypto.randomInt;
        crypto.randomInt = () => 111111111;
        try {
            const r = await place([line(p, 2)]);
            assert.strictEqual(r.statusCode, 500);
        } finally { crypto.randomInt = original; }
        assert.strictEqual(stockOf(p), 5);
        assert.strictEqual(stored().length, 1);
    });

    // ===================================================================================== 5
    out("\n=== 5. Cancellation ===");
    async function orderFor(items) {
        const r = await place(items);
        assert.strictEqual(r.statusCode, 201, `setup order failed: ${JSON.stringify(r.body)}`);
        return storedIdOf(r);
    }
    await test("cancelling an eligible order restores the reserved stock exactly", async () => {
        reset();
        const a = product(sellerA, { quantity: 10 });
        const b = product(sellerA, { quantity: 7 });
        FakeProducts.__seed([a, b]);
        const id = await orderFor([line(a, 3), line(b, 2)]);
        assert.strictEqual(stockOf(a), 7);
        assert.strictEqual(stockOf(b), 5);
        const r = await setStatus(sellerA, id, "cancelled");
        assert.strictEqual(r.statusCode, 200);
        assert.strictEqual(stored()[0].status, "cancelled");
        assert.strictEqual(stockOf(a), 10);
        assert.strictEqual(stockOf(b), 7);
    });
    await test("cancelling the same order twice restores stock only once", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        assert.strictEqual((await setStatus(sellerA, id, "cancelled")).statusCode, 200);
        const second = await setStatus(sellerA, id, "cancelled");
        assert.strictEqual(second.statusCode, 409);
        assert.strictEqual(stockOf(p), 10);
    });
    await test("concurrent cancellation attempts (x6) restore stock exactly once", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        const results = await Promise.all(Array.from({ length: 6 }, () => setStatus(sellerA, id, "cancelled")));
        const codes = results.map((r) => r.statusCode).sort();
        assert.deepStrictEqual(codes, [200, 409, 409, 409, 409, 409]);
        assert.strictEqual(stockOf(p), 10);
    });
    await test("a transient failure of the stock restore write is retried and stock still comes back exactly once", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        const realUpdateOne = FakeProducts.updateOne;
        let calls = 0;
        FakeProducts.updateOne = async (...args) => { calls++; if (calls === 1) throw new Error("transient"); return realUpdateOne(...args); };
        try {
            const r = await setStatus(sellerA, id, "cancelled");
            assert.strictEqual(r.statusCode, 200);
        } finally { FakeProducts.updateOne = realUpdateOne; }
        assert.strictEqual(stockOf(p), 10);
    });
    await test("a delivered order cannot be cancelled and no stock is restored", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        assert.strictEqual((await setStatus(sellerA, id, "delivered")).statusCode, 200);
        assert.strictEqual(stockOf(p), 6, "delivering must not touch stock");
        assert.strictEqual((await setStatus(sellerA, id, "cancelled")).statusCode, 409);
        assert.strictEqual(stockOf(p), 6);
        assert.strictEqual(stored()[0].status, "delivered");
    });
    await test("a cancelled order cannot be revived (processing/shipped/delivered all rejected), stock stays restored", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        await setStatus(sellerA, id, "cancelled");
        for (const status of ["new", "processing", "shipped", "delivered"]) {
            assert.strictEqual((await setStatus(sellerA, id, status)).statusCode, 409, status);
        }
        assert.strictEqual(stockOf(p), 10);
        assert.strictEqual(stored()[0].status, "cancelled");
    });
    await test("normal lifecycle new -> processing -> shipped -> delivered moves no stock", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        for (const status of ["processing", "shipped", "delivered"]) {
            assert.strictEqual((await setStatus(sellerA, id, status)).statusCode, 200, status);
            assert.strictEqual(stockOf(p), 6);
        }
    });
    await test("security: another seller, the buyer and an invalid status/id cannot cancel or change the order", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        assert.strictEqual((await setStatus(sellerB, id, "cancelled")).statusCode, 404);
        assert.strictEqual((await setStatus(buyer._id, id, "cancelled")).statusCode, 404);
        assert.strictEqual((await setStatus(sellerA, id, "refunded")).statusCode, 400);
        assert.strictEqual((await setStatus(sellerA, "nope", "cancelled")).statusCode, 400);
        const injected = res();
        await updateStatus(sellerReq(sellerA, { order_id: { $ne: null }, status_order: "cancelled" }), injected);
        assert.strictEqual(injected.statusCode, 400, "NoSQL operator object as order_id must be rejected");
        assert.strictEqual(stored()[0].status, "new");
        assert.strictEqual(stockOf(p), 6);
    });

    // ===================================================================================== 6
    out("\n=== 6. Delete order ===");
    await test("deleting an ACTIVE order restores its stock once; deleting it again is a 404 and restores nothing", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        assert.strictEqual((await removeOrder(sellerA, id)).statusCode, 200);
        assert.strictEqual(stored().length, 0);
        assert.strictEqual(stockOf(p), 10);
        assert.strictEqual((await removeOrder(sellerA, id)).statusCode, 404);
        assert.strictEqual(stockOf(p), 10);
        assert.strictEqual(archived.length, 1, "order snapshot is archived before removal");
    });
    await test("deleting a CANCELLED order does not restore stock a second time", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        await setStatus(sellerA, id, "cancelled");
        assert.strictEqual(stockOf(p), 10);
        assert.strictEqual((await removeOrder(sellerA, id)).statusCode, 200);
        assert.strictEqual(stored().length, 0);
        assert.strictEqual(stockOf(p), 10, "stock must still be 10, not 14");
    });
    await test("deleting a DELIVERED order does not restore stock (goods were sold)", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        await setStatus(sellerA, id, "delivered");
        assert.strictEqual((await removeOrder(sellerA, id)).statusCode, 200);
        assert.strictEqual(stockOf(p), 6);
    });
    await test("cancel racing delete: cancel lands between delete's read and delete's write -> stock restored exactly once", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        hooks.beforeOrderDelete = async () => {
            hooks.beforeOrderDelete = null;
            assert.strictEqual((await setStatus(sellerA, id, "cancelled")).statusCode, 200);
        };
        const r = await removeOrder(sellerA, id);
        assert.strictEqual(r.statusCode, 200);
        assert.strictEqual(stored().length, 0);
        assert.strictEqual(stockOf(p), 10, "restored once (by cancel), not again by delete");
    });
    await test("Promise.all(cancel, delete) on the same order never restores stock twice", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        await Promise.all([setStatus(sellerA, id, "cancelled"), removeOrder(sellerA, id)]);
        assert.strictEqual(stockOf(p), 10);
    });
    await test("concurrent double delete restores stock exactly once", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        const results = await Promise.all([removeOrder(sellerA, id), removeOrder(sellerA, id)]);
        assert.ok(results.some((r) => r.statusCode === 200));
        assert.strictEqual(stockOf(p), 10);
        assert.strictEqual(stored().length, 0);
    });
    await test("security: another seller cannot delete the order; invalid ids rejected; nothing changes", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 4)]);
        assert.strictEqual((await removeOrder(sellerB, id)).statusCode, 404);
        assert.strictEqual((await removeOrder(sellerA, "short")).statusCode, 400);
        const injected = res();
        await deleteOrder(sellerReq(sellerA, { order_id: { $ne: null } }), injected);
        assert.strictEqual(injected.statusCode, 400);
        assert.strictEqual(stored().length, 1);
        assert.strictEqual(stockOf(p), 6);
    });

    // ===================================================================================== 7
    out("\n=== 7. Failure after stock reservation ===");
    await test("order persistence fails (non-duplicate error) after reservation -> 500 and stock fully restored", async () => {
        reset();
        const a = product(sellerA, { quantity: 5 });
        const b = product(sellerA, { quantity: 8 });
        FakeProducts.__seed([a, b]);
        let reservedWhenSaving = null;
        hooks.beforeOrderSave = async () => {
            reservedWhenSaving = [stockOf(a), stockOf(b)];
            throw new Error("database connection lost");
        };
        const r = await place([line(a, 2), line(b, 3)]);
        assert.deepStrictEqual(reservedWhenSaving, [3, 5], "stock really was reserved when the failure happened");
        assert.strictEqual(r.statusCode, 500);
        assert.strictEqual(stockOf(a), 5);
        assert.strictEqual(stockOf(b), 8);
        assert.strictEqual(stored().length, 0);
    });
    await test("a stock-update error on one product rolls back the reservations that already succeeded", async () => {
        reset();
        const a = product(sellerA, { quantity: 5 });
        const b = product(sellerA, { quantity: 5 });
        FakeProducts.__seed([a, b]);
        FakeProducts.__beforeFindOneAndUpdate = async (filter) => {
            if (String(filter._id) === String(b._id)) throw new Error("write failed");
        };
        const r = await place([line(a, 2), line(b, 2)]);
        assert.strictEqual(r.statusCode, 500);
        assert.strictEqual(stockOf(a), 5);
        assert.strictEqual(stockOf(b), 5);
        assert.strictEqual(stored().length, 0);
    });
    await test("failure AFTER the order is saved (socket emit throws) keeps the order AND its stock reservation", async () => {
        reset();
        const p = product(sellerA, { quantity: 5 });
        FakeProducts.__seed([p]);
        const io = { to: () => { throw new Error("socket down"); } };
        const r = await place([line(p, 2)], { io });
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(stored().length, 1);
        assert.strictEqual(stockOf(p), 3, "stock must stay reserved - the order exists");
    });
    await test("coupon validation failure leaves stock untouched (validated before reservation)", async () => {
        reset();
        const p = product(sellerA, { quantity: 5 });
        FakeProducts.__seed([p]);
        const r = await place([line(p, 2)], { body: { coupon: "NOPE" } });
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(p), 5);
    });

    // ===================================================================================== 8
    out("\n=== 8. Idempotency ===");
    await test("repeating the same request with the same key returns the SAME order and has no second effect", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const io = ioSpy();
        const first = await place([line(p, 2)], { key: "order-abc-1", io });
        const second = await place([line(p, 2)], { key: "order-abc-1", io });
        assert.strictEqual(first.statusCode, 201);
        assert.strictEqual(second.statusCode, 200);
        assert.strictEqual(storedIdOf(second), storedIdOf(first));
        assert.strictEqual(stored().length, 1);
        assert.strictEqual(stockOf(p), 8, "stock deducted once");
        assert.strictEqual(io.emitted.filter((e) => e.event === "new_order" && e.room === "admins").length, 1, "admins notified once");
    });
    await test("N concurrent identical requests (same key) create ONE order and deduct stock ONCE", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const results = await Promise.all(Array.from({ length: 4 }, () => place([line(p, 2)], { key: "race-key" })));
        assert.strictEqual(stored().length, 1);
        assert.strictEqual(stockOf(p), 8);
        assert.deepStrictEqual(results.map((r) => r.statusCode).sort(), [200, 200, 200, 201]);
        const ids = new Set(results.map(storedIdOf));
        assert.strictEqual(ids.size, 1, "every caller gets the same order");
    });
    await test("current behaviour: a replayed key returns the ORIGINAL order even if the payload differs (no payload fingerprint)", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        await place([line(p, 2)], { key: "k-1" });
        const replay = await place([line(p, 5)], { key: "k-1" });
        assert.strictEqual(replay.statusCode, 200);
        assert.strictEqual(replay.body.data.products[0].quantity, 2);
        assert.strictEqual(stockOf(p), 8);
    });
    await test("without a key, two identical requests are two separate orders (idempotency is opt-in)", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        await place([line(p, 2)]);
        await place([line(p, 2)]);
        assert.strictEqual(stored().length, 2);
        assert.strictEqual(stockOf(p), 6);
    });
    await test("repeating a cancel/status request is idempotent in effect (second one 409, no extra stock)", async () => {
        reset();
        const p = product(sellerA, { quantity: 10 });
        FakeProducts.__seed([p]);
        const id = await orderFor([line(p, 3)]);
        await setStatus(sellerA, id, "processing");
        assert.strictEqual((await setStatus(sellerA, id, "processing")).statusCode, 409);
        await setStatus(sellerA, id, "cancelled");
        await setStatus(sellerA, id, "cancelled");
        assert.strictEqual(stockOf(p), 10);
    });

    // ===================================================================================== 9
    out("\n=== 9. Money calculations (integer cents) ===");
    const priced = async (items, body = {}) => {
        const r = await place(items, { body });
        assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
        return stored()[stored().length - 1];
    };
    await test("0.1 + 0.2 style sums: 0.10 + 0.20 totals exactly 0.30 (float sum would be 0.30000000000000004)", async () => {
        reset();
        const a = product(sellerA, { price: 0.1 });
        const b = product(sellerA, { price: 0.2 });
        FakeProducts.__seed([a, b]);
        const o = await priced([line(a), line(b)]);
        assert.strictEqual(0.1 + 0.2 === 0.3, false, "sanity: this really is a float trap");
        assert.strictEqual(o.total_price, 0.3);
        assert.strictEqual(cents(o.total_price), 30);
    });
    await test("0.10 x 3 = 0.30 and 1.15 x 3 = 3.45 (naive float products give 0.30000000000000004 / 3.4499999999999997)", async () => {
        reset();
        const a = product(sellerA, { price: 0.1 });
        const b = product(sellerA, { price: 1.15 });
        FakeProducts.__seed([a, b]);
        const o1 = await priced([line(a, 3)]);
        assert.strictEqual(o1.total_price, 0.3);
        const o2 = await priced([line(b, 3)]);
        assert.strictEqual(o2.total_price, 3.45);
        assert.notStrictEqual(1.15 * 3, 3.45, "sanity: naive float multiplication is wrong here");
    });
    await test("ten items of 0.10 total exactly 1.00 (naive running sum gives 0.9999999999999999)", async () => {
        reset();
        const ps = Array.from({ length: 10 }, () => product(sellerA, { price: 0.1 }));
        FakeProducts.__seed(ps);
        const o = await priced(ps.map((p) => line(p)));
        assert.strictEqual(o.total_price, 1);
    });
    await test("19.99 x 3 with a 15% product discount = 50.97 in cents (1999*85/100 -> 1699 per unit)", async () => {
        reset();
        const p = product(sellerA, { price: 19.99, discount: 15 });
        FakeProducts.__seed([p]);
        const o = await priced([line(p, 3)]);
        assert.strictEqual(o.products[0].price, 16.99);
        assert.strictEqual(o.total_price, 50.97);
    });
    await test("coupon on a float-trap total: 3 x 19.99 (59.97) with 50% coupon = 29.99 (2998.5 cents, half-up)", async () => {
        reset();
        const p = product(sellerA, { price: 19.99 });
        FakeProducts.__seed([p]);
        FakeCoupons.__seed([coupon(sellerA, { name: "HALF", discount: 50 })]);
        const o = await priced([line(p, 3)], { coupon: "HALF" });
        assert.strictEqual(o.subtotal_before_coupon, 59.97);
        assert.strictEqual(o.total_price, 29.99);
    });
    await test("stored money is whole cents: every price and total satisfies round(x*100)/100 === x", async () => {
        reset();
        const p = product(sellerA, { price: 33.33, discount: 33, quantity: 100 });
        FakeProducts.__seed([p]);
        FakeCoupons.__seed([coupon(sellerA, { discount: 7 })]);
        const o = await priced([line(p, 7)], { coupon: "SAVE10" });
        for (const value of [o.total_price, o.subtotal_before_coupon, o.products[0].price]) {
            assert.strictEqual(Math.round(value * 100) / 100, value, `${value} is not a whole number of cents`);
        }
    });
    // Exact half-cent ties (e.g. 2559.945) are the one place where float arithmetic and exact integer
    // arithmetic can disagree, so they are tested separately below. The sweep covers every other basket.
    await test("sweep: 600 random baskets (prices, quantities, product discounts, coupons) match an exact integer-cent reference", async () => {
        let seed = 20261003; // deterministic PRNG so failures are reproducible
        const rnd = (n) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
        const halfUp = (num, den) => Math.floor((2 * num + den) / (2 * den)); // integer round-half-up of num/den
        const discounts = [0, 5, 10, 15, 25, 33, 50];
        const couponRates = [0, 10, 25, 50, 100];
        const mismatches = [];
        let compared = 0;
        for (let i = 0; i < 600; i++) {
            reset();
            const lines = Array.from({ length: 1 + rnd(4) }, () => ({ priceCents: 1 + rnd(99999), discount: discounts[rnd(discounts.length)], qty: 1 + rnd(9) }));
            const rate = couponRates[rnd(couponRates.length)];
            const unitNumerators = lines.map((l) => l.priceCents * (100 - l.discount));
            const unitCents = unitNumerators.map((n) => halfUp(n, 100));
            const subtotal = lines.reduce((s, l, k) => s + unitCents[k] * l.qty, 0);
            const couponNumerator = subtotal * (100 - rate);
            const hasTie = unitNumerators.some((n) => n % 100 === 50) || (rate > 0 && couponNumerator % 100 === 50);
            if (hasTie) continue; // covered by the explicit half-cent tie tests
            compared++;
            const prods = lines.map((l) => product(sellerA, { price: l.priceCents / 100, discount: l.discount, quantity: 100 }));
            FakeProducts.__seed(prods);
            if (rate) FakeCoupons.__seed([coupon(sellerA, { name: "SWEEP", discount: rate })]);
            const r = await place(prods.map((p, k) => line(p, lines[k].qty)), { body: rate ? { coupon: "SWEEP" } : {} });
            if (r.statusCode !== 201) { mismatches.push({ lines, rate, status: r.statusCode, message: r.body && r.body.message }); continue; }
            const expected = rate ? halfUp(couponNumerator, 100) : subtotal;
            const actual = cents(stored()[0].total_price);
            if (actual !== expected || stored()[0].products.some((item, k) => cents(item.price) !== unitCents[k])) {
                mismatches.push({ lines, rate, expectedCents: expected, actualCents: actual });
            }
        }
        assert.ok(compared >= 250, `sweep too small (${compared} baskets compared)`);
        assert.strictEqual(mismatches.length, 0, `${mismatches.length}/${compared} baskets differ from the integer-cent reference; first: ${JSON.stringify(mismatches[0])}`);
    });
    // DEFECT PROBES: an exact half-cent must round the same way every time (half-up here, like the rest of
    // the code's Math.round). The controller computes `price - price*discount/100` and
    // `total - subtotal*discount/100` in binary floating point, so some exact ties land a hair BELOW .5
    // and round down. These tests fail until the discount maths is done in integer cents.
    await test("DEFECT PROBE: product discount tie - 630.55 at 50% off is exactly 315.275 -> must round to 315.28", async () => {
        reset();
        const p = product(sellerA, { price: 630.55, discount: 50 });
        FakeProducts.__seed([p]);
        const o = await priced([line(p, 1)]);
        assert.strictEqual(o.products[0].price, 315.28, `unit price stored as ${o.products[0].price}; float calc gives ${630.55 - (630.55 * 50) / 100}`);
        assert.strictEqual(o.total_price, 315.28);
    });
    await test("DEFECT PROBE: coupon tie - basket of 25.09x2 + 991.35x4 (both 15% off) = 3413.26; a 25% coupon is exactly 2559.945 -> must round to 2559.95", async () => {
        reset();
        const a = product(sellerA, { price: 25.09, discount: 15 });
        const b = product(sellerA, { price: 991.35, discount: 15 });
        FakeProducts.__seed([a, b]);
        FakeCoupons.__seed([coupon(sellerA, { name: "QUARTER", discount: 25 })]);
        const o = await priced([line(a, 2), line(b, 4)], { coupon: "QUARTER" });
        assert.strictEqual(o.total_price, 2559.95, `total stored as ${o.total_price}`);
    });
    await test("DEFECT PROBE: subtotal_before_coupon is stored as whole cents (same basket currently persists 3413.2599999999998)", async () => {
        reset();
        const a = product(sellerA, { price: 25.09, discount: 15 });
        const b = product(sellerA, { price: 991.35, discount: 15 });
        FakeProducts.__seed([a, b]);
        FakeCoupons.__seed([coupon(sellerA, { name: "QUARTER", discount: 25 })]);
        const o = await priced([line(a, 2), line(b, 4)], { coupon: "QUARTER" });
        assert.strictEqual(o.subtotal_before_coupon, 3413.26, `subtotal stored as ${o.subtotal_before_coupon}`);
    });

    // ===================================================================================== 10
    out("\n=== 10. Coupons ===");
    const couponCase = async (couponDoc, code, itemSeller = sellerA) => {
        reset();
        const p = product(itemSeller, { price: 100, quantity: 5 });
        FakeProducts.__seed([p]);
        if (couponDoc) FakeCoupons.__seed([couponDoc]);
        const r = await place([line(p, 2)], { body: { coupon: code } });
        return { r, p };
    };
    await test("expired coupon is rejected; no order, stock untouched", async () => {
        const { r, p } = await couponCase(coupon(sellerA, { end_time: new Date(Date.now() - 1000) }), "SAVE10");
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(p), 5);
        assert.strictEqual(stored().length, 0);
    });
    await test("coupon expiring exactly now is treated as expired", async () => {
        const { r, p } = await couponCase(coupon(sellerA, { end_time: new Date(Date.now()) }), "SAVE10");
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(p), 5);
    });
    await test("coupon belonging to ANOTHER seller is rejected for this seller's product", async () => {
        const { r, p } = await couponCase(coupon(sellerB), "SAVE10", sellerA);
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(p), 5);
        assert.strictEqual(stored().length, 0);
    });
    await test("nonexistent coupon is rejected; no order, stock untouched", async () => {
        const { r, p } = await couponCase(null, "DOESNOTEXIST");
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(p), 5);
        assert.strictEqual(stored().length, 0);
    });
    await test("100% coupon yields a total of 0 and records the coupon on the order", async () => {
        const { r, p } = await couponCase(coupon(sellerA, { name: "FREE", discount: 100 }), "free");
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(stored()[0].total_price, 0);
        assert.strictEqual(stored()[0].subtotal_before_coupon, 200);
        assert.strictEqual(stored()[0].coupon_code, "FREE");
        assert.strictEqual(stored()[0].coupon_discount_percent, 100);
        assert.strictEqual(stockOf(p), 3);
    });
    await test("valid coupon of the right seller applies; code lookup is case-insensitive and trimmed", async () => {
        const { r } = await couponCase(coupon(sellerA, { name: "SAVE10", discount: 10 }), "  save10 ");
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(stored()[0].total_price, 180);
    });
    await test("client cannot inflate a coupon: discount/seller values in the body are ignored", async () => {
        reset();
        const p = product(sellerA, { price: 100, quantity: 5 });
        FakeProducts.__seed([p]);
        FakeCoupons.__seed([coupon(sellerA, { discount: 10 })]);
        const r = await place([line(p, 1)], { body: { coupon: "SAVE10", coupon_discount: 100, discount: 100, coupon_seller_id: String(sellerB) } });
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(stored()[0].total_price, 90);
    });
    await test("coupon with an out-of-range stored discount (150) is rejected", async () => {
        const { r, p } = await couponCase(coupon(sellerA, { discount: 150 }), "SAVE10");
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(p), 5);
    });
    await test("coupon whose owner is no longer a seller is rejected", async () => {
        reset();
        const p = product(sellerA, { price: 100, quantity: 5 });
        FakeProducts.__seed([p]);
        FakeUsers.__docs.find((u) => String(u._id) === String(sellerA)).role = "user";
        FakeCoupons.__seed([coupon(sellerA)]);
        const r = await place([line(p, 1)], { body: { coupon: "SAVE10" } });
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(p), 5);
    });
    await test("non-string coupon values are ignored (no discount, no crash)", async () => {
        reset();
        const p = product(sellerA, { price: 100, quantity: 5 });
        FakeProducts.__seed([p]);
        FakeCoupons.__seed([coupon(sellerA)]);
        const r = await place([line(p, 1)], { body: { coupon: { $ne: null } } });
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(stored()[0].total_price, 100);
        assert.strictEqual(stored()[0].coupon_code, undefined);
    });

    // ===================================================================================== 11
    out("\n=== 11. Seller buying their own product ===");
    // Intended behaviour, taken from controller/order.controller.js ("You cannot order your own product").
    await test("a seller ordering their OWN product is rejected: 400, no stock change, no order", async () => {
        reset();
        const p = product(sellerA, { quantity: 5 });
        FakeProducts.__seed([p]);
        const sellerAsBuyer = { ...mkBuyer("Seller A"), _id: sellerA, role: "seller" };
        const r = await place([line(p, 1)], { user: sellerAsBuyer });
        assert.strictEqual(r.statusCode, 400);
        assert.match(r.body.message, /own product/i);
        assert.strictEqual(stockOf(p), 5);
        assert.strictEqual(stored().length, 0);
    });
    await test("own-product rule applies per line: a mixed cart containing the seller's own product is rejected without reserving anything", async () => {
        reset();
        const own = product(sellerA, { quantity: 5 });
        const other = product(sellerB, { quantity: 5 });
        FakeProducts.__seed([own, other]);
        const sellerAsBuyer = { ...mkBuyer("Seller A"), _id: sellerA, role: "seller" };
        const r = await place([line(other, 1), line(own, 1)], { user: sellerAsBuyer });
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(own), 5);
        assert.strictEqual(stockOf(other), 5);
        assert.strictEqual(stored().length, 0);
    });
    await test("the rule is about OWNERSHIP, not role: the same seller account can still buy ANOTHER seller's product", async () => {
        reset();
        const other = product(sellerB, { quantity: 5 });
        FakeProducts.__seed([other]);
        const sellerAsBuyer = { ...mkBuyer("Seller A"), _id: sellerA, role: "seller" };
        const r = await place([line(other, 1)], { user: sellerAsBuyer });
        assert.strictEqual(r.statusCode, 201);
        assert.strictEqual(stockOf(other), 4);
    });
    await test("own-product rule cannot be bypassed by a client-supplied seller_id", async () => {
        reset();
        const own = product(sellerA, { quantity: 5 });
        FakeProducts.__seed([own]);
        const sellerAsBuyer = { ...mkBuyer("Seller A"), _id: sellerA, role: "seller" };
        const r = await place([{ id: String(own._id), quantity: 1, seller_id: String(sellerB) }], { user: sellerAsBuyer, body: { seller_id: String(sellerB) } });
        assert.strictEqual(r.statusCode, 400);
        assert.strictEqual(stockOf(own), 5);
    });

    out(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
})().catch((error) => {
    out(`UNEXPECTED ERROR: ${error.stack}`);
    process.exitCode = 1;
});