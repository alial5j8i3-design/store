// End-to-end HTTP tests for the Phase 1 routes.
//
// What is REAL here: Express, cookie-parser, the real router files, the
// real auth middlewares (JWT verification from the httpOnly `token`
// cookie), the real controllers and utils/store_fields.js.
// What is FAKED: the Mongoose models (in-memory, see mock_models.js) and
// the cache layer - no MongoDB/Redis is reachable in the sandbox these
// were written in. Nothing here proves real-MongoDB behaviour (unique
// index enforcement, ObjectId casting in real queries, ...); see README.
//
// The JWT secret is generated randomly at runtime - no secret is stored
// in this file.

const path = require("path");
const crypto = require("crypto");
const assert = require("assert");

process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");

const PROJECT = path.join(__dirname, "..", "..");
const { makeFakeModel, realSchema, ObjectId } = require("./mock_models");

const FakeStore = makeFakeModel("store", { requiredFields: ["owner_id", "store_name"], uniqueFields: ["owner_id"], schema: realSchema("store") });
const FakeProducts = makeFakeModel("products", { requiredFields: ["seller_id", "store_id", "quantity", "section"], schema: realSchema("products") });
const FakeUsers = makeFakeModel("user", { schema: realSchema("users") });
// Product creation validates that the referenced section exists.  This
// HTTP suite intentionally does not exercise section CRUD, so model that
// dependency explicitly instead of letting the real Mongoose model buffer
// against an unavailable database.
const FakeSections = { exists: async () => ({ _id: new ObjectId() }) };

