// Concurrency / race-condition tests for products and orders.
//
//   node tests/concurrency.test.js
//
// WHAT THIS RUNS AGAINST
//   A REAL MongoDB (mongodb-memory-server, via tests/integration/mongo_memory.js), the REAL Mongoose
//   models and the REAL controllers (controller/order.controller.js and
//   controller/update_product.controller.js). The controllers are called directly with a minimal
//   req/res pair (same approach as the other tests in this repo), so the Express routing, auth
//   middleware and the per-user order rate limiter (routes/order.router.js: 15 / 10 min / user) are
//   deliberately NOT part of these tests. Only the stock/order logic and the database are.
//
// WHY NO FAKE-DATABASE FALLBACK
//   tests/phase1/mock_models.js is a single-threaded in-memory fake. Its "atomic" updates are atomic
//   only because JavaScript is single-threaded, not because anything was proven, so running these
//   scenarios against it would produce a green result that says nothing about MongoDB's real
//   atomicity. If a real mongod cannot be started, this file therefore SKIPS LOUDLY instead of
//   falling back (same convention as tests/integration/real_mongoose.test.js):
//     - exit code 0 and a SKIPPED banner by default (nothing was verified!)
//     - exit code 1 when REQUIRE_REAL_DB=1 (use this in CI)
//
// DATABASE TOPOLOGY
//   A standalone mongod. The application does not use multi-document transactions anywhere, so
//   no replica set is needed; every guarantee tested here is single-document atomicity.
//
// HOW CONCURRENCY IS PRODUCED (it is never a sequential loop)
//   * Test 1 launches all 20 requests in the same tick with Promise.all and additionally parks every
//     request on a barrier immediately before its atomic stock decrement. All 20 have therefore
//     passed the (non-atomic) "is there enough stock?" pre-check, and are released to hit
//     MongoDB at the same instant. That is the worst case for the oversell race, and the test
//     asserts that all 20 actually reached the barrier, so it cannot silently degrade into a
//     serial run. Un-gated rounds are run as well to cover natural interleavings.
//   * Test 2 starts a product edit and an order at the same time and sweeps a fixed schedule of start
//     offsets (0-15 ms) so that the order lands before, during and after the editor's
//     read-then-write. The assertions are interleaving-independent invariants, so they must hold
//     for every ordering; the observed outcome mix is printed.

"use strict";

const assert = require("assert");
const path = require("path");

// Neutralise external services BEFORE any project module is loaded.
//  - config/redis.js only connects when REDIS_URL is truthy, and dotenv never overrides a variable
//    that already exists, so "" forces the in-process node-cache even if .env defines REDIS_URL.
//  - config/redis.js can process.exit(1) in production when REQUIRE_REDIS=1.
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
delete process.env.REQUIRE_REDIS;

const ATTEMPTS = 20;
const ROUNDS_PER_UPDATE_SCENARIO = 33; // 3 passes over SCHEDULE
const ORIGINAL_NAME = "original name";
const EDITED_NAME = "edited name";
const ORIGINAL_PRICE = 100;
const EDITED_PRICE = 150;
const STOCK_ERROR = /unavailable|out of stock/i;

// [updateStartDelayMs, orderStartDelayMs]. Fixed (not random) so a failing run is repeatable in
// schedule, even though the exact interleaving still depends on real I/O timing.
const SCHEDULE = [[0, 0], [0, 1], [1, 0], [0, 2], [2, 0], [0, 4], [4, 0], [0, 8], [8, 0], [0, 15], [15, 0]];

let passed = 0;
let failed = 0;

