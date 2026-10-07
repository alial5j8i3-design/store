// Integration tests against a REAL MongoDB (mongodb-memory-server) using the REAL project models.
// They pin down the behaviours the offline fake (tests/phase1/mock_models.js) claims to imitate.
//
//   npm run test:integration
//
// If mongod cannot be started the run prints SKIPPED and exits 0 (nothing was verified).
// Set REQUIRE_REAL_DB=1 (e.g. in CI) to turn a skip into a failure.
const assert = require("assert");
const path = require("path");
const { startMemoryMongo } = require("./mongo_memory");

const MODELS = path.join(__dirname, "..", "..", "models");
let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS - ${name}`); passed++; }
    catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++; }
}

(async () => {
    let db;
    try {
        db = await startMemoryMongo();
    } catch (e) {
        if (e.code !== "MONGOD_UNAVAILABLE") throw e;
        console.log(`SKIPPED - real-MongoDB integration tests did NOT run (${e.message}).`);
        console.log("          Nothing was verified against a real database.");
        process.exit(process.env.REQUIRE_REAL_DB === "1" ? 1 : 0);
    }

    const { ObjectId } = db.mongoose.Types;
    const Products = require(path.join(MODELS, "products"));
    const Orders = require(path.join(MODELS, "order"));

    try {
        console.log("=== ObjectId vs string (real BSON semantics) ===");
        await test("a string never matches a stored ObjectId on an undeclared/raw query, and vice versa", async () => {
            await db.clear();
            const id = new ObjectId();
            await Products.collection.insertOne({ owner_obj: id, owner_str: String(id) });
            const c = Products.collection;
            assert.strictEqual(await c.countDocuments({ owner_obj: id }), 1);
            assert.strictEqual(await c.countDocuments({ owner_obj: String(id) }), 0);
            assert.strictEqual(await c.countDocuments({ owner_str: String(id) }), 1);
            assert.strictEqual(await c.countDocuments({ owner_str: id }), 0);
        });
        await test("Mongoose casts a string to ObjectId on a DECLARED path (products.seller_id)", async () => {
            await db.clear();
            const seller = new ObjectId();
            await Products.collection.insertOne({ seller_id: seller, store_id: new ObjectId(), name: "p", quantity: 1 });
            assert.strictEqual(await Products.countDocuments({ seller_id: String(seller) }), 1);
        });
        await test("Mongoose does NOT cast inside Mixed arrays: reviews._id string does not match an ObjectId", async () => {
            await db.clear();
            const rid = new ObjectId();
            await Products.collection.insertOne({ name: "p", reviews: [{ _id: rid, rating: 1 }] });
            assert.strictEqual(await Products.countDocuments({ "reviews._id": String(rid) }), 0);
            assert.strictEqual(await Products.countDocuments({ "reviews._id": rid }), 1);
        });

        console.log("\n=== Update operators ===");
        await test("$pull on Mixed reviews: string id removes nothing, ObjectId id removes the review", async () => {
            await db.clear();
            const rid = new ObjectId();
            const { insertedId } = await Products.collection.insertOne({ name: "p", reviews: [{ _id: rid, rating: 1 }] });
            const byString = await Products.updateOne({ _id: insertedId }, { $pull: { reviews: { _id: String(rid) } } });
            assert.strictEqual(byString.modifiedCount, 0);
            const byOid = await Products.updateOne({ _id: insertedId }, { $pull: { reviews: { _id: rid } } });
            assert.strictEqual(byOid.modifiedCount, 1);
        });
        await test("conditional $inc with $gte: concurrent decrements never oversell", async () => {
            await db.clear();
            const { insertedId } = await Products.collection.insertOne({ name: "p", quantity: 3 });
            const results = await Promise.all(Array.from({ length: 10 }, () =>
                Products.findOneAndUpdate({ _id: insertedId, quantity: { $gte: 1 } }, { $inc: { quantity: -1 } })));
            assert.strictEqual(results.filter(Boolean).length, 3);
            assert.strictEqual((await Products.collection.findOne({ _id: insertedId })).quantity, 0);
        });
        await test("findOneAndUpdate returns the old document unless { new: true }", async () => {
            await db.clear();
            const { insertedId } = await Products.collection.insertOne({ name: "p", quantity: 5 });
            const before = await Products.findOneAndUpdate({ _id: insertedId }, { $inc: { quantity: 1 } }).lean();
            assert.strictEqual(before.quantity, 5);
            const after = await Products.findOneAndUpdate({ _id: insertedId }, { $inc: { quantity: 1 } }, { new: true }).lean();
            assert.strictEqual(after.quantity, 7);
        });
        await test("$push guarded by $ne on seller and reviewer: second identical review matches nothing", async () => {
            await db.clear();
            const seller = new ObjectId();
            const { insertedId } = await Products.collection.insertOne({ name: "p", seller_id: seller, reviews: [] });
            const buyer = String(new ObjectId());
            const attempt = () => Products.updateOne(
                { _id: insertedId, seller_id: { $ne: new ObjectId() }, "reviews.user_id": { $ne: buyer } },
                { $push: { reviews: { _id: new ObjectId(), user_id: buyer, rating: 5 } } });
            assert.strictEqual((await attempt()).matchedCount, 1);
            assert.strictEqual((await attempt()).matchedCount, 0);
        });

        console.log("\n=== Schema validation ===");
        await test("products.quantity min is enforced by validate()", async () => {
            const doc = new Products({ name: "p", quantity: -1 });
            const err = doc.validateSync();
            assert.ok(err && err.errors.quantity, "negative quantity must fail validation");
        });
        await test("orders.status enum is enforced by findOneAndUpdate({ runValidators: true })", async () => {
            await db.clear();
            const { insertedId } = await Orders.collection.insertOne({ status: "new" });
            await assert.rejects(
                () => Orders.findOneAndUpdate({ _id: insertedId }, { $set: { status: "nonsense" } }, { runValidators: true }),
                (e) => e.name === "ValidationError");
        });
    } finally {
        await db.stop();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });