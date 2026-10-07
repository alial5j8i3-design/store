// Order status transitions, seller authorization / ownership, deletion and archive-before-delete.
//
//   node tests/status_and_delete_order.test.js
//
// What is REAL here: Express, cookie-parser, jsonwebtoken, the real routers
// (routes/update_status.router.js, routes/delete_order.router.js), the real auth_seller middleware
// (JWT cookie -> user looked up in the database -> role must be "seller"), the real controllers
// (update_status_of_order / delete_order) and the real utils/order_stock.js
// (ALLOWED_STATUSES / ALLOWED_TRANSITIONS / ACTIVE_STATUSES / previousStatusesFor / restoreOrderItems).
//
// What is FAKED: the Mongoose models. They are the project's strict in-memory fakes
// (tests/phase1/mock_models.js) built from the REAL schemas of models/order.js, models/products.js,
// models/users.js and models/order_archive.js, so declared paths are cast/validated like Mongoose does.
//
// LIMITATION (same as every other offline suite in this project): nothing here talks to a real
// MongoDB. A small shim on the orders/archive fakes emulates what these flows rely on:
//   * `timestamps: true`  (updatedAt bumped on findOneAndUpdate)  -> optimistic lock in delete_order
//   * the UNIQUE index { order_id, order_updated_at } of models/order_archive.js (E11000 on duplicates)
// Index enforcement and atomicity are therefore emulated, not proven against a real database.
// Section 8 asserts that the real schema DECLARES that unique index.
//
// The transition table is NOT re-invented here: valid / invalid pairs are derived from the
// application's own ALLOWED_TRANSITIONS, and a separate "contract" test pins that table so an
// accidental change to it is noticed.
//
// The JWT secret is generated randomly at runtime - no secret is stored in this file.
const assert = require("assert");
const path = require("path");
const crypto = require("crypto");

process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");

const { makeFakeModel, realSchema, ObjectId } = require("./phase1/mock_models");

const PROJECT = path.join(__dirname, "..");

// Real schemas must be loaded BEFORE any fake is injected into require.cache.
const OrderModel = realSchema("order");
const ArchiveModel = realSchema("order_archive");
const FakeProducts = makeFakeModel("products", { schema: realSchema("products") });
const FakeOrders = makeFakeModel("orders", { schema: OrderModel, uniqueFields: ["orderNumber"] });
const FakeArchive = makeFakeModel("order_archive", { schema: ArchiveModel, uniqueIndexes: [{ fields: ["order_id", "order_updated_at"] }] });
const FakeUsers = makeFakeModel("user", { schema: realSchema("users") });

// ---- shims -----------------------------------------------------------------------------------
let clock = Date.now();
const tick = () => new Date(++clock);

// Ordered log of archive writes and destructive order writes (delete / $pull).
const events = [];
const hooks = { beforeDelete: null, beforePull: null };
const archiveControl = { failWith: null };
const archiveSeen = () => FakeArchive.__docs.map((a) => ({ order_id: String(a.order_id), v: +a.order_updated_at }));

const rawFindOneAndUpdate = FakeOrders.findOneAndUpdate;
FakeOrders.findOneAndUpdate = (filter, update, opts) => {
    const hasOps = Object.keys(update || {}).some((k) => k.startsWith("$"));
    const stamped = hasOps ? { ...update, $set: { ...(update.$set || {}), updatedAt: tick() } } : { $set: { ...update, updatedAt: tick() } };
    const query = rawFindOneAndUpdate(filter, stamped, opts);
    if (!(update && update.$pull)) return query;
    // Partial removal ($pull) is destructive: log it, at EXECUTION time, with the archive state at that moment.
    return {
        then(resolve, reject) {
            return (async () => {
                events.push({ kind: "pull", seller: update.$pull.products && update.$pull.products.seller_id, archived: archiveSeen() });
                if (hooks.beforePull) await hooks.beforePull(filter, update);
                return query;
            })().then(resolve, reject);
        },
    };
};
const rawFindOneAndDelete = FakeOrders.findOneAndDelete;
FakeOrders.findOneAndDelete = async (filter) => {
    events.push({ kind: "delete", archived: archiveSeen() });
    if (hooks.beforeDelete) await hooks.beforeDelete(filter);
    return rawFindOneAndDelete(filter);
};

// models/order_archive.js declares unique { order_id, order_updated_at }: enforced by the fake (E11000).
const archiveModel = {
    create: async (doc) => {
        events.push({ kind: "archive", order_id: String(doc.order_id) });
        if (archiveControl.failWith) throw archiveControl.failWith;
        return FakeArchive.create(doc); // the fake enforces the unique { order_id, order_updated_at } index with strict types
    },
};

