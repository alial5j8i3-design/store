const path = require("path");
const fs = require("fs");
const assert = require("assert");
const PROJECT = path.join(__dirname, "..", "..");
const { makeFakeModel, realSchema, ObjectId } = require("./mock_models");
const FakeStore = makeFakeModel("store", { schema: realSchema("store") }), FakeProducts = makeFakeModel("products", { schema: realSchema("products") }), FakeUsers = makeFakeModel("user", { schema: realSchema("users") });
function inject(rel, exportsValue) { const abs = require.resolve(path.join(PROJECT, rel)); require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsValue }; }
inject("models/store.js", FakeStore); inject("models/products.js", FakeProducts); inject("models/users.js", FakeUsers);
const { get_public_store } = require(path.join(PROJECT, "controller/public_store.controller.js"));
function res() { return { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function request(slug, query = {}) { const out = res(); await get_public_store({ params: { slug }, query }, out); return out; }
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  PASS - ${name}`); passed++; } catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); failed++; } }
(async () => {
  const sellerA = { _id: new ObjectId(), role: "seller", password: "never-public", email: "a@private.test" }, sellerB = { _id: new ObjectId(), role: "seller", password: "also-private" };
  const storeA = { _id: new ObjectId(), owner_id: sellerA._id, slug: "seller-a-shop", store_name: "Seller A", store_phone: "0100", store_GPS: "https://maps.example/a" }, storeB = { _id: new ObjectId(), owner_id: sellerB._id, slug: "seller-b-shop", store_name: "Seller B" };
  FakeUsers.__seed([sellerA, sellerB]); FakeStore.__seed([storeA, storeB]);
  FakeProducts.__seed([{ _id: new ObjectId(), name: "A active", seller_id: sellerA._id, store_id: storeA._id, quantity: 2, reviews: [{ rating: 5 }], section: new ObjectId() }, { _id: new ObjectId(), name: "A inactive", seller_id: sellerA._id, store_id: storeA._id, quantity: 2, is_active: false, reviews: [{ rating: 1 }], section: new ObjectId() }, { _id: new ObjectId(), name: "B active", seller_id: sellerB._id, store_id: storeB._id, quantity: 1, reviews: [{ rating: 1 }], section: new ObjectId() }, { _id: new ObjectId(), name: "mismatched", seller_id: sellerB._id, store_id: storeA._id, quantity: 1, reviews: [{ rating: 1 }], section: new ObjectId() }, { _id: new ObjectId(), name: "sold out", seller_id: sellerA._id, store_id: storeA._id, quantity: 0, reviews: [], section: new ObjectId() }]);
  await test("public seller A store exists with only A's active product", async () => { const r = await request("seller-a-shop"); assert.equal(r.statusCode, 200); assert.deepEqual(r.body.data.products.map(p => p.name), ["A active"]); assert.equal(r.body.data.store.rating, 5); });
  await test("seller B resolves independently", async () => { const r = await request("seller-b-shop"); assert.equal(r.statusCode, 200); assert.deepEqual(r.body.data.products.map(p => p.name), ["B active"]); });
  await test("invalid and unknown slugs are rejected", async () => { assert.equal((await request("bad/slug")).statusCode, 400); assert.equal((await request("not-found")).statusCode, 404); });
  await test("response contains no private owner data", async () => { const r = await request("seller-a-shop"); const text = JSON.stringify(r.body); assert.equal(text.includes("never-public"), false); assert.equal(text.includes("a@private.test"), false); assert.equal(text.includes("owner_id"), false); });
  await test("product UIs use the public store slug link", async () => { const card = fs.readFileSync(path.join(PROJECT, "public/js/app.js"), "utf8"), details = fs.readFileSync(path.join(PROJECT, "public/product.html"), "utf8"); assert.ok(card.includes("/store/")); assert.ok(card.includes("store_slug")); assert.ok(details.includes("/store/${encodeURIComponent(p.store_slug)}")); });
  console.log(`\n${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
  // The controller graph opens an ioredis client that keeps retrying when Redis is down; exit explicitly so the test cannot hang.
  process.exit(process.exitCode);
})();