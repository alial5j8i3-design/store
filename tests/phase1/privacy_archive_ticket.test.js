const assert = require("assert");
const path = require("path");
const { makeFakeModel, realSchema, ObjectId } = require("./mock_models");
const PROJECT = path.join(__dirname, "..", "..");
// Load real schemas BEFORE any test injects a fake over models/*.js (realSchema caches them).
for (const file of ["order", "products", "order_archive", "ticket"]) realSchema(file);
function inject(rel, value) { const abs = require.resolve(path.join(PROJECT, rel)); require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: value }; }
function res() { return { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

(async () => {
    let failed = 0;
    const run = async (name, fn) => { try { await fn(); console.log(`PASS - ${name}`); } catch (e) { failed++; console.error(e); } };

    await run("public product contact data uses store fields, not personal seller fields", async () => {
        const sellerId = new ObjectId(), storeId = new ObjectId();
        const products = {
            find() { return { select() { return this; }, populate() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [{ _id: new ObjectId(), seller_id: sellerId, store_id: storeId, name: "P" }] }; },
            countDocuments: async () => 1,
        };
        const users = { find() { return { select() { return this; }, lean: async () => [{ _id: sellerId, name: "Seller", phone_number: "PRIVATE", whatsApp_number: "PRIVATE-W" }] }; } };
        const stores = { find() { return { select() { return this; }, lean: async () => [{ _id: storeId, slug: "seller", store_phone: "STORE", store_whatsApp_number: "STORE-W" }] }; } };
        inject("models/products.js", products); inject("models/users.js", users); inject("models/store.js", stores);
        inject("utils/cache.js", { get: async () => null, set: async () => {}, getProductsEpoch: async () => 0, PRODUCTS_CACHE_TTL_SECONDS: 60 });
        delete require.cache[require.resolve(path.join(PROJECT, "controller/get_products.controller.js"))];
        const getProducts = require(path.join(PROJECT, "controller/get_products.controller.js"));
        const response = res(); await getProducts({ query: {} }, response);
        assert.strictEqual(response.body.data[0].seller_phone, "STORE");
        assert.strictEqual(response.body.data[0].seller_whatsapp, "STORE-W");
        assert.ok(!JSON.stringify(response.body).includes("PRIVATE"));
    });

    await run("order deletion archives first and archive failure preserves the order", async () => {
        const orders = makeFakeModel("orders", { schema: realSchema("order") }), products = makeFakeModel("products", { schema: realSchema("products") }), archives = makeFakeModel("order_archive", { schema: realSchema("order_archive") });
        const seller = new ObjectId(), orderId = new ObjectId();
        const initial = { _id: orderId, updatedAt: new Date(), user_id: "buyer", orderNumber: "ORD-1", status: "delivered", total_price: 1, products: [{ seller_id: String(seller), product: new ObjectId(), price: 1, quantity: 1 }] };
        orders.__seed([{ ...initial }]);
        inject("models/order.js", orders); inject("models/products.js", products); inject("models/order_archive.js", archives);
        inject("utils/order_stock.js", { ACTIVE_STATUSES: ["new", "processing", "shipped"], restoreOrderItems: async () => ({ failed: [] }) });
        inject("utils/socket_events.js", { user_room: (id) => `user:${id}` });
        delete require.cache[require.resolve(path.join(PROJECT, "controller/delete_order.controller.js"))];
        const del = require(path.join(PROJECT, "controller/delete_order.controller.js"));
        let response = res(); await del({ user: { _id: seller }, body: { order_id: String(orderId) } }, response);
        assert.strictEqual(response.statusCode, 200); assert.strictEqual(archives.__docs.length, 1); assert.strictEqual(orders.__docs.length, 0);

        const failureOrders = makeFakeModel("orders", { schema: realSchema("order") }); failureOrders.__seed([{ ...initial, _id: new ObjectId() }]);
        inject("models/order.js", failureOrders); inject("models/order_archive.js", { create: async () => { throw new Error("archive down"); } });
        delete require.cache[require.resolve(path.join(PROJECT, "controller/delete_order.controller.js"))];
        const delFailure = require(path.join(PROJECT, "controller/delete_order.controller.js")); response = res();
        await delFailure({ user: { _id: seller }, body: { order_id: String(failureOrders.__docs[0]._id) } }, response);
        assert.strictEqual(response.statusCode, 500); assert.strictEqual(failureOrders.__docs.length, 1);
    });

    await run("tickets reject foreign orders, sixth daily ticket, and unapproved image hosts", async () => {
        const owner = new ObjectId(), customer = new ObjectId();
        const store = { findOne: () => ({ select: () => ({ lean: async () => ({ _id: new ObjectId(), owner_id: owner }) }) }) };
        const tickets = makeFakeModel("ticket", { schema: realSchema("ticket") }); tickets.ISSUE_TYPES = ["other", "damaged"]; tickets.STATUSES = [];
        let count = 0; tickets.countDocuments = async () => count;
        const orders = { exists: async () => null };
        inject("models/store.js", store); inject("models/ticket.js", tickets); inject("models/order.js", orders); inject("utils/socket_events.js", { seller_room: (id) => `seller:${id}` });
        process.env.ALLOWED_IMAGE_HOSTS = "images.example.test";
        delete require.cache[require.resolve(path.join(PROJECT, "controller/ticket.controller.js"))];
        const { create_ticket } = require(path.join(PROJECT, "controller/ticket.controller.js"));
        const base = { params: { slug: "store" }, user: { _id: customer, name: "Customer" }, body: { issue_type: "other", phone_number: "0100000000", details: "enough details" } };
        let response = res(); await create_ticket({ ...base, body: { ...base.body, order_number: "ORD-foreign" } }, response); assert.strictEqual(response.statusCode, 400);
        count = 5; response = res(); await create_ticket(base, response); assert.strictEqual(response.statusCode, 429);
        count = 0; response = res(); await create_ticket({ ...base, body: { ...base.body, photo_url: "https://bad.example.test/x.png" } }, response); assert.strictEqual(response.statusCode, 400);
    });
    process.exitCode = failed ? 1 : 0;
})();