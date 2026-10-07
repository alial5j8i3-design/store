const assert = require("assert");
const path = require("path");
const { makeFakeModel, realSchema, ObjectId } = require("./mock_models");

const PROJECT = path.join(__dirname, "..", "..");
const FakeProducts = makeFakeModel("products", { schema: realSchema("products") });
const FakeOrders = makeFakeModel("orders", { schema: realSchema("order") });

function inject(rel, exportsValue) {
    const abs = require.resolve(path.join(PROJECT, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsValue };
}

inject("models/products.js", FakeProducts);
inject("models/order.js", FakeOrders);
inject("models/coupon.js", { findOne: () => ({ lean: async () => null }) });
inject("models/section.js", { exists: async () => ({ _id: new ObjectId() }) });
inject("utils/cache.js", { delByPrefix: async () => {} });
inject("utils/socket_events.js", { CATALOG_ROOM: "catalog", emit_to: () => {}, product_payload: (product) => product });

const order = require(path.join(PROJECT, "controller/order.controller.js"));
const updateProduct = require(path.join(PROJECT, "controller/update_product.controller.js"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS - ${name}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL - ${name}\n         ${error.message}`);
        failed++;
    }
}

function response() {
    return {
        statusCode: 0,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function reset() {
    FakeProducts.__docs.splice(0);
    FakeOrders.__docs.splice(0);
    FakeProducts.__beforeFindOneAndUpdate = null;
}

const sellerA = new ObjectId();
const sellerB = new ObjectId();
const buyer = { _id: new ObjectId(), name: "Buyer", phone_number: "0100000000", GPS_URL: "https://maps.test/location", whatsApp_number: "0100000000" };
const product = (seller, quantity = 5) => ({
    _id: new ObjectId(), seller_id: seller, name: "Used phone", price: 100, discount: 0,
    quantity, images: ["https://images.test/phone.jpg"], section: new ObjectId(), description: "good",
});
const orderRequest = (items) => ({ user: buyer, body: { products: items }, io: { to: () => ({ emit: () => {} }) } });
const updateRequest = (id, quantity, extra = {}) => ({
    user: { _id: sellerA, role: "seller" },
    body: {
        product_id: String(id), product_name: "Updated phone", product_description: "updated",
        product_price: 100, product_discount: 0, quantity, section: String(new ObjectId()),
        images: ["https://images.test/updated.jpg"], ...extra,
    },
    io: null,
});

(async () => {
    console.log("\n=== LOGIC-01 multi-seller order barrier ===");
    await test("mixed-seller cart returns 400 before stock deduction", async () => {
        reset();
        const first = product(sellerA);
        const second = product(sellerB);
        FakeProducts.__seed([first, second]);
        const res = response();
        await order(orderRequest([{ id: String(first._id), quantity: 1 }, { id: String(second._id), quantity: 1 }]), res);
        assert.strictEqual(res.statusCode, 400);
        assert.match(res.body.message, /more than one seller/i);
        assert.deepStrictEqual(FakeProducts.__docs.map((item) => item.quantity), [5, 5]);
        assert.strictEqual(FakeOrders.__docs.length, 0);
    });
    await test("single-seller cart creates an order and deducts stock", async () => {
        reset();
        const first = product(sellerA);
        FakeProducts.__seed([first]);
        const res = response();
        await order(orderRequest([{ id: String(first._id), quantity: 2 }]), res);
        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(FakeProducts.__docs[0].quantity, 3);
    });
    await test("duplicate product entries merge into one single-seller order", async () => {
        reset();
        const first = product(sellerA);
        FakeProducts.__seed([first]);
        const res = response();
        await order(orderRequest([{ id: String(first._id), quantity: 1 }, { id: String(first._id), quantity: 2 }]), res);
        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(FakeProducts.__docs[0].quantity, 2);
        assert.strictEqual(FakeOrders.__docs[0].products.length, 1);
        assert.strictEqual(FakeOrders.__docs[0].products[0].quantity, 3);
    });
    await test("product missing seller_id is rejected before stock deduction", async () => {
        reset();
        const first = product(null);
        FakeProducts.__seed([first]);
        const res = response();
        await order(orderRequest([{ id: String(first._id), quantity: 1 }]), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(FakeProducts.__docs[0].quantity, 5);
    });
    await test("inactive product is rejected before stock deduction", async () => {
        reset();
        const first = { ...product(sellerA), is_active: false };
        FakeProducts.__seed([first]);
        const res = response();
        await order(orderRequest([{ id: String(first._id), quantity: 1 }]), res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(FakeProducts.__docs[0].quantity, 5);
    });

    console.log("\n=== LOGIC-02 atomic stock edits ===");
    await test("concurrent order deduction is preserved when the seller raises stock", async () => {
        reset();
        const item = product(sellerA, 5);
        FakeProducts.__seed([item]);
        FakeProducts.__beforeFindOneAndUpdate = async () => {
            FakeProducts.__beforeFindOneAndUpdate = null;
            await FakeProducts.updateOne({ _id: item._id }, { $inc: { quantity: -3 } });
        };
        const res = response();
        await updateProduct(updateRequest(item._id, 7), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(FakeProducts.__docs[0].quantity, 4); // 5 - 3 + (7 - 5)
    });
    await test("a lower quantity cannot make stock negative after a concurrent sale", async () => {
        reset();
        const item = product(sellerA, 5);
        FakeProducts.__seed([item]);
        FakeProducts.__beforeFindOneAndUpdate = async () => {
            FakeProducts.__beforeFindOneAndUpdate = null;
            await FakeProducts.updateOne({ _id: item._id }, { $inc: { quantity: -3 } });
        };
        const res = response();
        await updateProduct(updateRequest(item._id, 1), res);
        assert.strictEqual(res.statusCode, 409);
        assert.strictEqual(FakeProducts.__docs[0].quantity, 2);
    });
    await test("expected_quantity detects a stale product form", async () => {
        reset();
        const item = product(sellerA, 2);
        FakeProducts.__seed([item]);
        const res = response();
        await updateProduct(updateRequest(item._id, 4, { expected_quantity: 5 }), res);
        assert.strictEqual(res.statusCode, 409);
        assert.strictEqual(FakeProducts.__docs[0].quantity, 2);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
})();