function inject(rel, exportsValue) {
    const abs = require.resolve(path.join(PROJECT, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsValue };
}
inject("models/store.js", FakeStore);
inject("models/products.js", FakeProducts);
inject("models/users.js", FakeUsers);
inject("models/section.js", FakeSections);
inject("utils/cache.js", {
    get: async () => null,
    set: async () => true,
    del: async () => {},
    delByPrefix: async () => {},
    flushAll: async () => {},
});

const express = require(path.join(PROJECT, "node_modules/express"));
const cookieParser = require(path.join(PROJECT, "node_modules/cookie-parser"));
const jwt = require(path.join(PROJECT, "node_modules/jsonwebtoken"));

const app = express();
app.use(cookieParser());
app.use(express.json());
for (const r of [
    "seller_store", "admin_store", "add_products", "update_produt",
    "delete_product", "get_seller_products",
]) {
    app.use(require(path.join(PROJECT, `routes/${r}.router.js`)));
}

// ---- users ----
const mk = (name, role) => ({ _id: new ObjectId(), name, email: `${name}@t.test`, role });
const sellerA = mk("sellerA", "seller");
const sellerB = mk("sellerB", "seller");
const buyer = mk("buyer", "user");
const admin = mk("admin", "super_admin");
FakeUsers.__seed([sellerA, sellerB, buyer, admin]);

const cookieFor = (u, opts) => `token=${jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, opts)}`;

let base;
async function call(method, url, { as, body, cookie } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (as) headers.Cookie = cookieFor(as);
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await r.json(); } catch (_) { /* empty */ }
    return { status: r.status, body: json };
}

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS - ${name}`); passed++; }
    catch (e) { console.log(`  FAIL - ${name}\n         ${e.message}`); failed++; }
}
const eq = (a, b, m) => assert.strictEqual(a, b, m);

const SECTION = String(new ObjectId());
const productBody = (extra = {}) => ({
    product_name: "Used laptop", product_description: "good", product_price: 1000,
    product_discount: 0, quantity: 3, section: SECTION, images: ["https://img.test/a.jpg"], ...extra,
});

(async () => {
    const server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    let storeA, storeB, prodA, prodB;

    console.log("\n=== Authentication / role gates (real middleware) ===");
    await test("no cookie -> 401 on seller store", async () => eq((await call("GET", "/api/seller/store")).status, 401));
    await test("garbage token -> 401", async () => eq((await call("GET", "/api/seller/store", { cookie: "token=abc.def.ghi" })).status, 401));
    await test("token signed with a different secret -> 401", async () => {
        const bad = jwt.sign({ id: String(sellerA._id) }, "some-other-secret");
        eq((await call("GET", "/api/seller/store", { cookie: `token=${bad}` })).status, 401);
    });
    await test("expired token -> 401", async () => {
        const c = cookieFor(sellerA, { expiresIn: -10 });
        eq((await call("GET", "/api/seller/store", { cookie: c })).status, 401);
    });
    await test("valid token for a user that no longer exists -> 401", async () => {
        const ghost = { _id: new ObjectId() };
        eq((await call("GET", "/api/seller/store", { as: ghost })).status, 401);
    });
    await test("normal user -> 403 on seller store / add product / update / delete", async () => {
        eq((await call("GET", "/api/seller/store", { as: buyer })).status, 403);
        eq((await call("POST", "/api/seller/add_product", { as: buyer, body: productBody() })).status, 403);
        eq((await call("PUT", "/api/admin/update_product", { as: buyer, body: productBody({ product_id: String(new ObjectId()) }) })).status, 403);
        eq((await call("DELETE", "/api/seller/delete_product", { as: buyer, body: { product_id: String(new ObjectId()) } })).status, 403);
    });
    await test("seller -> 403 on admin store routes", async () => {
        eq((await call("GET", "/api/admin/stores", { as: sellerA })).status, 403);
        eq((await call("PUT", `/api/admin/store/${new ObjectId()}`, { as: sellerA, body: { store_name: "x" } })).status, 403);
    });
    await test("unauthenticated -> 401 on admin routes", async () => eq((await call("GET", "/api/admin/stores")).status, 401));

    console.log("\n=== Store CRUD is owner-scoped ===");
    await test("seller A without a store: GET 404, add_product 400", async () => {
        eq((await call("GET", "/api/seller/store", { as: sellerA })).status, 404);
        eq((await call("POST", "/api/seller/add_product", { as: sellerA, body: productBody() })).status, 400);
    });
    await test("create store: owner comes from token, body owner_id ignored", async () => {
        const r = await call("POST", "/api/seller/store", {
            as: sellerA,
            body: { store_name: "Store A", store_phone: "+20 10 123 4567", owner_id: String(sellerB._id), _id: String(new ObjectId()) },
        });
        eq(r.status, 201);
        eq(String(r.body.data.owner_id), String(sellerA._id));
        storeA = r.body.data;
    });
    await test("seller B creates own store", async () => {
        const r = await call("POST", "/api/seller/store", { as: sellerB, body: { store_name: "Store B" } });
        eq(r.status, 201);
        storeB = r.body.data;
    });
    await test("second create by same seller -> 409", async () => eq((await call("POST", "/api/seller/store", { as: sellerA, body: { store_name: "again" } })).status, 409));
    await test("missing store_name -> 400; non-string store_name -> 400; too long -> 400", async () => {
        eq((await call("POST", "/api/seller/store", { as: buyer, body: { store_name: "x" } })).status, 403);
        const noName = mk("noName", "seller"); FakeUsers.__seed([noName]);
        eq((await call("POST", "/api/seller/store", { as: noName, body: {} })).status, 400);
        eq((await call("POST", "/api/seller/store", { as: noName, body: { store_name: { $ne: 1 } } })).status, 400);
        eq((await call("POST", "/api/seller/store", { as: noName, body: { store_name: "a".repeat(500) } })).status, 400);
    });
    await test("seller A reads only their own store", async () => {
        const r = await call("GET", "/api/seller/store", { as: sellerA });
        eq(r.status, 200);
        eq(r.body.data.store_name, "Store A");
    });
    await test("seller A updates own store; owner_id in body cannot move it; B's store untouched", async () => {
        const r = await call("PUT", "/api/seller/store", {
            as: sellerA, body: { store_name: "Store A v2", owner_id: String(sellerB._id) },
        });
        eq(r.status, 200);
        eq(String(r.body.data.owner_id), String(sellerA._id));
        const b = await call("GET", "/api/seller/store", { as: sellerB });
        eq(b.body.data.store_name, "Store B");
    });
    await test("PUT with no updatable fields -> 400", async () => eq((await call("PUT", "/api/seller/store", { as: sellerA, body: { owner_id: "x" } })).status, 400));

    console.log("\n=== Product CRUD is owner-scoped (IDOR) ===");
    await test("create product: seller_id/store_id forced from token, client values ignored", async () => {
        const r = await call("POST", "/api/seller/add_product", {
            as: sellerA, body: productBody({ seller_id: String(sellerB._id), store_id: String(storeB._id) }),
        });
        eq(r.status, 201);
        eq(String(r.body.data.seller_id), String(sellerA._id));
        eq(String(r.body.data.store_id), String(storeA._id));
        prodA = r.body.data;
    });
    await test("seller B creates own product", async () => {
        const r = await call("POST", "/api/seller/add_product", { as: sellerB, body: productBody({ product_name: "B item" }) });
        eq(r.status, 201);
        prodB = r.body.data;
        eq(String(prodB.store_id), String(storeB._id));
    });
    await test("A's product list has only A's product; ?seller_id=B is ignored", async () => {
        const r = await call("GET", `/api/get_seller_products?seller_id=${sellerB._id}`, { as: sellerA });
        eq(r.status, 200);
        assert.deepStrictEqual(r.body.data.map((p) => String(p._id)), [String(prodA._id)]);
    });
    await test("SECURITY: B cannot update A's product (404) and it stays unchanged", async () => {
        const r = await call("PUT", "/api/admin/update_product", { as: sellerB, body: productBody({ product_id: String(prodA._id), product_name: "HACKED" }) });
        eq(r.status, 404);
        const still = FakeProducts.__docs.find((d) => String(d._id) === String(prodA._id));
        eq(still.name, "Used laptop");
    });
    await test("SECURITY: A cannot update B's product (404)", async () => {
        eq((await call("PUT", "/api/admin/update_product", { as: sellerA, body: productBody({ product_id: String(prodB._id), product_name: "HACKED" }) })).status, 404);
    });
    await test("SECURITY: B cannot delete A's product; A cannot delete B's", async () => {
        eq((await call("DELETE", "/api/seller/delete_product", { as: sellerB, body: { product_id: String(prodA._id) } })).status, 404);
        eq((await call("DELETE", "/api/seller/delete_product", { as: sellerA, body: { product_id: String(prodB._id) } })).status, 404);
        eq(FakeProducts.__docs.length, 2);
    });
    await test("seller A updates own product; ownership fields can't be reassigned via body", async () => {
        const r = await call("PUT", "/api/admin/update_product", {
            as: sellerA, body: productBody({ product_id: String(prodA._id), product_name: "A v2", quantity: 7, seller_id: String(sellerB._id), store_id: String(storeB._id) }),
        });
        eq(r.status, 200);
        eq(r.body.data.name, "A v2");
        eq(r.body.data.quantity, 7);
        eq(String(r.body.data.seller_id), String(sellerA._id));
        eq(String(r.body.data.store_id), String(storeA._id));
    });
    await test("invalid ObjectIds / operator objects -> 400", async () => {
        eq((await call("PUT", "/api/admin/update_product", { as: sellerA, body: productBody({ product_id: "abc" }) })).status, 400);
        eq((await call("PUT", "/api/admin/update_product", { as: sellerA, body: productBody({ product_id: { $ne: null } }) })).status, 400);
        eq((await call("DELETE", "/api/seller/delete_product", { as: sellerA, body: { product_id: "abc" } })).status, 400);
        eq((await call("DELETE", "/api/seller/delete_product", { as: sellerA, body: { product_id: { $ne: null } } })).status, 400);
        eq((await call("POST", "/api/seller/add_product", { as: sellerA, body: productBody({ section: "nope" }) })).status, 400);
        eq((await call("GET", "/api/admin/store/not-an-id", { as: admin })).status, 400);
    });
    await test("negative quantity / bad price rejected (400)", async () => {
        eq((await call("POST", "/api/seller/add_product", { as: sellerA, body: productBody({ quantity: -1 }) })).status, 400);
        eq((await call("POST", "/api/seller/add_product", { as: sellerA, body: productBody({ product_price: "abc" }) })).status, 400);
    });

    console.log("\n=== Super admin (global) ===");
    await test("super_admin lists all stores", async () => {
        const r = await call("GET", "/api/admin/stores", { as: admin });
        eq(r.status, 200);
        eq(r.body.pagination.totalStores, 2); // store A and store B (the rejected creates made none)
    });
    await test("super_admin edits B's store content; cannot reassign owner", async () => {
        const r = await call("PUT", `/api/admin/store/${storeB._id}`, { as: admin, body: { store_name: "Store B (moderated)", owner_id: String(sellerA._id) } });
        eq(r.status, 200);
        eq(r.body.data.store_name, "Store B (moderated)");
        eq(String(r.body.data.owner_id), String(sellerB._id));
    });
    await test("admin store 404 for unknown id", async () => eq((await call("GET", `/api/admin/store/${new ObjectId()}`, { as: admin })).status, 404));
    await test("super_admin updates ANY product; seller_id/store_id unchanged", async () => {
        const r = await call("PUT", "/api/admin/update_product", { as: admin, body: productBody({ product_id: String(prodB._id), product_name: "B item (moderated)" }) });
        eq(r.status, 200);
        eq(r.body.data.name, "B item (moderated)");
        eq(String(r.body.data.seller_id), String(sellerB._id));
        eq(String(r.body.data.store_id), String(storeB._id));
    });
    await test("super_admin deletes ANY product", async () => {
        eq((await call("DELETE", "/api/seller/delete_product", { as: admin, body: { product_id: String(prodB._id) } })).status, 200);
        eq(FakeProducts.__docs.length, 1);
    });
    await test("seller A deletes own product", async () => {
        eq((await call("DELETE", "/api/seller/delete_product", { as: sellerA, body: { product_id: String(prodA._id) } })).status, 200);
        eq(FakeProducts.__docs.length, 0);
    });
    await test("error responses never include internal error text", async () => {
        const r = await call("GET", "/api/seller/store", { as: sellerA });
        assert.ok(!("error" in (r.body || {})));
    });

    server.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();