function inject(rel, exportsValue) {
    const abs = require.resolve(path.join(PROJECT, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsValue };
}
inject("models/products.js", FakeProducts);
inject("models/order.js", FakeOrders);
inject("models/users.js", FakeUsers);
inject("models/order_archive.js", archiveModel);
inject("utils/cache.js", { delByPrefix: async () => {} });

const { ALLOWED_STATUSES, ALLOWED_TRANSITIONS, ACTIVE_STATUSES, previousStatusesFor } = require(path.join(PROJECT, "utils/order_stock.js"));
const { signToken } = require(path.join(PROJECT, "utils/jwt.js"));
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const state = { io: null };
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use((req, _res, next) => { req.io = state.io; next(); });
app.use(require(path.join(PROJECT, "routes/update_status.router.js")));
app.use(require(path.join(PROJECT, "routes/delete_order.router.js")));

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
const mkUser = (name, role) => ({ _id: new ObjectId(), name, email: `${name}@t.test`, role });
const sellerA = mkUser("sellerA", "seller");
const sellerB = mkUser("sellerB", "seller");
const buyer = mkUser("buyer", "user");
const admin = mkUser("admin", "super_admin");

function ioSpy({ throwOnTo = false } = {}) {
    const emitted = [];
    return {
        emitted,
        to: (room) => {
            if (throwOnTo) throw new Error("socket down");
            return { emit: (event, payload) => emitted.push({ room, event, payload }) };
        },
    };
}

function reset() {
    FakeProducts.__docs.splice(0);
    FakeOrders.__docs.splice(0);
    FakeArchive.__docs.splice(0);
    FakeUsers.__docs.splice(0);
    events.splice(0);
    hooks.beforeDelete = null;
    hooks.beforePull = null;
    archiveControl.failWith = null;
    FakeProducts.__beforeFindOneAndUpdate = null;
    FakeUsers.__seed([sellerA, sellerB, buyer, admin].map((u) => ({ ...u })));
    state.io = ioSpy();
}

let seq = 0;
const product = (seller, extra = {}) => ({
    _id: new ObjectId(), seller_id: seller._id, store_id: new ObjectId(), name: `Used item ${++seq}`, price: 100, discount: 0,
    quantity: 5, images: ["https://images.test/p.jpg"], section: new ObjectId(), description: "good", ...extra,
});

// lines: [{ p, seller, quantity }]. The stock in the product doc is the stock AFTER the reservation
// (the order was created earlier and already deducted it), so a restore is +quantity.
function seedOrder(lines, { status = "new", total } = {}) {
    const items = lines.map(({ p, seller, quantity = 1 }) => ({
        _id: new ObjectId(), product: p._id, seller_id: String(seller._id), name: p.name, price: p.price, quantity, images: [],
    }));
    const subtotal = items.reduce((s, l) => s + l.price * l.quantity, 0);
    const doc = {
        _id: new ObjectId(), user_id: String(buyer._id), orderNumber: `ORD-${++seq}`, products: items,
        total_price: total === undefined ? subtotal : total, user_name: buyer.name, phone_number: "0100000000",
        GPS_URL: "https://maps.test/l", whatsApp_number: "0100000000", status, createdAt: tick(), updatedAt: tick(),
    };
    FakeOrders.__seed([doc]);
    return doc;
}
// One seller, one product (stock 5 after reservation), one line of `qty` units.
function soleOrder(seller, { status = "new", qty = 2, stock = 5 } = {}) {
    const p = product(seller, { quantity: stock });
    FakeProducts.__seed([p]);
    return { p, order: seedOrder([{ p, seller, quantity: qty }], { status }) };
}
// A LEGACY order holding items of two sellers (creation of such orders is rejected today, but they exist in old data).
function mixedOrder({ status = "new", total } = {}) {
    const pa = product(sellerA, { quantity: 5, price: 100 });
    const pb = product(sellerB, { quantity: 5, price: 50 });
    FakeProducts.__seed([pa, pb]);
    const order = seedOrder([{ p: pa, seller: sellerA, quantity: 1 }, { p: pb, seller: sellerB, quantity: 2 }], { status, total });
    return { pa, pb, order };
}

const stored = (o) => FakeOrders.__docs.find((d) => String(d._id) === String(o._id));
const stock = (p) => FakeProducts.__docs.find((d) => String(d._id) === String(p._id)).quantity;
const plain = (v) => JSON.parse(JSON.stringify(v));
const dbState = () => JSON.stringify({ orders: FakeOrders.__docs, products: FakeProducts.__docs, archive: FakeArchive.__docs });
const archivesOf = (o) => FakeArchive.__docs.filter((a) => String(a.order_id) === String(o._id));

// ---- HTTP helpers ----------------------------------------------------------------------------
const STATUS_URL = "/api/seller/update_status_of_order";
const DELETE_URL = "/api/seller/delete_order";
let base;
const cookieFor = (u) => `token=${signToken({ id: String(u._id) })}`;
async function call(method, url, { as, body, cookie } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (as) headers.Cookie = cookieFor(as);
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await r.json(); } catch (_) { /* empty body */ }
    return { status: r.status, body: json };
}
const setStatus = (as, order, status_order, extra = {}) => call("PUT", STATUS_URL, { as, body: { order_id: String(order._id), status_order, ...extra } });
const removeOrder = (as, order, extra = {}) => call("DELETE", DELETE_URL, { as, body: { order_id: String(order._id), ...extra } });
const rawStatus = (as, body) => call("PUT", STATUS_URL, { as, body });
const rawDelete = (as, body) => call("DELETE", DELETE_URL, { as, body });

const T = ALLOWED_TRANSITIONS;
const VALID = ALLOWED_STATUSES.flatMap((from) => T[from].map((to) => [from, to]));
const INVALID = ALLOWED_STATUSES.flatMap((from) => ALLOWED_STATUSES.filter((to) => !T[from].includes(to)).map((to) => [from, to]));
const sorted = (a) => [...a].sort();

