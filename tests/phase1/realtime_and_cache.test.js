const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeFakeModel, realSchema, ObjectId } = require("./mock_models");
const PROJECT = path.join(__dirname, "..", "..");

function inject(rel, value) { const abs = require.resolve(path.join(PROJECT, rel)); require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value }; }
const FakeProducts = makeFakeModel("products", { schema: realSchema("products") });
const FakeOrders = makeFakeModel("orders", { schema: realSchema("order") });
const FakeArchives = makeFakeModel("order_archive", { schema: realSchema("order_archive") });
inject("models/products.js", FakeProducts); inject("models/order.js", FakeOrders);
inject("models/order_archive.js", FakeArchives);
inject("models/coupon.js", { findOne: () => ({ lean: async () => null }) });
inject("models/users.js", { findById: () => ({ select: () => ({ lean: async () => ({ role: "seller" }) }) }) });
inject("utils/cache.js", { delByPrefix: async () => {} });
inject("utils/socket_events.js", { CATALOG_ROOM: "catalog", seller_room: (id) => `seller:${id}`, user_room: (id) => `user:${id}` });
const order = require(path.join(PROJECT, "controller/order.controller.js"));
const deleteOrder = require(path.join(PROJECT, "controller/delete_order.controller.js"));

function res() { return { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function reset() { FakeProducts.__docs.splice(0); FakeOrders.__docs.splice(0); }
const sellerA = new ObjectId(), sellerB = new ObjectId();
const buyer = { _id: new ObjectId(), name: "Buyer", phone_number: "0100000000", GPS_URL: "https://maps.test", whatsApp_number: "0100000000" };

(async () => {
    let failed = 0;
    try {
        reset();
        const product = { _id: new ObjectId(), seller_id: sellerA, name: "Phone", price: 100, discount: 0, quantity: 2, images: [] };
        FakeProducts.__seed([product]);
        const sent = [];
        const io = { to(room) { return { emit(event, payload) { sent.push({ room, event, payload }); } }; } };
        const response = res();
        await order({ user: buyer, body: { products: [{ id: String(product._id), quantity: 1 }] }, io }, response);
        assert.strictEqual(response.statusCode, 201);
        const sellerEvent = sent.find((entry) => entry.room === `seller:${sellerA}` && entry.event === "new_order");
        assert.ok(sellerEvent);
        assert.ok(!sent.some((entry) => entry.room === `seller:${sellerB}`));
        assert.strictEqual(JSON.stringify(sellerEvent.payload).includes("phone"), false);
        assert.strictEqual(JSON.stringify(sellerEvent.payload).includes("GPS"), false);
        console.log("PASS - seller receives only a minimal new-order notification");
    } catch (error) { failed++; console.log(error.message); }

    try {
        reset();
        const product = { _id: new ObjectId(), seller_id: sellerA, name: "Phone", price: 100, quantity: 1 };
        const orderId = new ObjectId();
        FakeProducts.__seed([product]);
        FakeOrders.__seed([{
            _id: orderId, updatedAt: new Date(), user_id: String(buyer._id), orderNumber: "ORD-123456789",
            status: "new", total_price: 100,
            products: [{ product: product._id, seller_id: String(sellerA), price: 100, quantity: 1 }],
        }]);
        const sent = [];
        const io = { to(room) { return { emit(event, payload) { sent.push({ room, event, payload }); } }; } };
        const response = res();
        await deleteOrder({ user: { _id: sellerA }, body: { order_id: String(orderId) }, io }, response);
        assert.strictEqual(response.statusCode, 200);
        const buyerEvent = sent.find((entry) => entry.room === `user:${buyer._id}` && entry.event === "deleted_order");
        assert.deepStrictEqual(buyerEvent && buyerEvent.payload, { _id: orderId, orderNumber: "ORD-123456789" });
        console.log("PASS - buyer receives a minimal deleted-order notification");
    } catch (error) { failed++; console.log(error.message); }

    try {
        const source = fs.readFileSync(path.join(PROJECT, "utils/cache.js"), "utf8");
        assert.ok(source.includes("bumpProductsEpoch"));
        assert.ok(source.includes("if (prefix === \"products\")"));
        console.log("PASS - product invalidation uses epoch rather than SCAN");
    } catch (error) { failed++; console.log(error.message); }
    process.exitCode = failed ? 1 : 0;
})();