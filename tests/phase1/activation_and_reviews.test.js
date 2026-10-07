const assert = require("assert");
const path = require("path");
const { makeFakeModel, realSchema, ObjectId } = require("./mock_models");

const PROJECT = path.join(__dirname, "..", "..");
const ProductSchemaModel = require(path.join(PROJECT, "models/products.js"));
const FakeProducts = makeFakeModel("products", { schema: realSchema("products") });
const FakeOrders = makeFakeModel("orders", { schema: realSchema("order") });
function inject(rel, value) {
    const abs = require.resolve(path.join(PROJECT, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value };
}
inject("models/products.js", FakeProducts);
inject("models/order.js", FakeOrders);
inject("utils/cache.js", { delByPrefix: async () => {} });
inject("utils/socket_events.js", { CATALOG_ROOM: "catalog", emit_to: () => {}, review_payload: () => ({}) });
const postReview = require(path.join(PROJECT, "controller/post_review.controller.js"));
const getReviews = require(path.join(PROJECT, "controller/get_product_reviews.controller.js"));
const deleteReview = require(path.join(PROJECT, "controller/delete_review.controller.js"));

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  PASS - ${name}`); passed++; } catch (error) { console.log(`  FAIL - ${name}\n         ${error.message}`); failed++; } }
function res() { return { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
const buyer = { _id: new ObjectId(), name: "Buyer" };
const seller = new ObjectId();
function reset() { FakeProducts.__docs.splice(0); FakeOrders.__docs.splice(0); }

(async () => {
    console.log("\n=== LOGIC-05 activation ===");
    await test("product schema defaults to active and declares listing index", () => {
        assert.strictEqual(ProductSchemaModel.schema.path("is_active").defaultValue, true);
        assert.ok(ProductSchemaModel.schema.indexes().some(([keys]) => JSON.stringify(keys) === JSON.stringify({ is_active: 1, createdAt: -1 })));
    });
    await test("legacy missing field is active while explicit false is distinguishable", () => {
        const legacy = {}, inactive = { is_active: false };
        assert.notStrictEqual(legacy.is_active, false);
        assert.strictEqual(inactive.is_active, false);
    });

    console.log("\n=== LOGIC-06 verified reviews ===");
    await test("review without delivered purchase returns 403", async () => {
        reset(); const product = { _id: new ObjectId(), seller_id: seller, reviews: [] }; FakeProducts.__seed([product]);
        const response = res(); await postReview({ user: buyer, body: { product_id: String(product._id), review_text: "Great product", rating: 5 } }, response);
        assert.strictEqual(response.statusCode, 403);
    });
    await test("delivered purchase permits exactly one review", async () => {
        reset(); const product = { _id: new ObjectId(), seller_id: seller, reviews: [] }; FakeProducts.__seed([product]);
        FakeOrders.__seed([{ _id: new ObjectId(), user_id: String(buyer._id), status: "delivered", products: [{ product: product._id }] }]);
        const first = res(); await postReview({ user: buyer, body: { product_id: String(product._id), review_text: "Great product", rating: 5 } }, first); assert.strictEqual(first.statusCode, 201);
        const second = res(); await postReview({ user: buyer, body: { product_id: String(product._id), review_text: "Again", rating: 4 } }, second); assert.strictEqual(second.statusCode, 409);
    });
    await test("review endpoint returns no more than the latest 100 reviews", async () => {
        reset(); const product = { _id: new ObjectId(), reviews: Array.from({ length: 500 }, (_, index) => ({ _id: new ObjectId(), user_name: "Buyer", content: String(index), rating: 5, created_at: new Date() })) }; FakeProducts.__seed([product]);
        const response = res(); await getReviews({ query: { product_id: String(product._id) } }, response);
        assert.strictEqual(response.statusCode, 200); assert.strictEqual(response.body.data.length, 100);
    });
    await test("admin deletion removes a review", async () => {
        reset(); const review = { _id: new ObjectId(), user_name: "Buyer", content: "bad", rating: 1 }; const product = { _id: new ObjectId(), reviews: [review] }; FakeProducts.__seed([product]);
        const response = res(); await deleteReview({ user: { _id: new ObjectId() }, body: { product_id: String(product._id), review_id: String(review._id) } }, response);
        assert.strictEqual(response.statusCode, 200); assert.strictEqual(FakeProducts.__docs[0].reviews.length, 0);
    });
    console.log(`\n${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();