async function test(name, fn, timeoutMs = 120000) {
    const started = Date.now();
    let timer;
    try {
        await Promise.race([
            fn(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`test timed out after ${timeoutMs} ms`)), timeoutMs);
            }),
        ]);
        console.log(`  PASS - ${name} (${Date.now() - started} ms)`);
        passed++;
    } catch (error) {
        console.log(`  FAIL - ${name}\n         ${String(error.message).split("\n").join("\n         ")}`);
        failed++;
    } finally {
        clearTimeout(timer);
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withDelay = (ms, fn) => (ms > 0 ? sleep(ms).then(fn) : fn());

function printSkipBanner(reason) {
    const line = "!".repeat(78);
    console.log(line);
    console.log("SKIPPED - concurrency tests did NOT run. NOTHING WAS VERIFIED.");
    console.log(`Reason: ${reason}`);
    console.log("These tests need a real MongoDB; they intentionally do not fall back to the");
    console.log("in-memory fake (it cannot demonstrate real atomicity). To run them:");
    console.log("  npm install        # installs mongoose and mongodb-memory-server (devDependency)");
    console.log("  node tests/concurrency.test.js   # first run downloads a mongod binary");
    console.log("Set REQUIRE_REAL_DB=1 to make a skip a failure (exit code 1).");
    console.log(line);
}

(async () => {
    // ---- start a real MongoDB, or skip loudly ---------------------------------------------------
    let db;
    try {
        const { startMemoryMongo } = require("./integration/mongo_memory");
        db = await startMemoryMongo();
    } catch (e) {
        if (e.code === "MONGOD_UNAVAILABLE" || e.code === "MODULE_NOT_FOUND") {
            printSkipBanner(e.message.split("\n")[0]);
            process.exit(process.env.REQUIRE_REAL_DB === "1" ? 1 : 0);
        }
        throw e;
    }

    const { mongoose } = db;
    const { ObjectId } = mongoose.Types;
    const MODELS = path.join(__dirname, "..", "models");
    const CONTROLLERS = path.join(__dirname, "..", "controller");
    const Products = require(path.join(MODELS, "products"));
    const Orders = require(path.join(MODELS, "order"));
    const Sections = require(path.join(MODELS, "section"));
    const orderController = require(path.join(CONTROLLERS, "order.controller"));
    const updateController = require(path.join(CONTROLLERS, "update_product.controller"));

    // The update controller logs one warning per call on the legacy (no expected_quantity) path.
    // That path is exercised on purpose, so drop only that exact line from the output.
    const originalWarn = console.warn;
    console.warn = (...args) => {
        if (String(args[0]).startsWith("[stock] legacy product update")) return;
        originalWarn.apply(console, args);
    };

    // ---- helpers --------------------------------------------------------------------------------
    function makeRes() {
        const res = { statusCode: 200, body: undefined };
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (body) => { res.body = body; return res; };
        return res;
    }

    // Controllers answer through res; a controller that throws is reported as status "threw".
    async function callController(controller, req) {
        const res = makeRes();
        try {
            await controller(req, res);
        } catch (error) {
            return { status: "threw", body: { message: error.message } };
        }
        return { status: res.statusCode, body: res.body };
    }

    const makeBuyer = (i) => ({
        _id: new ObjectId(),
        name: `buyer-${i}`,
        phone_number: "0100000000",
        GPS_URL: "https://maps.example.com/?q=30,31",
        whatsApp_number: "0100000000",
        role: "user",
    });

    const orderReq = (buyer, productId, quantity) => ({
        user: buyer,
        body: { products: [{ id: String(productId), quantity }] },
        headers: {},
        get: () => undefined, // no Idempotency-Key
        io: undefined,
    });

    const updateReq = (ctx, productId, { name, price, quantity, expectedQuantity }) => {
        const body = {
            product_id: String(productId),
            product_name: name,
            product_description: "edited description",
            product_price: price,
            product_discount: 0,
            quantity,
            images: ["https://example.com/img.jpg"],
            section: String(ctx.sectionId),
        };
        if (expectedQuantity !== undefined) body.expected_quantity = expectedQuantity;
        return { user: { _id: ctx.seller._id, role: "seller" }, body, io: undefined };
    };

    // Fresh collections + the one section every product needs (update_product checks it exists).
    async function seed() {
        await db.clear();
        const { insertedId } = await Sections.collection.insertOne({ name: "concurrency-section" });
        return { seller: { _id: new ObjectId() }, storeId: new ObjectId(), sectionId: insertedId };
    }

    const createProduct = (ctx, { stock, name = ORIGINAL_NAME, price = ORIGINAL_PRICE }) =>
        Products.create({
            name,
            description: "used item in good condition",
            price,
            discount: 0,
            final_price: price,
            images: ["https://example.com/img.jpg"],
            section: ctx.sectionId,
            quantity: stock,
            seller_id: ctx.seller._id,
            store_id: ctx.storeId,
        });

    const summarize = (results) =>
        JSON.stringify(results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}));

    // A barrier: arrive() resolves for everyone once `parties` callers have arrived (or after
    // timeoutMs, so a request that never gets there cannot hang the suite; callers then assert
    // `arrived === parties`, which turns that situation into a clear failure).
    function createGate(parties, timeoutMs = 10000) {
        let arrived = 0;
        let open;
        const opened = new Promise((resolve) => { open = resolve; });
        const timer = setTimeout(open, timeoutMs);
        return {
            get arrived() { return arrived; },
            async arrive() {
                arrived++;
                if (arrived >= parties) { clearTimeout(timer); open(); }
                await opened;
            },
        };
    }

    // Park every atomic stock decrement of the order controller (Products.findOneAndUpdate) on the
    // gate, then run the real query. Returns an uninstall function.
    function gateStockDecrements(gate) {
        const hadOwn = Object.prototype.hasOwnProperty.call(Products, "findOneAndUpdate");
        const original = Products.findOneAndUpdate;
        Products.findOneAndUpdate = function gated(...args) {
            return gate.arrive().then(() => original.apply(this, args));
        };
        return () => {
            if (hadOwn) Products.findOneAndUpdate = original;
            else delete Products.findOneAndUpdate;
        };
    }

    // ---- Test 1 assertions ------------------------------------------------------------------------
    async function assertPurchaseOutcome({ label, productId, initialStock, quantityPerOrder, results, expectedSuccesses }) {
        const ok = (r) => r.status === 201 && r.body && r.body.success === true;
        const successes = results.filter(ok);
        const failures = results.filter((r) => !ok(r));
        const where = `[${label}] responses by status: ${summarize(results)}`;

        assert.strictEqual(results.length, ATTEMPTS, `${where}: expected ${ATTEMPTS} responses`);
        assert.strictEqual(successes.length, expectedSuccesses,
            `${where}: expected exactly ${expectedSuccesses} successful order(s), got ${successes.length}`);

        for (const failure of failures) {
            assert.strictEqual(failure.status, 400,
                `${where}: a losing attempt must be a clean 400, got ${failure.status} ${JSON.stringify(failure.body)}`);
            assert.strictEqual(failure.body.success, false, `${where}: losing attempt reported success`);
            assert.match(failure.body.message, STOCK_ERROR,
                `${where}: losing attempt must fail because stock is unavailable, got "${failure.body.message}"`);
        }

        const finalProduct = await Products.findById(productId).lean();
        assert.ok(finalProduct, `${label}: product disappeared`);
        assert.ok(finalProduct.quantity >= 0, `${where}: stock went NEGATIVE (${finalProduct.quantity})`);
        assert.strictEqual(finalProduct.quantity, initialStock - expectedSuccesses * quantityPerOrder,
            `${where}: final stock ${finalProduct.quantity}, expected ${initialStock - expectedSuccesses * quantityPerOrder}`);

        const orderDocs = await Orders.find({ "products.product": productId }).lean();
        assert.strictEqual(orderDocs.length, expectedSuccesses,
            `${where}: ${orderDocs.length} order document(s) exist, expected ${expectedSuccesses}`);

        // Conservation: every unit that left stock is on exactly one persisted order, and vice versa.
        const unitsOrdered = orderDocs.reduce(
            (sum, o) => sum + o.products.reduce((s, line) => s + line.quantity, 0), 0);
        assert.strictEqual(unitsOrdered, initialStock - finalProduct.quantity,
            `${where}: ${unitsOrdered} unit(s) on orders but stock dropped by ${initialStock - finalProduct.quantity}`);

        // The orders that exist are exactly the orders that were reported as successful.
        assert.deepStrictEqual(
            orderDocs.map((o) => String(o._id)).sort(),
            successes.map((r) => String(r.body.data._id)).sort(),
            `${where}: persisted orders differ from the orders reported to buyers`);
        assert.deepStrictEqual(
            orderDocs.map((o) => String(o.user_id)).sort(),
            successes.map((r) => String(r.body.data.user_id)).sort(),
            `${where}: persisted orders belong to different buyers than the successful responses`);
        for (const o of orderDocs) {
            assert.strictEqual(o.status, "new", `${label}: new order must start as "new"`);
            assert.strictEqual(o.products.length, 1, `${label}: order must contain exactly one line`);
            assert.strictEqual(o.products[0].quantity, quantityPerOrder, `${label}: wrong quantity on order line`);
        }
    }

    async function concurrentPurchases({ ctx, stock, gated }) {
        const product = await createProduct(ctx, { stock });
        const buyers = Array.from({ length: ATTEMPTS }, (_, i) => makeBuyer(i));
        const gate = gated ? createGate(ATTEMPTS) : null;
        const uninstall = gated ? gateStockDecrements(gate) : () => {};
        let results;
        try {
            // All 20 controller invocations start in this single tick and overlap on real DB I/O.
            results = await Promise.all(buyers.map((b) => callController(orderController, orderReq(b, product._id, 1))));
        } finally {
            uninstall();
        }
        if (gate) {
            assert.strictEqual(gate.arrived, ATTEMPTS,
                `only ${gate.arrived}/${ATTEMPTS} requests reached the atomic stock decrement together ` +
                `(responses: ${summarize(results)}), so the race was not exercised`);
        }
        return { product, results };
    }

    // =============================================================================================
    // TEST 1: concurrent purchase of one item
    // =============================================================================================
    try {
        // Build the unique indexes (orders.orderNumber, ...) before any concurrent insert.
        await Promise.all([Products.init(), Orders.init(), Sections.init()]);

        console.log(`=== Test 1: ${ATTEMPTS} concurrent purchase attempts on a product with stock = 1 ===`);

        await test(`stock=1, ${ATTEMPTS} buyers, all forced into the atomic decrement at once: exactly 1 wins`, async () => {
            const ctx = await seed();
            const { product, results } = await concurrentPurchases({ ctx, stock: 1, gated: true });
            await assertPurchaseOutcome({
                label: "gated stock=1", productId: product._id, initialStock: 1,
                quantityPerOrder: 1, results, expectedSuccesses: 1,
            });
        });

        await test(`stock=1, ${ATTEMPTS} buyers, natural interleaving, 8 rounds: exactly 1 wins every round`, async () => {
            for (let round = 1; round <= 8; round++) {
                const ctx = await seed();
                const { product, results } = await concurrentPurchases({ ctx, stock: 1, gated: false });
                await assertPurchaseOutcome({
                    label: `ungated stock=1 round ${round}`, productId: product._id, initialStock: 1,
                    quantityPerOrder: 1, results, expectedSuccesses: 1,
                });
            }
        });

        await test(`stock=5, ${ATTEMPTS} buyers, all forced into the atomic decrement at once: exactly 5 win, stock ends at 0`, async () => {
            const ctx = await seed();
            const { product, results } = await concurrentPurchases({ ctx, stock: 5, gated: true });
            await assertPurchaseOutcome({
                label: "gated stock=5", productId: product._id, initialStock: 5,
                quantityPerOrder: 1, results, expectedSuccesses: 5,
            });
        });

        // =========================================================================================
        // TEST 2: concurrent product update and order
        // =========================================================================================
        //
        // Intended lifecycle (utils/order_stock.js): stock is reserved ONCE, when the order is
        // created. A product edit must never undo or double-count that reservation, and an edit
        // that races with an order must either apply cleanly or be rejected (409, "reload"), never
        // half-apply.
        //
        // For one race between an edit (seller sets quantity = newQty) and an order (buys orderQty)
        // on a product that started at initialStock, the interleaving-independent invariant is:
        //
        //   final stock = (edit applied ? newQty : initialStock) - (order succeeded ? orderQty : 0)
        //
        // plus: stock never negative; an order document exists iff the order succeeded; an edit is
        // all-or-nothing (name, price and final_price change together or not at all).
        console.log(`\n=== Test 2: concurrent product update and order (${ROUNDS_PER_UPDATE_SCENARIO} rounds per scenario) ===`);

        const NEW_QTY_CONFLICT_STATUSES = [200, 409];
        const SCENARIOS = [
            {
                name: "WITH expected_quantity: seller edits name/price only (stock field unchanged at 10), buyer orders 3",
                initialStock: 10, orderQty: 3, newQty: 10, expectedQuantity: 10,
                updateStatuses: NEW_QTY_CONFLICT_STATUSES, orderStatuses: [201],
            },
            {
                name: "WITH expected_quantity: seller restocks 10 -> 20, buyer orders 3",
                initialStock: 10, orderQty: 3, newQty: 20, expectedQuantity: 10,
                updateStatuses: NEW_QTY_CONFLICT_STATUSES, orderStatuses: [201],
            },
            {
                // If the edit lands first the order can no longer be served (2 < 3); if the order
                // lands first the edit must be rejected. Both applying would drive stock to -1.
                name: "WITH expected_quantity: seller lowers stock 10 -> 2 (below the 3 ordered)",
                initialStock: 10, orderQty: 3, newQty: 2, expectedQuantity: 10,
                updateStatuses: NEW_QTY_CONFLICT_STATUSES, orderStatuses: [201, 400],
            },
            {
                // seller-dashboard.html never sends expected_quantity, so THIS is the path real
                // sellers use today. The form still shows the stock the seller loaded (10) and they
                // only change name/price. An edit that does not intend to change stock must not
                // change it, so the order's reservation (10 -> 7) has to survive.
                name: "LEGACY (no expected_quantity, as sent by seller-dashboard.html): name/price edit with stale form stock 10, buyer orders 3",
                initialStock: 10, orderQty: 3, newQty: 10, expectedQuantity: undefined,
                updateStatuses: [200], orderStatuses: [201],
            },
        ];

        async function assertRaceInvariants(scenario, { product, update, order }, context) {
            const { initialStock, orderQty, newQty, updateStatuses, orderStatuses } = scenario;
            const updateOk = update.status === 200 && update.body && update.body.success === true;
            const orderOk = order.status === 201 && order.body && order.body.success === true;

            const finalProduct = await Products.findById(product._id).lean();
            const orderDocs = await Orders.find({ "products.product": product._id }).lean();
            const expectedFinal = (updateOk ? newQty : initialStock) - (orderOk ? orderQty : 0);
            const state = `${context}: update=${update.status} ${JSON.stringify(update.body && update.body.message)}, ` +
                `order=${order.status} ${JSON.stringify(order.body && order.body.message)}, ` +
                `final stock=${finalProduct && finalProduct.quantity} (expected ${expectedFinal}), orders=${orderDocs.length}`;

            assert.ok(updateStatuses.includes(update.status), `update status not in [${updateStatuses}] - ${state}`);
            assert.ok(orderStatuses.includes(order.status), `order status not in [${orderStatuses}] - ${state}`);
            if (update.status === 409) assert.match(update.body.message, /stock changed/i, `409 must say stock changed - ${state}`);
            if (!orderOk) assert.match(order.body.message, STOCK_ERROR, `a failed order must fail because of stock - ${state}`);

            assert.ok(finalProduct, `product disappeared - ${state}`);
            assert.ok(finalProduct.quantity >= 0, `stock went NEGATIVE - ${state}`);
            assert.strictEqual(finalProduct.quantity, expectedFinal, `stock inconsistent with the order/update lifecycle - ${state}`);
            assert.strictEqual(orderDocs.length, orderOk ? 1 : 0, `order documents inconsistent with the order result - ${state}`);
            if (orderOk) {
                assert.strictEqual(orderDocs[0].products[0].quantity, orderQty, `wrong quantity on the order line - ${state}`);
                assert.strictEqual(String(orderDocs[0]._id), String(order.body.data._id), `persisted order differs from reported order - ${state}`);
            }

            // An edit is all-or-nothing.
            if (updateOk) {
                assert.strictEqual(finalProduct.name, EDITED_NAME, `update reported 200 but name is unchanged - ${state}`);
                assert.strictEqual(finalProduct.price, EDITED_PRICE, `update reported 200 but price is unchanged - ${state}`);
                assert.strictEqual(finalProduct.final_price, EDITED_PRICE, `update reported 200 but final_price is unchanged - ${state}`);
            } else {
                assert.strictEqual(finalProduct.name, ORIGINAL_NAME, `update was rejected but name changed - ${state}`);
                assert.strictEqual(finalProduct.price, ORIGINAL_PRICE, `update was rejected but price changed - ${state}`);
            }
        }

        for (const scenario of SCENARIOS) {
            await test(scenario.name, async () => {
                const ctx = await seed();
                const tally = {};
                for (let round = 0; round < ROUNDS_PER_UPDATE_SCENARIO; round++) {
                    const [updateDelay, orderDelay] = SCHEDULE[round % SCHEDULE.length];
                    const product = await createProduct(ctx, { stock: scenario.initialStock });
                    const buyer = makeBuyer(round);

                    const [update, order] = await Promise.all([
                        withDelay(updateDelay, () => callController(updateController, updateReq(ctx, product._id, {
                            name: EDITED_NAME, price: EDITED_PRICE,
                            quantity: scenario.newQty, expectedQuantity: scenario.expectedQuantity,
                        }))),
                        withDelay(orderDelay, () => callController(orderController, orderReq(buyer, product._id, scenario.orderQty))),
                    ]);

                    const key = `update ${update.status} / order ${order.status}`;
                    tally[key] = (tally[key] || 0) + 1;
                    await assertRaceInvariants(scenario, { product, update, order },
                        `round ${round + 1} (start delays ms: update ${updateDelay}, order ${orderDelay})`);
                }
                console.log(`         outcomes over ${ROUNDS_PER_UPDATE_SCENARIO} rounds: ${JSON.stringify(tally)}`);
            });
        }
    } finally {
        console.warn = originalWarn;
        await db.stop();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});