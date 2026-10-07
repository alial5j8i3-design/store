// Tests for the fake model layer itself (tests/phase1/mock_models.js).
// If these fail, every other offline test that relies on the fake is untrustworthy.
const assert = require("assert");
const { makeFakeModel, realSchema, ObjectId } = require("./mock_models");

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS - ${name}`); passed++; }
    catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++; }
}
const rejects = async (fn, pred) => {
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    assert.ok(err, "expected an error but none was thrown");
    if (pred) assert.ok(pred(err), `unexpected error: ${err.name}: ${err.message}`);
    return err;
};

// Plain model: NO schema -> nothing is cast, comparison is purely type-strict.
const plain = () => makeFakeModel("plain", {});
// Declared schema (explicit descriptor) -> Mongoose-like casting on declared paths only.
const typed = () => makeFakeModel("typed", {
    schema: {
        owner_id: { type: "ObjectId" },
        name: { type: "String" },
        quantity: { type: "Number", min: 0, max: 100 },
        status: { type: "String", enum: ["new", "done"] },
        "products.seller_id": { type: "String" },
    },
});

(async () => {
    console.log("=== Type strictness ===");
    await test("ObjectId and the same value as a string do NOT match (no schema)", async () => {
        const M = plain(); const id = new ObjectId();
        M.__seed([{ _id: new ObjectId(), owner: id, label: String(id) }]);
        assert.strictEqual((await M.find({ owner: id })).length, 1, "ObjectId must match ObjectId");
        assert.strictEqual((await M.find({ owner: String(id) })).length, 0, "string must NOT match an ObjectId");
        assert.strictEqual((await M.find({ label: String(id) })).length, 1, "string must match string");
        assert.strictEqual((await M.find({ label: id })).length, 0, "ObjectId must NOT match a string");
    });
    await test("strict typing also applies to $in, $ne, $nin, dotted paths and _id", async () => {
        const M = plain(); const id = new ObjectId(), seller = new ObjectId();
        M.__seed([{ _id: id, products: [{ seller_id: seller }] }]);
        assert.strictEqual((await M.find({ _id: String(id) })).length, 0);
        assert.strictEqual((await M.find({ _id: { $in: [String(id)] } })).length, 0);
        assert.strictEqual((await M.find({ _id: { $in: [id] } })).length, 1);
        assert.strictEqual((await M.find({ "products.seller_id": String(seller) })).length, 0);
        assert.strictEqual((await M.find({ "products.seller_id": seller })).length, 1);
        // $ne with a different type is "not equal" -> the doc still matches
        assert.strictEqual((await M.find({ "products.seller_id": { $ne: String(seller) } })).length, 1);
        assert.strictEqual((await M.find({ "products.seller_id": { $ne: seller } })).length, 0);
        assert.strictEqual((await M.find({ _id: { $nin: [String(id)] } })).length, 1);
    });
    await test("numbers and numeric strings are different types", async () => {
        const M = plain(); M.__seed([{ n: 5 }]);
        assert.strictEqual((await M.find({ n: "5" })).length, 0);
        assert.strictEqual((await M.find({ n: { $gte: "1" } })).length, 0, "range operators never cross types");
        assert.strictEqual((await M.find({ n: { $gte: 1 } })).length, 1);
    });
    await test("declared ObjectId path casts a valid string (Mongoose parity); undeclared path does not", async () => {
        const M = typed(); const id = new ObjectId();
        M.__seed([{ _id: new ObjectId(), owner_id: id, reviews: [{ _id: id }] }]);
        assert.strictEqual((await M.find({ owner_id: String(id) })).length, 1, "declared path is cast like Mongoose");
        assert.strictEqual((await M.find({ "reviews._id": String(id) })).length, 0, "Mixed/undeclared path is NOT cast");
        assert.strictEqual((await M.find({ "reviews._id": id })).length, 1);
    });
    await test("declared ObjectId path rejects an invalid id with CastError", async () => {
        const M = typed();
        await rejects(() => M.find({ owner_id: "not-an-id" }), (e) => e.name === "CastError");
    });
    await test("seeding a wrongly typed value on a declared path is rejected", async () => {
        const M = typed();
        assert.throws(() => M.__seed([{ owner_id: String(new ObjectId()) }]), (e) => e.name === "MockSeedTypeError");
    });

    console.log("\n=== Query operators ===");
    await test("$gte / $gt / $lt / $lte", async () => {
        const M = plain(); M.__seed([{ q: 1 }, { q: 3 }, { q: 5 }]);
        assert.strictEqual((await M.find({ q: { $gte: 3 } })).length, 2);
        assert.strictEqual((await M.find({ q: { $gt: 3 } })).length, 1);
        assert.strictEqual((await M.find({ q: { $lt: 3 } })).length, 1);
        assert.strictEqual((await M.find({ q: { $lte: 3 } })).length, 2);
        assert.strictEqual((await M.find({ q: { $gte: 2, $lte: 4 } })).length, 1, "multiple operators on one field are ANDed");
    });
    await test("$ne matches missing fields and checks every array element", async () => {
        const M = plain(); M.__seed([{ a: 1 }, { a: 2 }, {}, { arr: [{ u: "x" }, { u: "y" }] }]);
        assert.strictEqual((await M.find({ a: { $ne: 1 } })).length, 3);
        assert.strictEqual((await M.find({ "arr.u": { $ne: "x" } })).length, 3, "the arr doc is excluded, others stay");
        assert.strictEqual((await M.find({ "arr.u": { $ne: "z" } })).length, 4);
    });
    await test("dotted paths traverse arrays of subdocuments (products.seller_id)", async () => {
        const M = plain(); const a = new ObjectId(), b = new ObjectId();
        M.__seed([{ k: 1, products: [{ seller_id: a }, { seller_id: b }] }, { k: 2, products: [{ seller_id: b }] }, { k: 3, products: [] }]);
        assert.deepStrictEqual((await M.find({ "products.seller_id": a })).map((d) => d.k), [1]);
        assert.deepStrictEqual((await M.find({ "products.seller_id": b })).map((d) => d.k), [1, 2]);
    });
    await test("unknown query operators throw instead of being ignored", async () => {
        const M = plain(); M.__seed([{ a: 1 }]);
        await rejects(() => M.find({ a: { $bogus: 1 } }), (e) => e.name === "MockUnsupportedOperator");
        await rejects(() => M.find({ $where: "1" }), (e) => e.name === "MockUnsupportedOperator");
    });

    console.log("\n=== Update operators / findOneAndUpdate ===");
    await test("$inc increments, decrements and creates a missing field", async () => {
        const M = plain(); const id = new ObjectId(); M.__seed([{ _id: id, quantity: 10 }]);
        await M.findOneAndUpdate({ _id: id }, { $inc: { quantity: -3, sold: 3 } });
        assert.strictEqual(M.__docs[0].quantity, 7);
        assert.strictEqual(M.__docs[0].sold, 3);
    });
    await test("$inc on a non-numeric stored value throws", async () => {
        const M = plain(); M.__seed([{ q: "ten" }]);
        await rejects(() => M.updateOne({}, { $inc: { q: 1 } }));
    });
    await test("$push appends (and requires an array)", async () => {
        const M = plain(); M.__seed([{ list: [1] }, { list: "nope" }]);
        await M.updateOne({ list: { $exists: true, $ne: "nope" } }, { $push: { list: 2 } });
        assert.deepStrictEqual(M.__docs[0].list, [1, 2]);
        await rejects(() => M.updateOne({ list: "nope" }, { $push: { list: 2 } }));
    });
    await test("$pull removes by subdocument condition with strict types", async () => {
        const M = plain(); const r1 = new ObjectId(), r2 = new ObjectId();
        M.__seed([{ reviews: [{ _id: r1 }, { _id: r2 }] }]);
        await M.updateOne({}, { $pull: { reviews: { _id: String(r1) } } });
        assert.strictEqual(M.__docs[0].reviews.length, 2, "string must not pull an ObjectId subdocument");
        await M.updateOne({}, { $pull: { reviews: { _id: r1 } } });
        assert.deepStrictEqual(M.__docs[0].reviews.map((r) => String(r._id)), [String(r2)]);
    });
    await test("$pull removes scalar array members", async () => {
        const M = plain(); M.__seed([{ tags: ["a", "b", "a"] }]);
        await M.updateOne({}, { $pull: { tags: "a" } });
        assert.deepStrictEqual(M.__docs[0].tags, ["b"]);
    });
    await test("$set with dotted path creates/updates nested fields", async () => {
        const M = plain(); M.__seed([{ a: { b: 1 } }]);
        await M.updateOne({}, { $set: { "a.b": 2, "a.c.d": 3 } });
        assert.deepStrictEqual(M.__docs[0].a, { b: 2, c: { d: 3 } });
    });
    await test("conditional $inc with $gte is all-or-nothing (stock guard)", async () => {
        const M = plain(); const id = new ObjectId(); M.__seed([{ _id: id, quantity: 3 }]);
        const dec = (n) => M.findOneAndUpdate({ _id: id, quantity: { $gte: n } }, { $inc: { quantity: -n } });
        assert.ok(await dec(2));
        assert.strictEqual(await dec(2), null, "second decrement must not match");
        assert.strictEqual(M.__docs[0].quantity, 1, "stock never goes negative / partially applied");
    });
    await test("findOneAndUpdate returns the OLD document unless new:true", async () => {
        const M = plain(); const id = new ObjectId(); M.__seed([{ _id: id, v: 1 }]);
        const before = await M.findOneAndUpdate({ _id: id }, { $inc: { v: 1 } });
        assert.strictEqual(before.v, 1);
        const after = await M.findOneAndUpdate({ _id: id }, { $inc: { v: 1 } }, { new: true });
        assert.strictEqual(after.v, 3);
        const after2 = await M.findOneAndUpdate({ _id: id }, { $inc: { v: 1 } }, { returnDocument: "after" });
        assert.strictEqual(after2.v, 4);
    });
    await test("no match -> null and nothing changes; updateOne reports matched/modified", async () => {
        const M = plain(); M.__seed([{ v: 1 }]);
        assert.strictEqual(await M.findOneAndUpdate({ v: 99 }, { $inc: { v: 1 } }), null);
        assert.deepStrictEqual(await M.updateOne({ v: 99 }, { $inc: { v: 1 } }), { acknowledged: true, matchedCount: 0, modifiedCount: 0 });
        assert.deepStrictEqual(await M.updateOne({ v: 1 }, { $set: { v: 1 } }), { acknowledged: true, matchedCount: 1, modifiedCount: 0 });
        assert.strictEqual(M.__docs[0].v, 1);
    });
    await test("updateMany applies operators to every match", async () => {
        const M = plain(); M.__seed([{ s: 1, n: 0 }, { s: 1, n: 0 }, { s: 2, n: 0 }]);
        const r = await M.updateMany({ s: 1 }, { $inc: { n: 5 } });
        assert.strictEqual(r.matchedCount, 2); assert.strictEqual(r.modifiedCount, 2);
        assert.deepStrictEqual(M.__docs.map((d) => d.n), [5, 5, 0]);
    });
    await test("unknown update operators throw instead of being silently ignored", async () => {
        const M = plain(); M.__seed([{ v: 1 }]);
        await rejects(() => M.findOneAndUpdate({}, { $rename: { v: "w" } }), (e) => e.name === "MockUnsupportedOperator");
        await rejects(() => M.updateOne({}, { $set: { v: 2 }, other: 1 }), (e) => e.name === "MockUnsupportedOperator");
        assert.strictEqual(M.__docs[0].v, 1, "a rejected update must not partially apply");
    });
    await test("a plain-field update behaves like $set, never as a document replacement", async () => {
        const M = plain(); M.__seed([{ a: 1, b: 2 }]);
        await M.findOneAndUpdate({}, { a: 9 });
        assert.deepStrictEqual({ a: M.__docs[0].a, b: M.__docs[0].b }, { a: 9, b: 2 });
    });
    await test("update values are cast on declared paths ($set owner_id string -> ObjectId)", async () => {
        const M = typed(); const id = new ObjectId(); M.__seed([{ _id: new ObjectId(), owner_id: new ObjectId() }]);
        await M.updateOne({}, { $set: { owner_id: String(id) } });
        assert.ok(M.__docs[0].owner_id instanceof ObjectId && M.__docs[0].owner_id.equals(id));
    });

    console.log("\n=== Basic schema validation (min / max / enum / required) ===");
    await test("create enforces min, max and enum", async () => {
        const M = typed();
        await rejects(() => M.create({ quantity: -1 }), (e) => e.name === "ValidationError" && e.errors.quantity.kind === "min");
        await rejects(() => M.create({ quantity: 101 }), (e) => e.name === "ValidationError" && e.errors.quantity.kind === "max");
        await rejects(() => M.create({ status: "weird" }), (e) => e.name === "ValidationError" && e.errors.status.kind === "enum");
        const ok = await M.create({ quantity: 0, status: "new" });
        assert.strictEqual(ok.quantity, 0);
        assert.strictEqual(M.__docs.length, 1, "invalid documents are never stored");
    });
    await test("findOneAndUpdate({runValidators:true}) enforces min/max/enum on $set; without it, it does not (Mongoose parity)", async () => {
        const M = typed(); M.__seed([{ quantity: 5, status: "new" }]);
        await rejects(() => M.findOneAndUpdate({}, { $set: { quantity: -1 } }, { runValidators: true }), (e) => e.name === "ValidationError");
        await rejects(() => M.findOneAndUpdate({}, { $set: { quantity: 1000 } }, { runValidators: true }), (e) => e.name === "ValidationError");
        await rejects(() => M.findOneAndUpdate({}, { $set: { status: "bad" } }, { runValidators: true }), (e) => e.name === "ValidationError");
        assert.strictEqual(M.__docs[0].quantity, 5, "rejected update leaves the document untouched");
        await M.findOneAndUpdate({}, { $set: { quantity: 7, status: "done" } }, { runValidators: true });
        assert.strictEqual(M.__docs[0].quantity, 7);
        await M.findOneAndUpdate({}, { $set: { quantity: -1 } }); // no validators requested
        assert.strictEqual(M.__docs[0].quantity, -1);
    });
    await test("real project schema is honoured (products.quantity min, orders.status enum)", async () => {
        const P = makeFakeModel("products", { schema: realSchema("products") });
        const O = makeFakeModel("orders", { schema: realSchema("order") });
        await rejects(() => P.create({ seller_id: new ObjectId(), store_id: new ObjectId(), section: new ObjectId(), quantity: -1 }), (e) => e.name === "ValidationError");
        O.__seed([{ _id: new ObjectId(), status: "new" }]);
        await rejects(() => O.findOneAndUpdate({}, { $set: { status: "nonsense" } }, { runValidators: true }), (e) => e.name === "ValidationError");
    });
    await test("required fields and unique fields are enforced", async () => {
        const M = makeFakeModel("u", { requiredFields: ["email"], uniqueFields: ["email"] });
        await rejects(() => M.create({}), (e) => e.name === "ValidationError");
        await M.create({ email: "a@x.test" });
        await rejects(() => M.create({ email: "a@x.test" }), (e) => e.code === 11000);
    });
    await test("compound unique index (order_archive): same order_id + version is E11000, different version is allowed", async () => {
        const A = makeFakeModel("order_archive", { schema: realSchema("order_archive"), uniqueIndexes: [{ fields: ["order_id", "order_updated_at"] }] });
        const oid = new ObjectId(), by = new ObjectId(), t = new Date(1700000000000);
        const doc = (extra = {}) => ({ order_id: oid, order_updated_at: t, order: { x: 1 }, removed_by: by, reason: "seller_delete", ...extra });
        await A.create(doc());
        // a hex STRING order_id is cast to the same ObjectId by the real schema -> still a duplicate
        await rejects(() => A.create(doc({ order_id: String(oid), order_updated_at: new Date(t.getTime()) })), (e) => e.code === 11000);
        await A.create(doc({ order_updated_at: new Date(t.getTime() + 1) }));
        await A.create(doc({ order_id: new ObjectId() }));
        assert.strictEqual(A.__docs.length, 3);
        assert.ok(A.__docs.every((d) => d.order_id instanceof ObjectId), "stored order_id is always an ObjectId");
    });
    await test("partial compound unique index (orders idempotency): only string keys are indexed; types are compared strictly", async () => {
        const O = makeFakeModel("orders", { schema: { user_id: { type: "String" }, idempotency_key: { type: "String" } }, uniqueIndexes: [{ fields: ["user_id", "idempotency_key"], when: (d) => typeof d.idempotency_key === "string" }] });
        const save = (u, k) => O.create(k === undefined ? { user_id: u } : { user_id: u, idempotency_key: k });
        await save("u1", "k1");
        await rejects(() => save("u1", "k1"), (e) => e.code === 11000);
        await save("u2", "k1");   // other user, same key
        await save("u1", "k2");   // same user, other key
        await save("u1");         // no key: outside the partial index, may repeat
        await save("u1");
        assert.strictEqual(O.__docs.length, 5);
    });
    await test("re-saving the same document does not collide with itself on a compound unique index", async () => {
        const M = makeFakeModel("m", { uniqueIndexes: [{ fields: ["a", "b"] }] });
        const d = await M.create({ a: 1, b: 2 });
        d.c = 3; await d.save();
        assert.strictEqual(M.__docs.length, 1);
        await M.create({ a: 1, b: "2" }); // "2" is a different type than 2 -> not a duplicate
        assert.strictEqual(M.__docs.length, 2);
    });
    await test("updates (findOneAndUpdate / updateMany) that would create a duplicate compound key are rejected", async () => {
        const M = makeFakeModel("m", { uniqueIndexes: [{ fields: ["a", "b"] }] });
        M.__seed([{ a: 1, b: 1 }, { a: 1, b: 2 }]);
        await rejects(() => M.findOneAndUpdate({ b: 2 }, { $set: { b: 1 } }), (e) => e.code === 11000);
        await rejects(() => M.updateMany({ b: 2 }, { $set: { b: 1 } }), (e) => e.code === 11000);
        assert.deepStrictEqual(M.__docs.map((d) => d.b), [1, 2], "failed update must not change stored data");
    });

    console.log("\n=== Isolation / query helpers ===");
    await test("returned documents are copies; mutating them does not change stored data", async () => {
        const M = plain(); M.__seed([{ arr: [{ x: 1 }] }]);
        const d = await M.findOne({}); d.arr[0].x = 99; d.arr.push({ x: 2 });
        assert.deepStrictEqual(M.__docs[0].arr, [{ x: 1 }]);
    });
    await test("sort / skip / limit / select actually work", async () => {
        const M = plain(); M.__seed([{ n: 3, t: "c" }, { n: 1, t: "a" }, { n: 2, t: "b" }]);
        assert.deepStrictEqual((await M.find({}).sort({ n: 1 })).map((d) => d.n), [1, 2, 3]);
        assert.deepStrictEqual((await M.find({}).sort({ n: -1 }).limit(2)).map((d) => d.n), [3, 2]);
        assert.deepStrictEqual((await M.find({}).sort({ n: 1 }).skip(1).limit(1)).map((d) => d.n), [2]);
        const sel = await M.findOne({ n: 1 }).select("t");
        assert.ok(sel.t === "a" && sel.n === undefined && sel._id);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
})();