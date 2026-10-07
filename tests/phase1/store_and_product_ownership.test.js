const path = require("path");
const Module = require("module");
const assert = require("assert");

const PROJECT = path.join(__dirname, "..", "..");
const { makeFakeModel, realSchema, ObjectId } = require("./mock_models");

// ---- Build fake models ----
const FakeStore = makeFakeModel("store", { requiredFields: ["owner_id", "store_name"], uniqueFields: ["owner_id"], schema: realSchema("store") });
const FakeProducts = makeFakeModel("products", { requiredFields: ["seller_id", "store_id", "quantity", "section"], schema: realSchema("products") });
const FakeUsers = makeFakeModel("user", { schema: realSchema("users") });
const FakeSections = { exists: async () => ({ _id: new ObjectId() }) };

function injectFakeModule(relPathFromProjectRoot, exportsValue) {
    const abs = require.resolve(path.join(PROJECT, relPathFromProjectRoot));
    require.cache[abs] = {
        id: abs,
        filename: abs,
        loaded: true,
        exports: exportsValue,
    };
}

injectFakeModule("models/store.js", FakeStore);
injectFakeModule("models/products.js", FakeProducts);
injectFakeModule("models/users.js", FakeUsers);
injectFakeModule("models/section.js", FakeSections);

// utils/cache.js talks to redis/node-cache - stub it out so tests don't
// depend on Redis being configured, and so we can see cache invalidation
// calls happen.
const cacheCalls = [];
injectFakeModule("utils/cache.js", {
    get: async () => null,
    set: async () => true,
    del: async (k) => { cacheCalls.push(["del", k]); },
    delByPrefix: async (p) => { cacheCalls.push(["delByPrefix", p]); },
    flushAll: async () => {},
});

// ---- Now require the real controllers under test ----
const sellerStoreCtrl = require(path.join(PROJECT, "controller/seller_store.controller.js"));
const adminStoreCtrl = require(path.join(PROJECT, "controller/admin_store.controller.js"));
const addProductCtrl = require(path.join(PROJECT, "controller/add_products.controller.js"));
const updateProductCtrl = require(path.join(PROJECT, "controller/update_product.controller.js"));
const deleteProductCtrl = require(path.join(PROJECT, "controller/delete_product.controller.js"));
const getSellerProductsCtrl = require(path.join(PROJECT, "controller/get_seller_products.controller.js"));

// ---- Fake req/res helpers ----
function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
    return res;
}
function makeReq(overrides = {}) {
    return {
        body: {},
        query: {},
        params: {},
        user: null,
        io: { to: () => ({ emit: () => {} }) },
        ...overrides,
    };
}