(async () => {
    const server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;

    // ===================================================================================== 1
    out("\n=== 1. ALLOWED_TRANSITIONS definition (discovered from utils/order_stock.js) ===");
    await test("transition table covers exactly the statuses of the order schema enum", () => {
        const schemaEnum = OrderModel.schema.path("status").options.enum;
        assert.deepStrictEqual(sorted(ALLOWED_STATUSES), sorted(schemaEnum));
        assert.deepStrictEqual(sorted(Object.keys(T)), sorted(ALLOWED_STATUSES));
        for (const from of Object.keys(T)) for (const to of T[from]) assert.ok(ALLOWED_STATUSES.includes(to), `${from} -> ${to}: unknown target status`);
    });
    await test("contract: the table equals the documented lifecycle (change it deliberately, never by accident)", () => {
        const expected = {
            new: ["processing", "shipped", "delivered", "cancelled"],
            processing: ["shipped", "delivered", "cancelled"],
            shipped: ["delivered", "cancelled"],
            delivered: [],
            cancelled: [],
        };
        assert.deepStrictEqual(Object.keys(T).sort(), Object.keys(expected).sort());
        for (const from of Object.keys(expected)) assert.deepStrictEqual(sorted(T[from]), sorted(expected[from]), `transitions out of "${from}"`);
    });
    await test("delivered and cancelled are final; nothing may move back to \"new\"", () => {
        assert.deepStrictEqual(T.delivered, []);
        assert.deepStrictEqual(T.cancelled, []);
        assert.deepStrictEqual(previousStatusesFor("new"), []);
        assert.ok(ALLOWED_STATUSES.every((s) => !T[s].includes("new")));
    });
    await test("previousStatusesFor() is the exact inverse of the table (it feeds the atomic DB filter)", () => {
        for (const s of ALLOWED_STATUSES) assert.deepStrictEqual(sorted(previousStatusesFor(s)), sorted(ALLOWED_STATUSES.filter((f) => T[f].includes(s))), `previous of "${s}"`);
    });
    await test("ACTIVE_STATUSES (stock still reserved) are exactly the non-final statuses", () => {
        assert.deepStrictEqual(sorted(ACTIVE_STATUSES), sorted(ALLOWED_STATUSES.filter((s) => T[s].length > 0)));
    });

    // ===================================================================================== 2
    out(`\n=== 2. Every valid transition (${VALID.length}) ===`);
    for (const [from, to] of VALID) {
        await test(`${from} -> ${to}: 200, status stored, only status/updatedAt change, stock ${to === "cancelled" ? "restored once" : "untouched"}`, async () => {
            reset();
            const { p, order } = soleOrder(sellerA, { status: from, qty: 2, stock: 5 });
            const before = plain(stored(order));
            const beforeUpdatedAt = +stored(order).updatedAt;

            const r = await setStatus(sellerA, order, to);
            assert.strictEqual(r.status, 200, JSON.stringify(r.body));
            assert.strictEqual(r.body.success, true);
            assert.strictEqual(r.body.data.status, to);
            assert.strictEqual(String(r.body.data._id), String(order._id));

            const after = stored(order);
            assert.strictEqual(after.status, to);
            assert.ok(+after.updatedAt > beforeUpdatedAt, "updatedAt must advance");
            const strip = ({ status, updatedAt, ...rest }) => rest;
            assert.deepStrictEqual(strip(plain(after)), strip(before), "nothing except status/updatedAt may change");
            assert.strictEqual(stock(p), to === "cancelled" ? 7 : 5);

            assert.strictEqual(state.io.emitted.length, 1);
            const e = state.io.emitted[0];
            assert.strictEqual(e.room, `user:${buyer._id}`);
            assert.strictEqual(e.event, "update_status");
            assert.deepStrictEqual(Object.keys(e.payload).sort(), ["_id", "orderNumber", "status"], "buyer payload must carry no private fields");
            assert.strictEqual(e.payload.status, to);
        });
    }
    await test("full happy path new -> processing -> shipped -> delivered never touches stock, then delivered is final", async () => {
        reset();
        const { p, order } = soleOrder(sellerA);
        for (const s of ["processing", "shipped", "delivered"]) assert.strictEqual((await setStatus(sellerA, order, s)).status, 200, s);
        assert.strictEqual(stored(order).status, "delivered");
        assert.strictEqual(stock(p), 5);
        assert.strictEqual((await setStatus(sellerA, order, "cancelled")).status, 409);
        assert.strictEqual(stock(p), 5, "cancelling a delivered order must not give stock back");
    });
    await test("cancelling restores EVERY line of the order exactly once", async () => {
        reset();
        const p1 = product(sellerA, { quantity: 1 });
        const p2 = product(sellerA, { quantity: 4 });
        FakeProducts.__seed([p1, p2]);
        const order = seedOrder([{ p: p1, seller: sellerA, quantity: 2 }, { p: p2, seller: sellerA, quantity: 3 }]);
        assert.strictEqual((await setStatus(sellerA, order, "cancelled")).status, 200);
        assert.strictEqual(stock(p1), 3);
        assert.strictEqual(stock(p2), 7);
    });

    // ===================================================================================== 3
    out(`\n=== 3. Every invalid transition (${INVALID.length}) is refused without ANY write ===`);
    for (const [from, to] of INVALID) {
        await test(`${from} -> ${to}: 409, order/stock/archive byte-for-byte unchanged, no socket event`, async () => {
            reset();
            const { p, order } = soleOrder(sellerA, { status: from });
            const before = dbState();
            const r = await setStatus(sellerA, order, to);
            assert.strictEqual(r.status, 409, JSON.stringify(r.body));
            assert.strictEqual(r.body.success, false);
            assert.ok(r.body.message.includes(`"${from}"`) && r.body.message.includes(`"${to}"`), r.body.message);
            assert.strictEqual(dbState(), before);
            assert.strictEqual(stock(p), 5);
            assert.strictEqual(state.io.emitted.length, 0);
        });
    }
    await test("second cancel is refused and the stock is restored exactly once", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { qty: 2 });
        assert.strictEqual((await setStatus(sellerA, order, "cancelled")).status, 200);
        assert.strictEqual((await setStatus(sellerA, order, "cancelled")).status, 409);
        assert.strictEqual(stock(p), 7);
    });
    await test("two simultaneous cancels: exactly one wins, stock restored once", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { qty: 2 });
        const [r1, r2] = await Promise.all([setStatus(sellerA, order, "cancelled"), setStatus(sellerA, order, "cancelled")]);
        assert.deepStrictEqual([r1.status, r2.status].sort(), [200, 409]);
        assert.strictEqual(stock(p), 7);
    });
    await test("cancel racing with delivered: exactly one wins and stock matches the winner", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { qty: 2 });
        const [r1, r2] = await Promise.all([setStatus(sellerA, order, "cancelled"), setStatus(sellerA, order, "delivered")]);
        assert.deepStrictEqual([r1.status, r2.status].sort(), [200, 409]);
        assert.strictEqual(stock(p), stored(order).status === "cancelled" ? 7 : 5);
    });

    // ===================================================================================== 4
    out("\n=== 4. Status route input validation ===");
    const badStatusBodies = [
        ["missing order_id", (o) => ({ status_order: "cancelled" })],
        ["missing status_order", (o) => ({ order_id: String(o._id) })],
        ["empty order_id", (o) => ({ order_id: "", status_order: "cancelled" })],
        ["order_id too short", () => ({ order_id: "123", status_order: "cancelled" })],
        ["order_id 12 chars (valid for isValid(), not a 24-hex id)", () => ({ order_id: "abcdefabcdef", status_order: "cancelled" })],
        ["order_id numeric", () => ({ order_id: 123456789012345678901234, status_order: "cancelled" })],
        ["order_id NoSQL operator object", () => ({ order_id: { $ne: null }, status_order: "cancelled" })],
        ["order_id array", (o) => ({ order_id: [String(o._id)], status_order: "cancelled" })],
        ["unknown status \"refunded\"", (o) => ({ order_id: String(o._id), status_order: "refunded" })],
        ["status in wrong case \"Cancelled\"", (o) => ({ order_id: String(o._id), status_order: "Cancelled" })],
        ["status with trailing space", (o) => ({ order_id: String(o._id), status_order: "cancelled " })],
        ["status NoSQL operator object", (o) => ({ order_id: String(o._id), status_order: { $ne: "x" } })],
        ["status array", (o) => ({ order_id: String(o._id), status_order: ["cancelled"] })],
        ["status object-prototype name", (o) => ({ order_id: String(o._id), status_order: "constructor" })],
    ];
    for (const [name, build] of badStatusBodies) {
        await test(`400 and nothing changes: ${name}`, async () => {
            reset();
            const { order } = soleOrder(sellerA);
            const before = dbState();
            const r = await rawStatus(sellerA, build(order));
            assert.strictEqual(r.status, 400, JSON.stringify(r.body));
            assert.strictEqual(r.body.success, false);
            assert.strictEqual(dbState(), before);
        });
    }

    // ===================================================================================== 5
    out("\n=== 5. Authentication and role gate (real auth_seller middleware) ===");
    const forged = (payload, secret = process.env.JWT_SECRET, opts = { algorithm: "HS256" }) => `token=${jwt.sign(payload, secret, opts)}`;
    const gateCases = [
        ["no cookie -> 401", () => ({}), 401],
        ["garbage token -> 401", () => ({ cookie: "token=abc.def.ghi" }), 401],
        ["token signed with another secret -> 401", () => ({ cookie: forged({ id: String(sellerA._id) }, "some-other-secret") }), 401],
        ["expired token -> 401", () => ({ cookie: forged({ id: String(sellerA._id) }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: -10 }) }), 401],
        ["valid token of a user that no longer exists -> 401", () => ({ as: { _id: new ObjectId() } }), 401],
        ["buyer (role user) -> 403", () => ({ as: buyer }), 403],
        ["super_admin -> 403 (seller-only route)", () => ({ as: admin }), 403],
        ["buyer with a forged role:\"seller\" claim in the token -> 403 (role comes from the database)", () => ({ cookie: forged({ id: String(buyer._id), role: "seller" }) }), 403],
    ];
    for (const [name, build, expected] of gateCases) {
        await test(`status route: ${name}`, async () => {
            reset();
            const { p, order } = soleOrder(sellerA);
            const before = dbState();
            const r = await call("PUT", STATUS_URL, { ...build(), body: { order_id: String(order._id), status_order: "cancelled" } });
            assert.strictEqual(r.status, expected, JSON.stringify(r.body));
            assert.strictEqual(r.body.success, false);
            assert.strictEqual(dbState(), before);
            assert.strictEqual(stock(p), 5);
        });
        await test(`delete route: ${name}`, async () => {
            reset();
            const { p, order } = soleOrder(sellerA);
            const before = dbState();
            const r = await call("DELETE", DELETE_URL, { ...build(), body: { order_id: String(order._id) } });
            assert.strictEqual(r.status, expected, JSON.stringify(r.body));
            assert.strictEqual(r.body.success, false);
            assert.strictEqual(dbState(), before, "no order, stock or archive write");
            assert.strictEqual(stock(p), 5);
            assert.strictEqual(archivesOf(order).length, 0);
        });
    }
    await test("the buyer who PLACED the order still cannot change its status or delete it", async () => {
        reset();
        const { order } = soleOrder(sellerA);
        const before = dbState();
        assert.strictEqual((await setStatus(buyer, order, "cancelled")).status, 403);
        assert.strictEqual((await removeOrder(buyer, order)).status, 403);
        assert.strictEqual(dbState(), before);
    });
    await test("a seller demoted to user keeps a valid token but loses access immediately (403)", async () => {
        reset();
        const { order } = soleOrder(sellerA);
        const token = cookieFor(sellerA);
        FakeUsers.__docs.find((u) => String(u._id) === String(sellerA._id)).role = "user";
        const before = dbState();
        assert.strictEqual((await call("PUT", STATUS_URL, { cookie: token, body: { order_id: String(order._id), status_order: "cancelled" } })).status, 403);
        assert.strictEqual((await call("DELETE", DELETE_URL, { cookie: token, body: { order_id: String(order._id) } })).status, 403);
        assert.strictEqual(dbState(), before);
    });

    // ===================================================================================== 6
    out("\n=== 6. Seller ownership: a seller who owns no item of the order ===");
    await test("status: seller B on seller A's order -> 404, indistinguishable from an order that does not exist", async () => {
        reset();
        const { p, order } = soleOrder(sellerA);
        const before = dbState();
        const foreign = await setStatus(sellerB, order, "cancelled");
        const missing = await setStatus(sellerB, { _id: new ObjectId() }, "cancelled");
        assert.strictEqual(foreign.status, 404, JSON.stringify(foreign.body));
        assert.strictEqual(foreign.body.success, false);
        assert.deepStrictEqual(foreign.body.data, []);
        assert.deepStrictEqual(foreign, missing, "response for a foreign order must equal the response for a non-existent one");
        assert.strictEqual(dbState(), before);
        assert.strictEqual(stock(p), 5);
        assert.strictEqual(state.io.emitted.length, 0);
    });
    await test("delete: seller B on seller A's order -> 404, indistinguishable from an order that does not exist", async () => {
        reset();
        const { p, order } = soleOrder(sellerA);
        const before = dbState();
        const foreign = await removeOrder(sellerB, order);
        const missing = await removeOrder(sellerB, { _id: new ObjectId() });
        assert.strictEqual(foreign.status, 404, JSON.stringify(foreign.body));
        assert.strictEqual(foreign.body.success, false);
        assert.deepStrictEqual(foreign.body.data, []);
        assert.deepStrictEqual(foreign, missing);
        assert.strictEqual(dbState(), before);
        assert.strictEqual(stock(p), 5);
        assert.strictEqual(archivesOf(order).length, 0, "a refused request must not archive anything");
        assert.strictEqual(state.io.emitted.length, 0);
    });
    await test("non-owner gets 404 (not 409) even for a transition that would be illegal: the order's status is not leaked", async () => {
        reset();
        const { order } = soleOrder(sellerA, { status: "delivered" });
        const r = await setStatus(sellerB, order, "processing");
        assert.strictEqual(r.status, 404, JSON.stringify(r.body));
        assert.ok(!JSON.stringify(r.body).includes("delivered"));
    });
    await test("non-owner is refused for EVERY status value, valid or not", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { status: "new" });
        const before = dbState();
        for (const s of ALLOWED_STATUSES) assert.strictEqual((await setStatus(sellerB, order, s)).status, 404, s);
        assert.strictEqual(dbState(), before);
        assert.strictEqual(stock(p), 5);
    });
    await test("ownership is judged per order item: a seller with no line on the order is refused while the owner is served", async () => {
        reset();
        const { order } = soleOrder(sellerA);
        assert.strictEqual((await setStatus(sellerB, order, "processing")).status, 404);
        assert.strictEqual((await setStatus(sellerA, order, "processing")).status, 200);
    });

    // ===================================================================================== 7
    out("\n=== 7. Cross-seller access (seller A vs seller B) ===");
    await test("A acts on A's order only; B's order, B's stock and B's archive history are untouched", async () => {
        reset();
        const a = soleOrder(sellerA);
        const b = soleOrder(sellerB);
        const bBefore = JSON.stringify([stored(b.order), b.p]);
        assert.strictEqual((await setStatus(sellerA, a.order, "cancelled")).status, 200);
        assert.strictEqual((await removeOrder(sellerA, a.order)).status, 200);
        assert.strictEqual(JSON.stringify([stored(b.order), FakeProducts.__docs.find((d) => String(d._id) === String(b.p._id))]), bBefore);
        assert.strictEqual(archivesOf(b.order).length, 0);
        assert.strictEqual(stock(b.p), 5);
    });
    await test("A cannot modify, cancel (to restock) or delete B's order", async () => {
        reset();
        const b = soleOrder(sellerB);
        const before = dbState();
        for (const s of ALLOWED_STATUSES) assert.strictEqual((await setStatus(sellerA, b.order, s)).status, 404, s);
        assert.strictEqual((await removeOrder(sellerA, b.order)).status, 404);
        assert.strictEqual(dbState(), before);
        assert.strictEqual(stock(b.p), 5);
        assert.strictEqual(stored(b.order).status, "new");
    });
    await test("symmetry: B cannot touch A's order either", async () => {
        reset();
        const a = soleOrder(sellerA);
        const before = dbState();
        assert.strictEqual((await setStatus(sellerB, a.order, "delivered")).status, 404);
        assert.strictEqual((await removeOrder(sellerB, a.order)).status, 404);
        assert.strictEqual(dbState(), before);
    });
    await test("seller identity is taken from the token: seller_id / user_id / products in the body are ignored", async () => {
        reset();
        const a = soleOrder(sellerA);
        const b = soleOrder(sellerB);
        const spoof = { seller_id: String(sellerB._id), user_id: String(sellerB._id), "products.seller_id": String(sellerB._id), products: [{ seller_id: String(sellerB._id) }] };
        // A claiming to be B must still be A (cannot reach B's order)...
        assert.strictEqual((await setStatus(sellerA, b.order, "cancelled", spoof)).status, 404);
        assert.strictEqual((await removeOrder(sellerA, b.order, spoof)).status, 404);
        assert.strictEqual(stored(b.order).status, "new");
        assert.strictEqual(stock(b.p), 5);
        // ...and A claiming to be B on A's own order is still served as A, and only A's order changes.
        assert.strictEqual((await setStatus(sellerA, a.order, "processing", spoof)).status, 200);
        assert.strictEqual(stored(a.order).status, "processing");
        assert.strictEqual(stored(b.order).status, "new");
    });
    await test("NoSQL operators smuggled in as seller_id cannot widen the ownership filter", async () => {
        reset();
        const b = soleOrder(sellerB);
        const before = dbState();
        const inj = { seller_id: { $ne: "x" }, "products.seller_id": { $exists: true } };
        assert.strictEqual((await setStatus(sellerA, b.order, "cancelled", inj)).status, 404);
        assert.strictEqual((await removeOrder(sellerA, b.order, inj)).status, 404);
        assert.strictEqual(dbState(), before);
    });
    await test("upper-case hex spelling of B's order id is still B's order (A refused)", async () => {
        reset();
        const b = soleOrder(sellerB);
        const before = dbState();
        const upper = { _id: String(b.order._id).toUpperCase() };
        assert.strictEqual((await call("PUT", STATUS_URL, { as: sellerA, body: { order_id: upper._id, status_order: "cancelled" } })).status, 404);
        assert.strictEqual((await call("DELETE", DELETE_URL, { as: sellerA, body: { order_id: upper._id } })).status, 404);
        assert.strictEqual(dbState(), before);
    });
    await test("LEGACY mixed order, delete: A removes only A's lines; B's line, B's stock and the order survive", async () => {
        reset();
        const { pa, pb, order } = mixedOrder({ total: 180 }); // subtotal 200 (A 100 + B 100), a 10% coupon was applied
        const pre = plain(stored(order));
        const r = await removeOrder(sellerA, order);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const after = stored(order);
        assert.ok(after, "the order must survive because B's line is still on it");
        assert.deepStrictEqual(after.products.map((l) => l.seller_id), [String(sellerB._id)]);
        assert.deepStrictEqual(plain(after.products), plain(pre.products.filter((l) => l.seller_id === String(sellerB._id))), "B's line must be untouched");
        assert.strictEqual(after.total_price, 90, "total is scaled by the share of the remaining items (100/200 of 180)");
        assert.strictEqual(after.status, "new");
        assert.strictEqual(stock(pa), 6, "A's reserved unit goes back");
        assert.strictEqual(stock(pb), 5, "B's stock must not move");
        // A has no access to the order any more (and cannot learn it still exists).
        assert.strictEqual((await removeOrder(sellerA, order)).status, 404);
        assert.strictEqual((await setStatus(sellerA, order, "cancelled")).status, 404);
        // B is still served.
        assert.strictEqual((await setStatus(sellerB, order, "processing")).status, 200);
    });
    await test("LEGACY mixed order: after A's removal, B deleting the rest removes the whole order and restores only B's stock", async () => {
        reset();
        const { pa, pb, order } = mixedOrder({ total: 180 });
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        assert.strictEqual((await removeOrder(sellerB, order)).status, 200);
        assert.strictEqual(stored(order), undefined);
        assert.strictEqual(stock(pa), 6);
        assert.strictEqual(stock(pb), 7);
        assert.strictEqual(archivesOf(order).length, 2, "one snapshot per destructive step");
    });
    await test("DESIGN NOTE (pinned, not a defect): on a LEGACY mixed order the status is ONE order-level value - any participating seller may change it and a cancel gives back every line's stock", async () => {
        reset();
        const { pa, pb, order } = mixedOrder();
        assert.strictEqual((await setStatus(sellerA, order, "cancelled")).status, 200);
        assert.strictEqual(stored(order).status, "cancelled");
        assert.strictEqual(stock(pa), 6);
        assert.strictEqual(stock(pb), 7, "B's line must not stay reserved on a cancelled order");
        assert.strictEqual((await setStatus(sellerB, order, "cancelled")).status, 409, "no second restore");
        assert.strictEqual(stock(pb), 7);
    });

    // ===================================================================================== 8
    out("\n=== 8. Deletion behaviour ===");
    await test("owner deletes a sole-seller order: 200, order gone, response carries no order data", async () => {
        reset();
        const { order } = soleOrder(sellerA);
        const other = soleOrder(sellerA);
        const r = await removeOrder(sellerA, order);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.success, true);
        assert.strictEqual(r.body.message, "Order deleted successfully");
        assert.deepStrictEqual(r.body.data, []);
        assert.strictEqual(stored(order), undefined);
        assert.ok(stored(other.order), "another order of the same seller must not be touched");
    });
    for (const status of ["new", "processing", "shipped"]) {
        await test(`deleting a ${status} order gives every reserved line back, once`, async () => {
            reset();
            const p1 = product(sellerA, { quantity: 1 });
            const p2 = product(sellerA, { quantity: 4 });
            FakeProducts.__seed([p1, p2]);
            const order = seedOrder([{ p: p1, seller: sellerA, quantity: 2 }, { p: p2, seller: sellerA, quantity: 3 }], { status });
            assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
            assert.strictEqual(stock(p1), 3);
            assert.strictEqual(stock(p2), 7);
        });
    }
    for (const status of ["delivered", "cancelled"]) {
        await test(`deleting a ${status} order must NOT change stock (${status === "delivered" ? "goods already sold" : "cancel already restored it"})`, async () => {
            reset();
            const { p, order } = soleOrder(sellerA, { status, qty: 2 });
            assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
            assert.strictEqual(stock(p), 5);
            assert.strictEqual(stored(order), undefined);
        });
    }
    await test("cancel then delete: stock is restored exactly once in total", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { qty: 2 });
        assert.strictEqual((await setStatus(sellerA, order, "cancelled")).status, 200);
        assert.strictEqual(stock(p), 7);
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        assert.strictEqual(stock(p), 7);
    });
    await test("delete twice: 200 then 404; stock restored once; exactly one archive entry", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { qty: 2 });
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        assert.strictEqual((await removeOrder(sellerA, order)).status, 404);
        assert.strictEqual(stock(p), 7);
        assert.strictEqual(archivesOf(order).length, 1);
    });
    await test("two simultaneous deletes: exactly one 200, stock restored once, one archive entry", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { qty: 2 });
        const [r1, r2] = await Promise.all([removeOrder(sellerA, order), removeOrder(sellerA, order)]);
        assert.deepStrictEqual([r1.status, r2.status].sort(), [200, 404]);
        assert.strictEqual(stock(p), 7);
        assert.strictEqual(archivesOf(order).length, 1);
    });
    const badDeleteBodies = [
        ["missing order_id", () => ({})],
        ["empty order_id", () => ({ order_id: "" })],
        ["order_id too short", () => ({ order_id: "123" })],
        ["order_id 12 chars", () => ({ order_id: "abcdefabcdef" })],
        ["order_id numeric", () => ({ order_id: 123456789012345678901234 })],
        ["order_id NoSQL operator object", () => ({ order_id: { $ne: null } })],
        ["order_id array", (o) => ({ order_id: [String(o._id)] })],
    ];
    for (const [name, build] of badDeleteBodies) {
        await test(`400, no write, no archive: ${name}`, async () => {
            reset();
            const { order } = soleOrder(sellerA);
            const before = dbState();
            const r = await rawDelete(sellerA, build(order));
            assert.strictEqual(r.status, 400, JSON.stringify(r.body));
            assert.strictEqual(r.body.success, false);
            assert.strictEqual(dbState(), before);
            assert.strictEqual(events.length, 0);
        });
    }
    await test("a well-formed id that matches nothing -> 404, nothing archived", async () => {
        reset();
        soleOrder(sellerA);
        const r = await removeOrder(sellerA, { _id: new ObjectId() });
        assert.strictEqual(r.status, 404);
        assert.strictEqual(FakeArchive.__docs.length, 0);
    });
    await test("sockets: sole-order delete announces \"deleted_order\"; the buyer payload has only _id and orderNumber", async () => {
        reset();
        const { order } = soleOrder(sellerA);
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        const byRoom = (room) => state.io.emitted.filter((e) => e.room === room);
        assert.deepStrictEqual(byRoom("admins").map((e) => e.event), ["deleted_order"]);
        const toBuyer = byRoom(`user:${buyer._id}`);
        assert.deepStrictEqual(toBuyer.map((e) => e.event), ["deleted_order"]);
        assert.deepStrictEqual(Object.keys(toBuyer[0].payload).sort(), ["_id", "orderNumber"]);
    });
    await test("sockets: partial removal announces \"updated_order\", never \"deleted_order\" (the order still exists)", async () => {
        reset();
        const { order } = mixedOrder();
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        const names = state.io.emitted.map((e) => e.event);
        assert.ok(names.length > 0 && names.every((n) => n === "updated_order"), names.join(","));
    });
    await test("a socket failure after the write does not turn a successful delete into a 500", async () => {
        reset();
        state.io = ioSpy({ throwOnTo: true });
        const { order } = soleOrder(sellerA);
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        assert.strictEqual(stored(order), undefined);
    });
    await test("stock-restore failure: reports 500, but the order was archived first so nothing is unrecoverable", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { qty: 2 });
        const rawUpdateOne = FakeProducts.updateOne;
        FakeProducts.updateOne = async () => { throw new Error("db down"); };
        let r;
        try { r = await removeOrder(sellerA, order); } finally { FakeProducts.updateOne = rawUpdateOne; }
        assert.strictEqual(r.status, 500);
        assert.match(r.body.message, /stock/i);
        assert.ok(!JSON.stringify(r.body).includes("db down"), "internal error text must not leak");
        assert.strictEqual(archivesOf(order).length, 1, "a snapshot must exist for support to recover from");
        assert.strictEqual(stock(p), 5);
    });

    // ===================================================================================== 9
    out("\n=== 9. Archive before deletion (LOGIC-07) ===");
    await test("archive schema: order_id, order_updated_at, order, removed_by, reason required; reason limited to seller_delete; unique (order_id, order_updated_at)", () => {
        const s = ArchiveModel.schema;
        for (const f of ["order_id", "order_updated_at", "order", "removed_by", "reason"]) assert.strictEqual(s.path(f).options.required, true, `${f} must be required`);
        assert.deepStrictEqual(s.path("reason").options.enum, ["seller_delete"]);
        const unique = s.indexes().find(([fields, opts]) => JSON.stringify(fields) === JSON.stringify({ order_id: 1, order_updated_at: 1 }) && opts.unique === true);
        assert.ok(unique, "unique compound index {order_id:1, order_updated_at:1} must be declared (it makes retries/concurrency idempotent)");
    });
    await test("full delete: the archive holds the complete pre-delete order, the removing seller and the removed lines", async () => {
        reset();
        const { order } = soleOrder(sellerA, { status: "processing", qty: 2 });
        const pre = plain(stored(order));
        const v0 = +stored(order).updatedAt;
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        const a = archivesOf(order);
        assert.strictEqual(a.length, 1);
        assert.strictEqual(+a[0].order_updated_at, v0, "snapshot is keyed by the exact order version that was deleted");
        assert.deepStrictEqual(plain(a[0].order), pre, "full order, including buyer, products, total, status");
        assert.ok(a[0].removed_by.equals(sellerA._id), "removed_by is the authenticated seller");
        assert.strictEqual(a[0].reason, "seller_delete");
        assert.deepStrictEqual(plain(a[0].removed_items), pre.products);
    });
    await test("ordering: the archive row exists BEFORE the order is deleted", async () => {
        reset();
        const { order } = soleOrder(sellerA);
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        const kinds = events.map((e) => e.kind);
        assert.ok(kinds.indexOf("archive") !== -1 && kinds.indexOf("delete") !== -1, kinds.join(","));
        assert.ok(kinds.indexOf("archive") < kinds.indexOf("delete"), `archive must precede delete, got ${kinds.join(",")}`);
        const del = events.find((e) => e.kind === "delete");
        assert.ok(del.archived.some((x) => x.order_id === String(order._id)), "at the moment of the delete the snapshot was already stored");
    });
    await test("partial removal: the FULL order (incl. the other seller's lines) is archived BEFORE the $pull; removed_items are only the remover's", async () => {
        reset();
        const { order } = mixedOrder({ total: 180 });
        const pre = plain(stored(order));
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        const kinds = events.map((e) => e.kind);
        assert.ok(kinds.indexOf("archive") < kinds.indexOf("pull"), kinds.join(","));
        assert.ok(events.find((e) => e.kind === "pull").archived.some((x) => x.order_id === String(order._id)));
        const a = archivesOf(order);
        assert.strictEqual(a.length, 1);
        assert.deepStrictEqual(plain(a[0].order), pre, "snapshot is the order BEFORE the removal");
        assert.deepStrictEqual(plain(a[0].removed_items), pre.products.filter((l) => l.seller_id === String(sellerA._id)));
        assert.ok(a[0].removed_by.equals(sellerA._id));
    });
    await test("archive failure on a full delete: 500, NO destructive write attempted, order/stock intact, no socket event, no error leak", async () => {
        reset();
        archiveControl.failWith = new Error("archive down");
        const { p, order } = soleOrder(sellerA);
        const before = JSON.stringify([FakeOrders.__docs, FakeProducts.__docs]);
        const r = await removeOrder(sellerA, order);
        assert.strictEqual(r.status, 500, JSON.stringify(r.body));
        assert.strictEqual(r.body.success, false);
        assert.ok(!JSON.stringify(r.body).includes("archive down"));
        assert.strictEqual(JSON.stringify([FakeOrders.__docs, FakeProducts.__docs]), before);
        assert.strictEqual(events.filter((e) => e.kind === "delete" || e.kind === "pull").length, 0, "no destructive write may be attempted");
        assert.strictEqual(stock(p), 5);
        assert.strictEqual(state.io.emitted.length, 0);
    });
    await test("archive failure on a partial removal: 500, nothing pulled, nothing restored", async () => {
        reset();
        archiveControl.failWith = new Error("archive down");
        const { pa, pb, order } = mixedOrder();
        const before = JSON.stringify([FakeOrders.__docs, FakeProducts.__docs]);
        const r = await removeOrder(sellerA, order);
        assert.strictEqual(r.status, 500);
        assert.strictEqual(JSON.stringify([FakeOrders.__docs, FakeProducts.__docs]), before);
        assert.strictEqual(events.filter((e) => e.kind === "pull" || e.kind === "delete").length, 0);
        assert.strictEqual(stock(pa), 5);
        assert.strictEqual(stock(pb), 5);
    });
    await test("a duplicate-key error from the archive (same order version already archived) is tolerated: delete proceeds, still one row for that version", async () => {
        reset();
        const { order } = soleOrder(sellerA);
        FakeArchive.__seed([{
            _id: new ObjectId(), order_id: order._id, order_updated_at: stored(order).updatedAt, order: plain(stored(order)),
            removed_by: sellerA._id, reason: "seller_delete", removed_items: plain(stored(order).products), createdAt: tick(),
        }]);
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        assert.strictEqual(stored(order), undefined);
        assert.strictEqual(archivesOf(order).length, 1);
    });
    await test("changed concurrently between read and delete: the retry archives the NEW version and the final snapshot matches what was deleted", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { qty: 2 });
        const v0 = +stored(order).updatedAt;
        let fired = false;
        hooks.beforeDelete = async () => {
            if (fired) return;
            fired = true;
            // somebody moves the order to "processing" after the controller read it
            assert.strictEqual((await setStatus(sellerA, order, "processing")).status, 200);
        };
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        assert.strictEqual(stored(order), undefined);
        const a = archivesOf(order).sort((x, y) => +x.order_updated_at - +y.order_updated_at);
        assert.strictEqual(a.length, 2, "one snapshot per order version that was attempted");
        assert.strictEqual(+a[0].order_updated_at, v0);
        assert.strictEqual(a[0].order.status, "new");
        assert.strictEqual(a[1].order.status, "processing", "the snapshot of the deleted version carries the status at deletion time");
        assert.notStrictEqual(+a[0].order_updated_at, +a[1].order_updated_at);
        assert.strictEqual(stock(p), 7, "processing is active -> restored once");
    });
    await test("cancel racing with delete: stock is restored exactly once (cancel gave it back, delete must not repeat it)", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { qty: 2 });
        let fired = false;
        hooks.beforeDelete = async () => {
            if (fired) return;
            fired = true;
            assert.strictEqual((await setStatus(sellerA, order, "cancelled")).status, 200);
        };
        assert.strictEqual((await removeOrder(sellerA, order)).status, 200);
        assert.strictEqual(stored(order), undefined);
        assert.strictEqual(stock(p), 7, "5 + 2 once, not 5 + 2 + 2");
        const last = archivesOf(order).sort((x, y) => +y.order_updated_at - +x.order_updated_at)[0];
        assert.strictEqual(last.order.status, "cancelled");
    });
    await test("order keeps changing for every retry: 409, order NOT deleted, stock untouched", async () => {
        reset();
        const { p, order } = soleOrder(sellerA, { qty: 2 });
        hooks.beforeDelete = async () => { stored(order).updatedAt = tick(); };
        const r = await removeOrder(sellerA, order);
        assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.ok(stored(order), "the order must still exist");
        assert.strictEqual(stock(p), 5);
        assert.strictEqual(state.io.emitted.length, 0);
    });
    await test("DEFECT (LOGIC-07 audit trail): when a concurrent request already archived the same order version, the removing seller's own removal must still be recorded", async () => {
        reset();
        // Legacy mixed order. Seller A's concurrent request has already archived version v0 (removed_by A, A's lines)
        // but its own write has not landed yet. Seller B now removes B's lines from the SAME version v0.
        const { order } = mixedOrder({ total: 180 });
        const pre = plain(stored(order));
        const aLines = pre.products.filter((l) => l.seller_id === String(sellerA._id));
        const bLines = pre.products.filter((l) => l.seller_id === String(sellerB._id));
        FakeArchive.__seed([{
            _id: new ObjectId(), order_id: order._id, order_updated_at: stored(order).updatedAt, order: pre,
            removed_by: sellerA._id, reason: "seller_delete", removed_items: aLines, createdAt: tick(),
        }]);
        assert.strictEqual((await removeOrder(sellerB, order)).status, 200);
        assert.deepStrictEqual(stored(order).products.map((l) => l.seller_id), [String(sellerA._id)], "B's lines were removed");
        const recordedForB = archivesOf(order).find((a) => a.removed_by.equals(sellerB._id));
        assert.ok(recordedForB, "no archive entry attributes the removal of B's lines to seller B (the duplicate-key error was swallowed and B's removed_by / removed_items were lost; the v0 row still says seller A)");
        assert.deepStrictEqual(plain(recordedForB.removed_items), bLines);
    });

    server.closeAllConnections && server.closeAllConnections();
    server.close();
    out(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
    process.stdout.write(`\nUnexpected error: ${error.stack}\n`);
    process.exit(1);
});