let passed = 0, failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS - ${name}`);
        passed++;
    } catch (e) {
        console.log(`  FAIL - ${name}`);
        console.log(`         ${e.message}`);
        failed++;
    }
}

// ---- Fixtures ----
const sellerA = { _id: new ObjectId(), name: "Seller A", role: "seller" };
const sellerB = { _id: new ObjectId(), name: "Seller B", role: "seller" };
const normalUser = { _id: new ObjectId(), name: "Normal User", role: "user" };
const superAdmin = { _id: new ObjectId(), name: "Admin", role: "super_admin" };

(async () => {
    console.log("\n=== Seller store CRUD ===");

    let storeAId;

    await test("seller A can create their own store", async () => {
        const req = makeReq({ user: sellerA, body: { store_name: "A's Shop" } });
        const res = makeRes();
        await sellerStoreCtrl.create_my_store(req, res);
        assert.strictEqual(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.data.owner_id.toString(), sellerA._id.toString());
        storeAId = res.body.data._id;
    });

    await test("seller A cannot create a second store (409)", async () => {
        const req = makeReq({ user: sellerA, body: { store_name: "Another shop" } });
        const res = makeRes();
        await sellerStoreCtrl.create_my_store(req, res);
        assert.strictEqual(res.statusCode, 409);
    });

    await test("seller A can read their own store", async () => {
        const req = makeReq({ user: sellerA });
        const res = makeRes();
        await sellerStoreCtrl.get_my_store(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.store_name, "A's Shop");
    });

    await test("seller B has no store yet (404)", async () => {
        const req = makeReq({ user: sellerB });
        const res = makeRes();
        await sellerStoreCtrl.get_my_store(req, res);
        assert.strictEqual(res.statusCode, 404);
    });

    await test("seller A can update their own store", async () => {
        const req = makeReq({ user: sellerA, body: { store_name: "A's Renamed Shop" } });
        const res = makeRes();
        await sellerStoreCtrl.update_my_store(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.store_name, "A's Renamed Shop");
    });

    await test("SECURITY: seller A's update request cannot affect seller B (no store yet -> 404, not seller A's store)", async () => {
        // Simulates seller B trying to hit PUT /api/seller/store before
        // having a store - must get 404, and must NEVER touch seller
        // A's store even though seller A's store is the only one that
        // exists in the DB right now.
        const req = makeReq({ user: sellerB, body: { store_name: "Hijacked!" } });
        const res = makeRes();
        await sellerStoreCtrl.update_my_store(req, res);
        assert.strictEqual(res.statusCode, 404);
        const aStore = FakeStore.__docs.find((d) => String(d.owner_id) === String(sellerA._id));
        assert.strictEqual(aStore.store_name, "A's Renamed Shop", "seller A's store must be unaffected");
    });

    // Give seller B their own store for the isolation tests below.
    let storeBId;
    await test("seller B can create their own store", async () => {
        const req = makeReq({ user: sellerB, body: { store_name: "B's Shop" } });
        const res = makeRes();
        await sellerStoreCtrl.create_my_store(req, res);
        assert.strictEqual(res.statusCode, 201);
        storeBId = res.body.data._id;
    });

    await test("SECURITY: seller A updating store cannot cross into seller B's store even with owner_id in body", async () => {
        const req = makeReq({
            user: sellerA,
            body: { store_name: "still A", owner_id: sellerB._id }, // attempted mass-assignment
        });
        const res = makeRes();
        await sellerStoreCtrl.update_my_store(req, res);
        assert.strictEqual(res.statusCode, 200);
        const bStore = FakeStore.__docs.find((d) => String(d.owner_id) === String(sellerB._id));
        assert.strictEqual(bStore.store_name, "B's Shop", "seller B's store must be untouched by seller A's request");
        const aStoreOwner = FakeStore.__docs.find((d) => String(d._id) === String(storeAId)).owner_id;
        assert.strictEqual(String(aStoreOwner), String(sellerA._id), "store A's owner_id must not have been overwritten");
    });

    console.log("\n=== Admin store access ===");

    await test("super admin can list all stores", async () => {
        const req = makeReq({ user: superAdmin, query: {} });
        const res = makeRes();
        await adminStoreCtrl.list_stores(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.length, 2);
    });

    await test("super admin can update any store by id", async () => {
        const req = makeReq({ user: superAdmin, params: { store_id: String(storeBId) }, body: { store_name: "B renamed by admin" } });
        const res = makeRes();
        await adminStoreCtrl.update_store(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.store_name, "B renamed by admin");
    });

    await test("invalid ObjectId on admin store route returns 400", async () => {
        const req = makeReq({ user: superAdmin, params: { store_id: "not-an-id" }, body: { store_name: "x" } });
        const res = makeRes();
        await adminStoreCtrl.update_store(req, res);
        assert.strictEqual(res.statusCode, 400);
    });

    console.log("\n=== Product ownership ===");

    let productAId;
    await test("seller A can create a product under their own store", async () => {
        const sectionId = new ObjectId();
        const req = makeReq({
            user: sellerA,
            body: {
                product_name: "Used Phone",
                product_description: "Good condition",
                product_price: "100",
                product_discount: "0",
                quantity: "3",
                section: sectionId.toString(),
                images: ["http://img/1.jpg"],
            },
        });
        const res = makeRes();
        await addProductCtrl(req, res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.seller_id.toString(), sellerA._id.toString());
        assert.strictEqual(res.body.data.store_id.toString(), String(storeAId));
        productAId = res.body.data._id;
    });

    await test("a user with no store cannot create a product (400)", async () => {
        const sellerNoStore = { _id: new ObjectId(), name: "No Store Seller", role: "seller" };
        const req = makeReq({
            user: sellerNoStore,
            body: {
                product_name: "X", product_description: "Y", product_price: "10",
                quantity: "1", section: new ObjectId().toString(), images: ["a.jpg"],
            },
        });
        const res = makeRes();
        await addProductCtrl(req, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("seller A can update their own product", async () => {
        const req = makeReq({
            user: sellerA,
            body: {
                product_id: String(productAId),
                product_name: "Used Phone v2",
                product_description: "Still good",
                product_price: "90",
                product_discount: "0",
                quantity: "2",
                section: new ObjectId().toString(),
                images: ["http://img/2.jpg"],
            },
        });
        const res = makeRes();
        await updateProductCtrl(req, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.data.name, "Used Phone v2");
    });

    await test("SECURITY (IDOR): seller B cannot update seller A's product", async () => {
        const req = makeReq({
            user: sellerB,
            body: {
                product_id: String(productAId),
                product_name: "Hijacked!",
                product_description: "hacked",
                product_price: "1",
                product_discount: "0",
                quantity: "1",
                section: new ObjectId().toString(),
                images: ["http://img/hack.jpg"],
            },
        });
        const res = makeRes();
        await updateProductCtrl(req, res);
        assert.strictEqual(res.statusCode, 404, "must not find / must not leak / must not update another seller's product");
        const productNow = FakeProducts.__docs.find((d) => String(d._id) === String(productAId));
        assert.strictEqual(productNow.name, "Used Phone v2", "seller A's product must be unchanged");
    });

    await test("SECURITY (IDOR): seller B cannot delete seller A's product", async () => {
        const req = makeReq({ user: sellerB, body: { product_id: String(productAId) } });
        const res = makeRes();
        await deleteProductCtrl(req, res);
        assert.strictEqual(res.statusCode, 404);
        const stillThere = FakeProducts.__docs.find((d) => String(d._id) === String(productAId));
        assert.ok(stillThere, "product must still exist");
    });

    await test("seller B's own product list does not include seller A's product", async () => {
        const req = makeReq({ user: sellerB, query: {} });
        const res = makeRes();
        await getSellerProductsCtrl(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.length, 0, "seller B has created no products yet");
    });

    await test("seller A's own product list includes exactly their product", async () => {
        const req = makeReq({ user: sellerA, query: {} });
        const res = makeRes();
        await getSellerProductsCtrl(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.length, 1);
        assert.strictEqual(res.body.data[0]._id.toString(), productAId.toString());
    });

    await test("invalid ObjectId product update returns 400", async () => {
        const req = makeReq({
            user: sellerA,
            body: {
                product_id: "not-a-valid-id",
                product_name: "x", product_description: "y", product_price: "1",
                product_discount: "0", quantity: "1", section: new ObjectId().toString(), images: ["a.jpg"],
            },
        });
        const res = makeRes();
        await updateProductCtrl(req, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("finally: seller A can delete their own product", async () => {
        const req = makeReq({ user: sellerA, body: { product_id: String(productAId) } });
        const res = makeRes();
        await deleteProductCtrl(req, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();