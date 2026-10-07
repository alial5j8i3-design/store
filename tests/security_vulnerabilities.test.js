// Security vulnerability tests (Task 5): NoSQL injection, mass assignment, IDOR,
// role authorization and information exposure.
//
//   node tests/security_vulnerabilities.test.js
//
// Runs the whole suite TWICE (the second time in a child process):
//   1. production stack as in server.js, i.e. WITH express-mongo-sanitize;
//   2. SECURITY_SANITIZE=off: the sanitizer is replaced by a pass-through, so
//      each controller / validator must defend itself. A failure that appears
//      only in run 2 is a defence-in-depth gap (not directly exploitable while
//      the sanitizer stays in server.js); a failure in run 1 is exploitable.
//
// Boots the REAL server.js over HTTP; only the Mongoose models and the cache are
// in-memory fakes (see tests/support/security_harness.js). Nothing here proves
// real-MongoDB behaviour. Expectations are NOT weakened to fit current
// behaviour: a FAIL is a reported defect.

"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const { bootServer, createRunner, PASSWORD } = require("./support/security_harness");

const SANITIZE = process.env.SECURITY_SANITIZE !== "off";
const MODE = SANITIZE ? "production stack (express-mongo-sanitize ON)" : "defence-in-depth (express-mongo-sanitize OFF)";
const { test, section, finish, out } = createRunner(`security [${SANITIZE ? "sanitize ON" : "sanitize OFF"}]`);

const eq = (actual, expected, message) => assert.strictEqual(actual, expected, message);
const str = (id) => String(id);

(async () => {
    out(`\n##### ${MODE} #####`);
    const h = await bootServer({ sanitize: SANITIZE });
    const { call, models, ObjectId } = h;

    // Whole-database fingerprint: any side effect of a request shows up as a diff.
    const snap = () => Object.entries(models).map(([name, m]) => `${name}:${JSON.stringify(m.__docs)}`).join("\n");
    const find = (model, id) => models[model].__docs.find((d) => str(d._id) === str(id));
    const emptyData = (body) => {
        const d = body && body.data;
        return d === undefined || d === null || (Array.isArray(d) && d.length === 0) || (typeof d === "object" && !Array.isArray(d) && Object.keys(d).length === 0);
    };
    const leaked = (text, secrets) => secrets.filter((s) => s && text.includes(s));

    // ------------------------------------------------------------------ fixtures
    function world() {
        h.reset();
        const W = {};
        const day = 24 * 60 * 60 * 1000;
        W.sellerA = h.mkUser("SellerA", "seller", { phone_number: "+20 100 555 0001" });
        W.sellerB = h.mkUser("SellerB", "seller", { phone_number: "+20 100 555 0002" });
        W.sellerC = h.mkUser("SellerC", "seller", { phone_number: "+20 100 555 0003" }); // seller WITHOUT a store
        W.buyer1 = h.mkUser("Buyer1", "user", { phone_number: "+20 100 555 1001" });
        W.buyer2 = h.mkUser("Buyer2", "user", { phone_number: "+20 100 555 1002" });
        W.admin = h.mkUser("Admin", "super_admin", { phone_number: "+20 100 555 9000" });

        W.section = new ObjectId();
        models.sections.__seed([{ _id: W.section, name: "Phones" }]);

        W.storeA = { _id: new ObjectId(), owner_id: W.sellerA._id, store_name: "CANARY-STORE-A", slug: "canary-store-a-aaaaaa", store_phone: "+20 111 000 0001", store_description: "CANARY-DESC-A" };
        W.storeB = { _id: new ObjectId(), owner_id: W.sellerB._id, store_name: "CANARY-STORE-B", slug: "canary-store-b-bbbbbb", store_phone: "+20 111 000 0002", store_description: "CANARY-DESC-B" };
        models.store.__seed([W.storeA, W.storeB]);

        const product = (n, seller, st) => ({
            _id: new ObjectId(), name: `CANARY-PRODUCT-${n}`, description: "desc", price: n === "A" ? 100 : 200, discount: 0,
            final_price: n === "A" ? 100 : 200, images: ["https://img.test/p.jpg"], quantity: 5, section: W.section,
            seller_id: seller._id, store_id: st._id, is_active: true,
            reviews: [{ _id: new ObjectId(), user_name: "rev", content: `CANARY-REVIEW-${n}`, rating: 5 }],
        });
        W.prodA = product("A", W.sellerA, W.storeA);
        W.prodB = product("B", W.sellerB, W.storeB);
        models.products.__seed([W.prodA, W.prodB]);

        const order = (n, buyer, seller, prod, num) => ({
            _id: new ObjectId(), orderNumber: num, user_id: str(buyer._id), status: "new",
            products: [{ product: prod._id, seller_id: str(seller._id), name: prod.name, price: prod.price, quantity: 1, images: [] }],
            total_price: prod.price, user_name: buyer.name, phone_number: buyer.phone_number, GPS_URL: "https://maps.example.com/b",
            whatsApp_number: buyer.phone_number, createdAt: new Date(), updatedAt: new Date(),
        });
        W.orderA = order("A", W.buyer1, W.sellerA, W.prodA, "ORD-111111111");
        W.orderB = order("B", W.buyer2, W.sellerB, W.prodB, "ORD-222222222");
        models.orders.__seed([W.orderA, W.orderB]);

        W.couponA = { _id: new ObjectId(), name: "SELLERACODE", discount: 10, end_time: new Date(Date.now() + day), seller_id: W.sellerA._id };
        W.couponB = { _id: new ObjectId(), name: "SELLERBCODE", discount: 20, end_time: new Date(Date.now() + day), seller_id: W.sellerB._id };
        models.coupons.__seed([W.couponA, W.couponB]);

        const ticket = (n, buyer, seller, st, orderNo) => ({
            _id: new ObjectId(), store_id: st._id, seller_id: seller._id, customer_id: buyer._id, customer_name: buyer.name,
            issue_type: "other", order_number: orderNo, phone_number: buyer.phone_number, details: `CANARY-TICKET-DETAILS-${n}`,
            status: "new", createdAt: new Date(),
        });
        W.ticketA = ticket("A", W.buyer1, W.sellerA, W.storeA, "ORD-111111111");
        W.ticketB = ticket("B", W.buyer2, W.sellerB, W.storeB, "ORD-222222222");
        models.tickets.__seed([W.ticketA, W.ticketB]);

        // everything that must never appear in a response meant for somebody else
        W.allSecrets = [
            "CANARY", "@t.test", "+20 100 555", "ORD-111111111", "ORD-222222222", "SELLERACODE", "SELLERBCODE",
            ...[W.sellerA, W.sellerB, W.sellerC, W.buyer1, W.buyer2, W.admin].map((u) => str(u._id)),
            str(W.storeA._id), str(W.storeB._id), str(W.prodA._id), str(W.prodB._id), str(W.orderA._id), str(W.orderB._id),
            str(W.couponA._id), str(W.couponB._id), str(W.ticketA._id), str(W.ticketB._id),
        ];
        // identifiers/content that belong to seller A / buyer1 only
        W.aSecrets = ["CANARY-STORE-A", "CANARY-DESC-A", "CANARY-PRODUCT-A", "CANARY-REVIEW-A", "CANARY-TICKET-DETAILS-A", "ORD-111111111", "SELLERACODE",
            "+20 100 555 1001", "+20 111 000 0001", "sellera@t.test", "buyer1@t.test", str(W.orderA._id), str(W.couponA._id), str(W.ticketA._id), str(W.storeA._id)];
        W.bSecrets = ["CANARY-STORE-B", "CANARY-DESC-B", "CANARY-PRODUCT-B", "CANARY-REVIEW-B", "CANARY-TICKET-DETAILS-B", "ORD-222222222", "SELLERBCODE",
            "+20 100 555 1002", "+20 111 000 0002", "sellerb@t.test", "buyer2@t.test", str(W.orderB._id), str(W.couponB._id), str(W.ticketB._id), str(W.storeB._id)];
        return W;
    }

    const productBody = (W, extra = {}) => ({
        product_name: "Updated name", product_description: "Updated description", product_price: 150, product_discount: 0,
        quantity: 5, section: str(W.section), images: ["https://img.test/new.jpg"], ...extra,
    });

    // The request must fail with a client error, not 5xx, not rate-limited, no session cookie, no 2xx.
    function assertBlocked(r, label) {
        assert.ok(r.status >= 400 && r.status < 500 && r.status !== 429, `${label}: expected a 4xx rejection, got ${r.status} ${r.text.slice(0, 160)}`);
        assert.ok(!r.setCookie.some((c) => /^token=[^;]+/.test(c)), `${label}: a session cookie was issued`);
    }
    async function blockedWithoutSideEffects(label, method, url, opts) {
        const before = snap();
        const r = await call(method, url, opts);
        assertBlocked(r, label);
        eq(snap(), before, `${label}: the request changed stored data (${r.status} ${r.text.slice(0, 120)})`);
        return r;
    }

    // =====================================================================
    section("NoSQL injection: operators in JSON / form request bodies");
    // =====================================================================
    {
        const W = world();
        const email = W.buyer1.email;
        const loginAttacks = [
            { email: { $ne: 1 }, password: { $ne: 1 } },
            { email: { $ne: null }, password: PASSWORD },
            { email: { $gt: "" }, password: PASSWORD },
            { email: { $regex: ".*" }, password: PASSWORD },
            { email: { $in: [email] }, password: PASSWORD },
            { email, password: { $ne: "x" } },
            { email, password: { $gt: "" } },
            { email: { $ne: 1 }, password: { $ne: 1 }, $where: "1==1" },
            { email: [email], password: PASSWORD },
        ];
        for (const body of loginAttacks) {
            await test(`login with ${JSON.stringify(body)} -> rejected, no session`, async () => {
                const r = await call("POST", "/api/auth/log_in", { body });
                assertBlocked(r, "login");
                assert.ok([400, 401].includes(r.status), `status ${r.status}`);
            });
        }
        await test("login via urlencoded form: email[$ne]=1&password[$ne]=1 / email[$gt]= -> rejected", async () => {
            for (const form of ["email[$ne]=1&password[$ne]=1", `email[$gt]=&password=${PASSWORD}`, `email[$regex]=.*&password=${PASSWORD}`, `email=${email}&password[$ne]=x`]) {
                assertBlocked(await call("POST", "/api/auth/log_in", { form }), form);
            }
        });
        await test("registration with operator objects as fields -> rejected, nothing stored", async () => {
            const before = snap();
            for (const patch of [{ email: { $ne: 1 } }, { name: { $ne: 1 } }, { password: { $ne: 1 } }, { phone_number: { $gt: "" } }, { GPS_URL: { $ne: 1 } }]) {
                const r = await call("POST", "/api/auth/register", { body: { name: "X", email: "inj@t.test", password: "Passw0rd!!", phone_number: "+20 100 123 4567", whatsApp_number: "+20 100 123 4567", GPS_URL: "https://maps.example.com/p", ...patch } });
                assertBlocked(r, JSON.stringify(patch));
            }
            eq(snap(), before);
        });
        await test("registration via form-encoded operators (email[$ne]=x ...) -> rejected, nothing stored", async () => {
            const before = snap();
            const r = await call("POST", "/api/auth/register", { form: "name=X&email[$ne]=x&password=Passw0rd!!&phone_number=%2B201001234567&whatsApp_number=%2B201001234567&GPS_URL=https://maps.example.com/p" });
            assertBlocked(r, "form register");
            eq(snap(), before);
        });

        await test("POST /api/order: operators in products / id / quantity / coupon cannot bypass validation or pricing", async () => {
            const before = snap();
            const bad = [
                { products: { $ne: 1 } },
                { products: [{ id: { $ne: 1 }, quantity: 1 }] },
                { products: [{ id: { $in: [str(W.prodA._id)] }, quantity: 1 }] },
                { products: [{ id: str(W.prodA._id), quantity: { $gt: 0 } }] },
                { products: [{ id: [str(W.prodA._id)], quantity: 1 }] },
            ];
            for (const body of bad) {
                const r = await call("POST", "/api/order", { as: W.buyer2, body });
                assertBlocked(r, JSON.stringify(body));
            }
            eq(snap(), before, "an injected order changed stored data");
        });
        await test("POST /api/order: coupon given as an operator object / array is ignored - never a discount, never a 5xx", async () => {
            for (const coupon of [{ $ne: null }, { $regex: ".*" }, ["SELLERACODE"]]) {
                const r = await call("POST", "/api/order", { as: W.buyer2, body: { products: [{ id: str(W.prodA._id), quantity: 1 }], coupon } });
                assert.ok(r.status < 500, `5xx: ${r.text}`);
                if (r.status === 201) {
                    eq(r.body.data.total_price, 100, "coupon operator applied a discount");
                    assert.ok(!r.body.data.coupon_code, "coupon operator matched a coupon");
                }
            }
        });
        await test("seller order endpoints: operator ids are rejected and nothing is cancelled / deleted", async () => {
            for (const order_id of [{ $ne: 1 }, { $gt: "" }, { $regex: ".*" }, [str(W.orderA._id)]]) {
                await blockedWithoutSideEffects("update_status", "PUT", "/api/seller/update_status_of_order", { as: W.sellerA, body: { order_id, status_order: "cancelled" } });
                await blockedWithoutSideEffects("delete_order", "DELETE", "/api/seller/delete_order", { as: W.sellerA, body: { order_id } });
            }
            await blockedWithoutSideEffects("status operator", "PUT", "/api/seller/update_status_of_order", { as: W.sellerA, body: { order_id: str(W.orderA._id), status_order: { $ne: "x" } } });
        });
        await test("product endpoints: operator product_id is rejected, no product changed or deleted", async () => {
            for (const product_id of [{ $ne: 1 }, { $gt: "" }, [str(W.prodA._id)]]) {
                await blockedWithoutSideEffects("delete_product", "DELETE", "/api/seller/delete_product", { as: W.sellerA, body: { product_id } });
                await blockedWithoutSideEffects("update_product", "PUT", "/api/admin/update_product", { as: W.sellerA, body: productBody(W, { product_id }) });
            }
        });
        await test("coupon / ticket / store endpoints: operator fields are rejected without side effects", async () => {
            await blockedWithoutSideEffects("coupon name", "POST", "/api/seller/coupons", { as: W.sellerA, body: { coupon_name: { $ne: 1 }, discount: 10, end_time: new Date(Date.now() + 864e5).toISOString() } });
            await blockedWithoutSideEffects("coupon discount", "PUT", `/api/seller/coupons/${W.couponA._id}`, { as: W.sellerA, body: { discount: { $gt: 0 } } });
            await blockedWithoutSideEffects("ticket status", "PATCH", `/api/seller/tickets/${W.ticketA._id}/status`, { as: W.sellerA, body: { status: { $ne: "new" } } });
            await blockedWithoutSideEffects("store name", "PUT", "/api/seller/store", { as: W.sellerA, body: { store_name: { $ne: 1 } } });
            await blockedWithoutSideEffects("ticket create", "POST", `/api/stores/${W.storeA.slug}/tickets`, { as: W.buyer2, body: { issue_type: { $ne: 1 }, phone_number: "+20 100 000 0000", details: "0123456789 details" } });
        });
        await test("admin endpoints: operator user_id / review ids are rejected, no role / review changed", async () => {
            for (const user_id of [{ $ne: 1 }, { $gt: "" }, { $regex: ".*" }]) {
                await blockedWithoutSideEffects("from_user_to_seller", "PUT", "/api/admin/from_user_to_seller", { as: W.admin, body: { user_id } });
                await blockedWithoutSideEffects("update_admin_to_user", "PUT", "/api/admin/update_admin_to_user", { as: W.admin, body: { user_id } });
            }
            await blockedWithoutSideEffects("delete_review", "DELETE", "/api/admin/delete_review", { as: W.admin, body: { product_id: { $ne: 1 }, review_id: { $ne: 1 } } });
        });
        await test("store_design carrying operator keys cannot move the store to another owner or change its slug", async () => {
            const before = { owner: str(find("store", W.storeA._id).owner_id), slug: find("store", W.storeA._id).slug };
            const r = await call("PUT", "/api/seller/store", { as: W.sellerA, body: { store_design: { $set: { owner_id: str(W.sellerB._id), slug: "stolen" }, $where: "1" } } });
            assert.ok(r.status < 500, `5xx ${r.text}`);
            eq(str(find("store", W.storeA._id).owner_id), before.owner);
            eq(find("store", W.storeA._id).slug, before.slug);
        });
    }

    // =====================================================================
    section("NoSQL injection: operators in the query string (?product_id[$ne]=x)");
    // =====================================================================
    {
        const W = world();
        await test("control: a valid product_id returns that product's reviews (so the injection tests below are meaningful)", async () => {
            const r = await call("GET", `/api/get_product_reviews?product_id=${W.prodA._id}`, { as: W.buyer1 });
            eq(r.status, 200, r.text);
            assert.ok(r.text.includes("CANARY-REVIEW-A"));
        });
        for (const q of ["product_id[$ne]=x", "product_id[$gt]=", "product_id[$regex]=.*", "product_id[$exists]=true", "product_id[]=x", `product_id[$in][]=${"a".repeat(24)}`]) {
            await test(`GET /api/get_product_reviews?${q} -> 400, no review data`, async () => {
                const r = await call("GET", `/api/get_product_reviews?${q}`, { as: W.buyer1 });
                assertBlocked(r, q);
                eq(r.status, 400, r.text);
                assert.ok(!r.text.includes("CANARY-REVIEW"), `reviews leaked: ${r.text}`);
                assert.ok(emptyData(r.body));
            });
        }
        await test("the same injection without a session -> 401 (no review data either)", async () => {
            const r = await call("GET", "/api/get_product_reviews?product_id[$ne]=x");
            eq(r.status, 401, r.text);
            assert.ok(!r.text.includes("CANARY"));
        });
        await test("seller A's tickets: ?status[$ne]= / ?seller_id[$ne]= / ?store_id=<A> from seller B never expose A's tickets", async () => {
            for (const q of ["status[$ne]=resolved", "seller_id[$ne]=x", `seller_id=${W.sellerA._id}`, `store_id=${W.storeA._id}`, "status[$regex]=.*", "limit[$gt]=0&page[$ne]=1"]) {
                const r = await call("GET", `/api/seller/tickets?${q}`, { as: W.sellerB });
                eq(r.status, 200, `${q}: ${r.text}`);
                assert.deepStrictEqual(leaked(r.text, W.aSecrets), [], `${q} leaked A's data`);
                eq(r.body.data.length, 1, `${q}: expected only seller B's ticket`);
            }
        });
        await test("seller B's order list / product list: injected owner filters never reveal seller A's records", async () => {
            for (const q of ["seller_id[$ne]=x", `seller_id=${W.sellerA._id}`, "products.seller_id[$ne]=x", "user_id[$ne]=x", "limit[$gt]=0", "page[$ne]=1"]) {
                const orders = await call("GET", `/api/seller/get_all_orders?${q}`, { as: W.sellerB });
                eq(orders.status, 200, `${q}: ${orders.text}`);
                assert.deepStrictEqual(leaked(orders.text, W.aSecrets), [], `get_all_orders?${q} leaked A's data`);
                const prods = await call("GET", `/api/get_seller_products?${q}`, { as: W.sellerB });
                eq(prods.status, 200, `${q}: ${prods.text}`);
                assert.deepStrictEqual(leaked(prods.text, W.aSecrets), [], `get_seller_products?${q} leaked A's data`);
            }
        });
        await test("buyer 2's order list: ?user_id[$ne]= / ?user_id=<buyer1> never reveal buyer 1's orders", async () => {
            for (const q of ["user_id[$ne]=x", `user_id=${W.buyer1._id}`, "user_id[$regex]=.*", "status[$ne]=cancelled"]) {
                const r = await call("GET", `/api/get_user_orders?${q}`, { as: W.buyer2 });
                eq(r.status, 200, `${q}: ${r.text}`);
                assert.deepStrictEqual(leaked(r.text, W.aSecrets), [], `${q} leaked buyer 1's order`);
                eq(r.body.data.length, 1);
            }
        });
        await test("public lists / store page tolerate operator pagination and filters (200, no 5xx, no seller account ids)", async () => {
            for (const url of ["/api/get_products?limit[$gt]=0&page[$ne]=1", "/api/get_products?section[$ne]=x&seller_id[$ne]=x", `/api/stores/${W.storeA.slug}?page[$ne]=1&limit[$gt]=0`]) {
                const r = await call("GET", url);
                eq(r.status, 200, `${url}: ${r.text}`);
                assert.ok(!r.text.includes(str(W.sellerA._id)) && !r.text.includes(str(W.sellerB._id)), `${url} exposes a seller account id`);
            }
        });
        await test("operator-looking path parameters are rejected (store slug / coupon id / ticket id)", async () => {
            eq((await call("GET", "/api/stores/%24ne")).status, 400);
            eq((await call("GET", "/api/stores/%7B%22%24ne%22%3A1%7D")).status, 400);
            eq((await call("PUT", "/api/seller/coupons/%7B%22%24ne%22%3A1%7D", { as: W.sellerA, body: { discount: 5 } })).status, 400);
            eq((await call("DELETE", "/api/seller/coupons/%24ne", { as: W.sellerA })).status, 400);
            eq((await call("PATCH", "/api/seller/tickets/%24ne/status", { as: W.sellerA, body: { status: "resolved" } })).status, 400);
        });
    }

    // =====================================================================
    section("Mass assignment: protected fields are never taken from the client");
    // =====================================================================
    {
        const W = world();
        await test("register: role / _id / createdAt / isAdmin in the body are ignored (account is role=user)", async () => {
            const forgedId = str(new ObjectId());
            for (const role of ["super_admin", "seller"]) {
                const email = `mass.${role}@t.test`;
                const r = await call("POST", "/api/auth/register", { body: { name: "Mass", email, password: "Passw0rd!!", phone_number: "+20 100 123 4567", whatsApp_number: "+20 100 123 4567", GPS_URL: "https://maps.example.com/p", role, isAdmin: true, _id: forgedId, createdAt: "2000-01-01" } });
                eq(r.status, 201, r.text);
                const stored = h.findUser(email);
                eq(stored.role, "user", `role ${role} was accepted`);
                assert.notStrictEqual(str(stored._id), forgedId, "client-supplied _id was accepted");
                assert.ok(stored.isAdmin === undefined, "unknown field persisted");
            }
        });
        await test("seller promotion request: user_id / email / role / status in the body are ignored", async () => {
            const r = await call("PUT", "/api/request_seller_promotion", { as: W.buyer1, body: {
                name: "Buyer One", description: "I want to sell", phone_number: "+20 100 555 1001", whatsApp_number: "+20 100 555 1001", GPS_URL: "https://maps.example.com/p",
                user_id: str(W.buyer2._id), email: "attacker@evil.test", role: "seller", status: "approved", approved: true,
            } });
            eq(r.status, 201, r.text);
            const saved = models.promotion.__docs[0];
            eq(str(saved.user_id), str(W.buyer1._id), "request was filed for another user");
            eq(saved.email, W.buyer1.email, "client e-mail accepted");
            eq(find("users", W.buyer1._id).role, "user", "role changed by the request");
            assert.ok(saved.status === undefined && saved.approved === undefined && saved.role === undefined);
        });
        await test("create store: owner_id / slug / _id in the body are ignored (owner = caller, slug server generated)", async () => {
            const forged = str(W.storeA._id);
            const r = await call("POST", "/api/seller/store", { as: W.sellerC, body: { store_name: "Mass Store", owner_id: str(W.sellerA._id), slug: "hijacked-slug", _id: forged } });
            eq(r.status, 201, r.text);
            eq(str(r.body.data.owner_id), str(W.sellerC._id));
            assert.notStrictEqual(r.body.data.slug, "hijacked-slug");
            assert.notStrictEqual(str(r.body.data._id), forged);
            eq(find("store", W.storeA._id).store_name, "CANARY-STORE-A", "another seller's store was overwritten");
            eq(models.store.__docs.length, 3);
        });
        await test("update store: owner_id / slug / _id in the body are ignored", async () => {
            const r = await call("PUT", "/api/seller/store", { as: W.sellerA, body: { store_name: "Renamed A", owner_id: str(W.sellerB._id), slug: "stolen-slug", _id: str(W.storeB._id) } });
            eq(r.status, 200, r.text);
            const a = find("store", W.storeA._id);
            eq(a.store_name, "Renamed A");
            eq(str(a.owner_id), str(W.sellerA._id));
            eq(a.slug, "canary-store-a-aaaaaa");
            eq(find("store", W.storeB._id).store_name, "CANARY-STORE-B");
        });
        await test("create product: seller_id / store_id / final_price / is_active / reviews / _id in the body are ignored", async () => {
            const r = await call("POST", "/api/seller/add_product", { as: W.sellerA, body: {
                ...productBody(W, { product_price: 500 }),
                seller_id: str(W.sellerB._id), store_id: str(W.storeB._id), final_price: 0.01, price: 0.01, is_active: false,
                reviews: [{ user_name: "fake", content: "fake 5 stars", rating: 5 }], _id: str(W.prodB._id),
            } });
            eq(r.status, 201, r.text);
            const p = find("products", r.body.data._id);
            eq(str(p.seller_id), str(W.sellerA._id));
            eq(str(p.store_id), str(W.storeA._id));
            eq(p.price, 500);
            eq(p.final_price, 500, "client final_price accepted");
            assert.deepStrictEqual(p.reviews, [], "client-supplied reviews accepted");
            assert.notStrictEqual(p.is_active, false);
            eq(find("products", W.prodB._id).name, "CANARY-PRODUCT-B");
        });
        await test("update product: seller_id / store_id / reviews / final_price in the body are ignored", async () => {
            const r = await call("PUT", "/api/admin/update_product", { as: W.sellerA, body: {
                ...productBody(W, { product_id: str(W.prodA._id), product_price: 300 }),
                seller_id: str(W.sellerB._id), store_id: str(W.storeB._id), final_price: 0.01, reviews: [], is_active: false,
            } });
            eq(r.status, 200, r.text);
            const p = find("products", W.prodA._id);
            eq(str(p.seller_id), str(W.sellerA._id));
            eq(str(p.store_id), str(W.storeA._id));
            eq(p.final_price, 300);
            eq(p.reviews.length, 1, "reviews were wiped by a client-supplied field");
        });
        await test("create / update coupon: seller_id / _id in the body are ignored (coupon belongs to the caller)", async () => {
            const end_time = new Date(Date.now() + 864e5).toISOString();
            const created = await call("POST", "/api/seller/coupons", { as: W.sellerA, body: { coupon_name: "MASSCODE", discount: 15, end_time, seller_id: str(W.sellerB._id), _id: str(W.couponB._id) } });
            eq(created.status, 201, created.text);
            eq(str(created.body.data.seller_id), str(W.sellerA._id));
            eq(str(find("coupons", created.body.data._id).seller_id), str(W.sellerA._id));
            eq(find("coupons", W.couponB._id).discount, 20, "another seller's coupon was overwritten");
            const updated = await call("PUT", `/api/seller/coupons/${W.couponA._id}`, { as: W.sellerA, body: { discount: 5, seller_id: str(W.sellerB._id) } });
            eq(updated.status, 200, updated.text);
            eq(str(find("coupons", W.couponA._id).seller_id), str(W.sellerA._id), "coupon was re-assigned to another seller");
        });
        await test("create order: user_id / seller_id / price / total_price / status / user_name / discount in the body are ignored", async () => {
            const stockBefore = find("products", W.prodB._id).quantity;
            const r = await call("POST", "/api/order", { as: W.buyer1, body: {
                products: [{ id: str(W.prodB._id), quantity: 1, price: 0.01, seller_id: str(W.buyer1._id), name: "free", discount: 100, final_price: 0 }],
                user_id: str(W.buyer2._id), seller_id: str(W.buyer1._id), price: 0.01, total_price: 0.01, status: "delivered",
                user_name: "Hacker", phone_number: "+20 1", subtotal_before_coupon: 0, coupon_discount_percent: 100,
            } });
            eq(r.status, 201, r.text);
            const o = find("orders", r.body.data._id);
            eq(str(o.user_id), str(W.buyer1._id), "order was filed under a client-supplied user");
            eq(o.total_price, 200, "client price accepted");
            eq(o.status, "new", "client status accepted");
            eq(o.user_name, W.buyer1.name);
            eq(o.phone_number, W.buyer1.phone_number);
            eq(o.products[0].price, 200, "item price taken from the client");
            eq(o.products[0].seller_id, str(W.sellerB._id), "item seller taken from the client");
            eq(o.products[0].name, W.prodB.name);
            assert.ok(!o.coupon_code && o.coupon_discount_percent === undefined, "client coupon fields stored");
            eq(find("products", W.prodB._id).quantity, stockBefore - 1);
        });
        await test("create order: negative / zero / fractional / absurd quantity and own product are rejected", async () => {
            const before = snap();
            for (const quantity of [-1, 0, 1.5, 1001, "1e3", "abc"]) {
                assertBlocked(await call("POST", "/api/order", { as: W.buyer2, body: { products: [{ id: str(W.prodA._id), quantity }] } }), `quantity ${quantity}`);
            }
            assertBlocked(await call("POST", "/api/order", { as: W.sellerA, body: { products: [{ id: str(W.prodA._id), quantity: 1 }] } }), "own product");
            eq(snap(), before);
        });
        await test("create ticket: seller_id / store_id / customer_id / customer_name / status in the body are ignored", async () => {
            const r = await call("POST", `/api/stores/${W.storeA.slug}/tickets`, { as: W.buyer2, body: {
                issue_type: "other", phone_number: "+20 100 555 1002", details: "Something is wrong with this", order_number: "",
                seller_id: str(W.sellerB._id), store_id: str(W.storeB._id), customer_id: str(W.buyer1._id), customer_name: "Somebody Else", status: "resolved",
            } });
            eq(r.status, 201, r.text);
            const t = find("tickets", r.body.data._id);
            eq(str(t.seller_id), str(W.sellerA._id), "ticket routed to a client-chosen seller");
            eq(str(t.store_id), str(W.storeA._id));
            eq(str(t.customer_id), str(W.buyer2._id), "ticket filed as another customer");
            eq(t.customer_name, W.buyer2.name);
            eq(t.status, "new", "client status accepted");
        });
        await test("update ticket status: only `status` changes (seller_id / customer_id / details in the body ignored)", async () => {
            const r = await call("PATCH", `/api/seller/tickets/${W.ticketA._id}/status`, { as: W.sellerA, body: { status: "in_progress", seller_id: str(W.sellerB._id), customer_id: str(W.buyer2._id), details: "rewritten" } });
            eq(r.status, 200, r.text);
            const t = find("tickets", W.ticketA._id);
            eq(t.status, "in_progress");
            eq(str(t.seller_id), str(W.sellerA._id));
            eq(str(t.customer_id), str(W.buyer1._id));
            eq(t.details, "CANARY-TICKET-DETAILS-A");
        });
        await test("admin promotion: body `role` cannot grant anything beyond 'seller' (no super_admin via from_user_to_seller)", async () => {
            const r = await call("PUT", "/api/admin/from_user_to_seller", { as: W.admin, body: { user_id: str(W.buyer1._id), role: "super_admin" } });
            eq(r.status, 200, r.text);
            eq(find("users", W.buyer1._id).role, "seller");
        });
    }

    // =====================================================================
    section("IDOR: seller A / buyer 1 resources are not reachable by seller B / buyer 2");
    // =====================================================================
    {
        await test("ORDERS - control: seller A can read and update THEIR order (so the 404s below are meaningful)", async () => {
            const W = world();
            const list = await call("GET", "/api/seller/get_all_orders", { as: W.sellerA });
            eq(list.status, 200);
            assert.ok(list.text.includes("ORD-111111111"));
            const r = await call("PUT", "/api/seller/update_status_of_order", { as: W.sellerA, body: { order_id: str(W.orderA._id), status_order: "processing" } });
            eq(r.status, 200, r.text);
            eq(find("orders", W.orderA._id).status, "processing");
        });
        await test("ORDERS: buyer 2 lists only their own orders and sees nothing of buyer 1", async () => {
            const W = world();
            const r = await call("GET", "/api/get_user_orders", { as: W.buyer2 });
            eq(r.status, 200);
            eq(r.body.data.length, 1);
            eq(r.body.data[0].orderNumber, "ORD-222222222");
            assert.deepStrictEqual(leaked(r.text, W.aSecrets), [], "buyer 1's data in buyer 2's list");
        });
        await test("ORDERS: seller B's order list contains only orders with their own products", async () => {
            const W = world();
            const r = await call("GET", "/api/seller/get_all_orders", { as: W.sellerB });
            eq(r.status, 200);
            eq(r.body.data.length, 1);
            assert.deepStrictEqual(leaked(r.text, W.aSecrets), [], "seller A's order data in seller B's list");
        });
        await test("ORDERS: seller B cannot change seller A's order status (404), incl. cancel -> no stock restored, impersonation fields ignored", async () => {
            const W = world();
            for (const status_order of ["processing", "shipped", "delivered", "cancelled"]) {
                const before = snap();
                const r = await call("PUT", "/api/seller/update_status_of_order", { as: W.sellerB, body: { order_id: str(W.orderA._id), status_order, seller_id: str(W.sellerA._id), user_id: str(W.sellerA._id) } });
                eq(r.status, 404, `${status_order}: ${r.status} ${r.text}`);
                eq(snap(), before, `${status_order}: stored data changed`);
                assert.deepStrictEqual(leaked(r.text, W.aSecrets), []);
            }
            eq(find("orders", W.orderA._id).status, "new");
            eq(find("products", W.prodA._id).quantity, 5, "stock of A's product was changed by B");
        });
        await test("ORDERS: seller B cannot delete seller A's order (404), no archive entry, order intact", async () => {
            const W = world();
            const before = snap();
            const r = await call("DELETE", "/api/seller/delete_order", { as: W.sellerB, body: { order_id: str(W.orderA._id), seller_id: str(W.sellerA._id) } });
            eq(r.status, 404, r.text);
            eq(snap(), before);
            eq(models.archive.__docs.length, 0);
        });
        await test("ORDERS: the buyer (even the owner of the order) and other buyers cannot use the seller order endpoints (403, order unchanged)", async () => {
            const W = world();
            for (const who of [W.buyer1, W.buyer2]) {
                const before = snap();
                eq((await call("PUT", "/api/seller/update_status_of_order", { as: who, body: { order_id: str(W.orderA._id), status_order: "delivered" } })).status, 403);
                eq((await call("DELETE", "/api/seller/delete_order", { as: who, body: { order_id: str(W.orderA._id) } })).status, 403);
                eq((await call("GET", "/api/seller/get_all_orders", { as: who })).status, 403);
                eq(snap(), before);
            }
        });
        await test("ORDERS: an Idempotency-Key used by buyer 1 never returns buyer 1's order to buyer 2", async () => {
            const W = world();
            const key = "shared-key-123";
            const first = await call("POST", "/api/order", { as: W.buyer1, headers: { "Idempotency-Key": key }, body: { products: [{ id: str(W.prodB._id), quantity: 1 }] } });
            eq(first.status, 201, first.text);
            const second = await call("POST", "/api/order", { as: W.buyer2, headers: { "Idempotency-Key": key }, body: { products: [{ id: str(W.prodA._id), quantity: 1 }] } });
            eq(second.status, 201, `buyer 2 got ${second.status} ${second.text}`);
            assert.notStrictEqual(str(second.body.data._id), str(first.body.data._id), "buyer 2 received buyer 1's order");
            eq(str(find("orders", second.body.data._id).user_id), str(W.buyer2._id));
        });

        await test("COUPONS - control: seller A can update and delete their own coupon", async () => {
            const W = world();
            eq((await call("PUT", `/api/seller/coupons/${W.couponA._id}`, { as: W.sellerA, body: { discount: 12 } })).status, 200);
            eq(find("coupons", W.couponA._id).discount, 12);
            eq((await call("DELETE", `/api/seller/coupons/${W.couponA._id}`, { as: W.sellerA })).status, 200);
            eq(find("coupons", W.couponA._id), undefined);
        });
        await test("COUPONS: seller B cannot update or delete seller A's coupon (404, unchanged)", async () => {
            const W = world();
            const before = snap();
            const upd = await call("PUT", `/api/seller/coupons/${W.couponA._id}`, { as: W.sellerB, body: { discount: 99, coupon_name: "HACKED", end_time: new Date(Date.now() + 9e9).toISOString() } });
            eq(upd.status, 404, upd.text);
            const del = await call("DELETE", `/api/seller/coupons/${W.couponA._id}`, { as: W.sellerB });
            eq(del.status, 404, del.text);
            eq(snap(), before);
            assert.deepStrictEqual(leaked(upd.text + del.text, W.aSecrets), []);
        });
        await test("COUPONS: seller B's coupon list does not contain seller A's coupons", async () => {
            const W = world();
            const r = await call("GET", "/api/seller/coupons", { as: W.sellerB });
            eq(r.status, 200);
            eq(r.body.data.length, 1);
            assert.deepStrictEqual(leaked(r.text, W.aSecrets), []);
        });
        await test("COUPONS: seller B re-creating A's code is refused and does not alter A's coupon", async () => {
            const W = world();
            const r = await call("POST", "/api/seller/coupons", { as: W.sellerB, body: { coupon_name: "SELLERACODE", discount: 99, end_time: new Date(Date.now() + 864e5).toISOString() } });
            assert.ok([400, 409].includes(r.status), `${r.status} ${r.text}`);
            eq(find("coupons", W.couponA._id).discount, 10);
            eq(str(find("coupons", W.couponA._id).seller_id), str(W.sellerA._id));
        });
        await test("COUPONS - control: seller A's coupon works on seller A's product", async () => {
            const W = world();
            const r = await call("POST", "/api/order", { as: W.buyer2, body: { products: [{ id: str(W.prodA._id), quantity: 1 }], coupon: "SELLERACODE" } });
            eq(r.status, 201, r.text);
            eq(r.body.data.total_price, 90);
        });
        await test("COUPONS: seller A's coupon is NOT valid for seller B's products (400, no stock taken, no order)", async () => {
            const W = world();
            const before = snap();
            const r = await call("POST", "/api/order", { as: W.buyer1, body: { products: [{ id: str(W.prodB._id), quantity: 1 }], coupon: "SELLERACODE" } });
            eq(r.status, 400, r.text);
            eq(snap(), before);
        });
        await test("COUPONS: normal users cannot manage coupons (403, nothing created)", async () => {
            const W = world();
            const before = snap();
            eq((await call("POST", "/api/seller/coupons", { as: W.buyer1, body: { coupon_name: "FREE100", discount: 100, end_time: new Date(Date.now() + 864e5).toISOString() } })).status, 403);
            eq((await call("PUT", `/api/seller/coupons/${W.couponA._id}`, { as: W.buyer1, body: { discount: 100 } })).status, 403);
            eq((await call("DELETE", `/api/seller/coupons/${W.couponA._id}`, { as: W.buyer1 })).status, 403);
            eq(snap(), before);
        });

        await test("TICKETS - control: seller A reads and updates THEIR ticket", async () => {
            const W = world();
            const list = await call("GET", "/api/seller/tickets", { as: W.sellerA });
            eq(list.status, 200);
            assert.ok(list.text.includes("CANARY-TICKET-DETAILS-A"));
            eq((await call("PATCH", `/api/seller/tickets/${W.ticketA._id}/status`, { as: W.sellerA, body: { status: "resolved" } })).status, 200);
            eq(find("tickets", W.ticketA._id).status, "resolved");
        });
        await test("TICKETS: seller B's ticket list contains none of seller A's tickets", async () => {
            const W = world();
            const r = await call("GET", "/api/seller/tickets", { as: W.sellerB });
            eq(r.status, 200);
            eq(r.body.data.length, 1);
            assert.deepStrictEqual(leaked(r.text, W.aSecrets), []);
        });
        await test("TICKETS: seller B cannot change seller A's ticket (404, unchanged, no leak)", async () => {
            const W = world();
            const before = snap();
            const r = await call("PATCH", `/api/seller/tickets/${W.ticketA._id}/status`, { as: W.sellerB, body: { status: "resolved" } });
            eq(r.status, 404, r.text);
            eq(snap(), before);
            assert.deepStrictEqual(leaked(r.text, W.aSecrets), []);
        });
        await test("TICKETS: a customer cannot attach another customer's order number to a ticket (400, none created)", async () => {
            const W = world();
            const before = snap();
            const r = await call("POST", `/api/stores/${W.storeA.slug}/tickets`, { as: W.buyer2, body: { issue_type: "delayed", phone_number: "+20 100 555 1002", details: "Where is the order please", order_number: "ORD-111111111" } });
            eq(r.status, 400, r.text);
            eq(snap(), before);
        });
        await test("TICKETS: an order of store A cannot be used to open a ticket against store B (400, none created)", async () => {
            const W = world();
            const before = snap();
            const r = await call("POST", `/api/stores/${W.storeB.slug}/tickets`, { as: W.buyer1, body: { issue_type: "delayed", phone_number: "+20 100 555 1001", details: "Where is the order please", order_number: "ORD-111111111" } });
            eq(r.status, 400, r.text);
            eq(snap(), before);
        });
        await test("TICKETS: normal users cannot read or change seller tickets (403, no leak, unchanged)", async () => {
            const W = world();
            const before = snap();
            const list = await call("GET", "/api/seller/tickets", { as: W.buyer1 });
            eq(list.status, 403);
            assert.deepStrictEqual(leaked(list.text, W.allSecrets), []);
            eq((await call("PATCH", `/api/seller/tickets/${W.ticketA._id}/status`, { as: W.buyer1, body: { status: "resolved" } })).status, 403);
            eq(snap(), before);
        });

        await test("STORES - control: seller A reads and edits their own store", async () => {
            const W = world();
            const r = await call("GET", "/api/seller/store", { as: W.sellerA });
            eq(r.status, 200);
            eq(r.body.data.store_name, "CANARY-STORE-A");
        });
        await test("STORES: seller B's /api/seller/store returns only seller B's store, with no seller A data", async () => {
            const W = world();
            const r = await call("GET", "/api/seller/store", { as: W.sellerB });
            eq(r.status, 200);
            eq(r.body.data.store_name, "CANARY-STORE-B");
            assert.deepStrictEqual(leaked(r.text, W.aSecrets), []);
        });
        await test("STORES: seller B editing 'their' store with A's identifiers changes only B's store", async () => {
            const W = world();
            const r = await call("PUT", "/api/seller/store", { as: W.sellerB, body: { store_name: "B renamed", owner_id: str(W.sellerA._id), _id: str(W.storeA._id), slug: W.storeA.slug } });
            eq(r.status, 200, r.text);
            eq(find("store", W.storeA._id).store_name, "CANARY-STORE-A");
            eq(find("store", W.storeB._id).store_name, "B renamed");
            eq(str(find("store", W.storeB._id).owner_id), str(W.sellerB._id));
        });
        await test("STORES: a seller without a store cannot edit someone else's store (404, nothing changed)", async () => {
            const W = world();
            const before = snap();
            const r = await call("PUT", "/api/seller/store", { as: W.sellerC, body: { store_name: "Taken over", owner_id: str(W.sellerA._id), _id: str(W.storeA._id) } });
            eq(r.status, 404, r.text);
            eq(snap(), before);
        });
        await test("STORES: sellers and buyers get 403 (and no store data) from the admin store routes; admin gets 200", async () => {
            const W = world();
            for (const who of [W.sellerB, W.buyer1]) {
                const before = snap();
                for (const [method, url, body] of [["GET", "/api/admin/stores"], ["GET", `/api/admin/store/${W.storeA._id}`], ["PUT", `/api/admin/store/${W.storeA._id}`, { store_name: "HACKED" }]]) {
                    const r = await call(method, url, { as: who, body });
                    eq(r.status, 403, `${method} ${url} as ${who.name}: ${r.status} ${r.text}`);
                    assert.deepStrictEqual(leaked(r.text, W.allSecrets), [], "403 response leaks data");
                    assert.ok(emptyData(r.body));
                }
                eq(snap(), before);
            }
            eq((await call("GET", `/api/admin/store/${W.storeA._id}`, { as: W.admin })).status, 200);
        });
        await test("STORES: the public store page never exposes the owner's account id / e-mail / private phone", async () => {
            const W = world();
            const r = await call("GET", `/api/stores/${W.storeA.slug}`);
            eq(r.status, 200, r.text);
            assert.ok(r.text.includes("CANARY-STORE-A"));
            for (const secret of [str(W.sellerA._id), "sellera@t.test", "+20 100 555 0001", "owner_id", "password"]) assert.ok(!r.text.includes(secret), `public store leaks ${secret}`);
        });

        await test("PRODUCTS: seller B cannot update or delete seller A's product (404, unchanged)", async () => {
            const W = world();
            const before = snap();
            eq((await call("PUT", "/api/admin/update_product", { as: W.sellerB, body: productBody(W, { product_id: str(W.prodA._id), product_name: "HACKED" }) })).status, 404);
            eq((await call("DELETE", "/api/seller/delete_product", { as: W.sellerB, body: { product_id: str(W.prodA._id) } })).status, 404);
            eq(snap(), before);
        });
    }

    // =====================================================================
    section("Role authorization matrix (no 2xx, no protected data, no side effects)");
    // =====================================================================
    {
        const W = world();
        const future = new Date(Date.now() + 864e5).toISOString();
        const SELLER = [
            ["GET", "/api/seller/get_all_orders"],
            ["PUT", "/api/seller/update_status_of_order", { order_id: str(W.orderB._id), status_order: "cancelled" }],
            ["DELETE", "/api/seller/delete_order", { order_id: str(W.orderB._id) }],
            ["GET", "/api/seller/coupons"],
            ["POST", "/api/seller/coupons", { coupon_name: "ROLETEST", discount: 50, end_time: future }],
            ["PUT", `/api/seller/coupons/${W.couponB._id}`, { discount: 1 }],
            ["DELETE", `/api/seller/coupons/${W.couponB._id}`],
            ["GET", "/api/seller/store"],
            ["POST", "/api/seller/store", { store_name: "Role Store" }],
            ["PUT", "/api/seller/store", { store_name: "Role rename" }],
            ["GET", "/api/seller/tickets"],
            ["PATCH", `/api/seller/tickets/${W.ticketB._id}/status`, { status: "resolved" }],
            ["POST", "/api/seller/add_product", productBody(W)],
            ["POST", "/api/seller/add_section", { section_name: "Role Section" }],
            ["GET", "/api/get_seller_products"],
        ];
        const SELLER_OR_ADMIN = [
            ["PUT", "/api/admin/update_product", productBody(W, { product_id: str(W.prodB._id) })],
            ["DELETE", "/api/seller/delete_product", { product_id: str(W.prodB._id) }],
        ];
        const ADMIN = [
            ["GET", "/api/admin/get_all_users"],
            ["GET", "/api/admin/get_requset_to_sellers"],
            ["GET", "/api/admin/stores"],
            ["GET", `/api/admin/store/${W.storeB._id}`],
            ["PUT", `/api/admin/store/${W.storeB._id}`, { store_name: "ADMIN-ONLY" }],
            ["PUT", "/api/admin/from_user_to_seller", { user_id: str(W.buyer1._id) }],
            ["PUT", "/api/admin/update_admin_to_user", { user_id: str(W.sellerB._id) }],
            ["DELETE", "/api/admin/delete_review", { product_id: str(W.prodB._id), review_id: str(W.prodB.reviews[0]._id) }],
        ];
        const AUTH_ONLY = [
            ["GET", "/api/get_user_orders"],
            ["POST", "/api/order", { products: [{ id: str(W.prodB._id), quantity: 1 }] }],
            ["PUT", "/api/request_seller_promotion", { name: "N", description: "d", phone_number: "+20 100 123 4567", whatsApp_number: "+20 100 123 4567", GPS_URL: "https://maps.example.com/p" }],
            ["POST", `/api/stores/${W.storeB.slug}/tickets`, { issue_type: "other", phone_number: "+20 100 123 4567", details: "Long enough details" }],
            ["POST", "/api/post_review", { product_id: str(W.prodB._id), review_text: "ok", rating: 5 }],
            ["GET", `/api/get_product_reviews?product_id=${W.prodB._id}`],
            ["GET", "/api/get_cloudinary_config"],
        ];

        async function denied(method, url, body, who, status) {
            const before = snap();
            const r = await call(method, url, { as: who, body });
            eq(r.status, status, `${method} ${url} as ${who ? who.name : "anonymous"} -> ${r.status} (expected ${status}) ${r.text.slice(0, 140)}`);
            assert.ok(!r.body || r.body.success !== true, "success:true in a denied response");
            assert.ok(emptyData(r.body), `denied response carries data: ${r.text.slice(0, 160)}`);
            assert.deepStrictEqual(leaked(r.text, W.allSecrets), [], `${method} ${url} as ${who ? who.name : "anonymous"}: protected data leaked in the ${status} body`);
            eq(snap(), before, `${method} ${url} as ${who ? who.name : "anonymous"}: a denied request changed stored data`);
        }

        await test("anonymous -> 401 on EVERY protected route", async () => {
            for (const [method, url, body] of [...AUTH_ONLY, ...SELLER, ...SELLER_OR_ADMIN, ...ADMIN]) await denied(method, url, body, null, 401);
        });
        await test("user -> 403 on every seller route (no data, no side effects)", async () => {
            for (const [method, url, body] of SELLER) await denied(method, url, body, W.buyer1, 403);
        });
        await test("user -> 403 on every seller-or-admin route (product update/delete)", async () => {
            for (const [method, url, body] of SELLER_OR_ADMIN) await denied(method, url, body, W.buyer1, 403);
        });
        await test("user -> 403 on every admin route (no data, no side effects)", async () => {
            for (const [method, url, body] of ADMIN) await denied(method, url, body, W.buyer1, 403);
        });
        await test("seller -> 403 on every admin route (no data, no side effects)", async () => {
            for (const [method, url, body] of ADMIN) await denied(method, url, body, W.sellerA, 403);
        });
        await test("admin section routes (update_section / delete_section) are either unmounted (404, current state) or protected - never reachable by anonymous / user / seller, never changing data", async () => {
            for (const [method, url, body] of [
                ["PUT", "/api/admin/update_section", { section_id: str(W.section), section_name: "Renamed" }],
                ["DELETE", "/api/admin/delete_section", { section_id: str(W.section) }],
            ]) {
                for (const [who, allowed] of [[null, [401, 404]], [W.buyer1, [403, 404]], [W.sellerA, [403, 404]]]) {
                    const before = snap();
                    const r = await call(method, url, { as: who, body });
                    assert.ok(allowed.includes(r.status), `${method} ${url} as ${who ? who.name : "anonymous"} -> ${r.status} ${r.text.slice(0, 120)}`);
                    eq(snap(), before, "state changed");
                }
            }
        });
        await test("controls: each role CAN use its own routes (GET), so the denials above are not an artefact of broken routes", async () => {
            for (const url of ["/api/get_user_orders", "/api/get_cloudinary_config"]) assert.ok([200].includes((await call("GET", url, { as: W.buyer1 })).status), url);
            for (const url of ["/api/seller/get_all_orders", "/api/seller/coupons", "/api/seller/store", "/api/seller/tickets", "/api/get_seller_products"]) eq((await call("GET", url, { as: W.sellerA })).status, 200, url);
            for (const url of ["/api/admin/get_all_users", "/api/admin/get_requset_to_sellers", "/api/admin/stores", `/api/admin/store/${W.storeA._id}`]) eq((await call("GET", url, { as: W.admin })).status, 200, url);
        });
        await test("privilege escalation attempts fail: user self-promotes, seller promotes/demotes, nobody gains a role", async () => {
            const roles = () => models.users.__docs.map((u) => `${u.email}:${u.role}`).join(",");
            const before = roles();
            eq((await call("PUT", "/api/admin/from_user_to_seller", { as: W.buyer1, body: { user_id: str(W.buyer1._id) } })).status, 403);
            eq((await call("PUT", "/api/admin/from_user_to_seller", { as: W.sellerA, body: { user_id: str(W.buyer2._id) } })).status, 403);
            eq((await call("PUT", "/api/admin/update_admin_to_user", { as: W.sellerA, body: { user_id: str(W.sellerB._id) } })).status, 403);
            eq((await call("PUT", "/api/admin/update_admin_to_user", { as: W.sellerA, body: { user_id: str(W.admin._id) } })).status, 403);
            eq(roles(), before);
        });
        await test("a seller demoted to 'user' in the database loses seller access immediately (role is read per request)", async () => {
            const W2 = world();
            eq((await call("GET", "/api/seller/coupons", { as: W2.sellerA })).status, 200);
            find("users", W2.sellerA._id).role = "user";
            const r = await call("GET", "/api/seller/coupons", { as: W2.sellerA });
            eq(r.status, 403, r.text);
            assert.deepStrictEqual(leaked(r.text, W2.allSecrets), []);
        });
        await test("a super_admin demoted to 'user' loses admin access immediately", async () => {
            const W2 = world();
            find("users", W2.admin._id).role = "user";
            const r = await call("GET", "/api/admin/get_all_users", { as: W2.admin });
            eq(r.status, 403, r.text);
            assert.deepStrictEqual(leaked(r.text, W2.allSecrets), []);
        });
    }

    // =====================================================================
    section("Information exposure (responses to LEGITIMATE callers)");
    // =====================================================================
    {
        const W = world();
        await test("admin user list never contains password hashes", async () => {
            const r = await call("GET", "/api/admin/get_all_users", { as: W.admin });
            eq(r.status, 200);
            assert.ok(!/\$2[aby]\$/.test(r.text) && !/"password"/.test(r.text), "password / hash in the user list");
        });
        await test("/api/auth/me never returns the password hash", async () => {
            const r = await call("GET", "/api/auth/me", { as: W.buyer1 });
            eq(r.status, 200);
            assert.ok(!/\$2[aby]\$/.test(r.text) && !/"password"/.test(r.text));
        });
        await test("public product list does not expose the seller's account id, e-mail or private phone", async () => {
            const r = await call("GET", "/api/get_products");
            eq(r.status, 200, r.text);
            assert.ok(r.body.data.length > 0);
            for (const secret of [str(W.sellerA._id), str(W.sellerB._id), "sellera@t.test", "sellerb@t.test", "+20 100 555 0001", '"seller_id"', '"reviews"']) {
                assert.ok(!r.text.includes(secret), `public product list leaks ${secret}`);
            }
        });
        await test("public reviews endpoint returns only the public review fields", async () => {
            const r = await call("GET", `/api/get_product_reviews?product_id=${W.prodA._id}`, { as: W.buyer2 });
            eq(r.status, 200);
            for (const review of r.body.data) assert.deepStrictEqual(Object.keys(review).sort(), ["_id", "content", "created_at", "rating", "user_name"].filter((k) => k in review).sort());
        });
        await test("a buyer's own order list does not expose internal seller account ids (project convention: buyerOrderView strips them on order creation)", async () => {
            const r = await call("GET", "/api/get_user_orders", { as: W.buyer1 });
            eq(r.status, 200);
            assert.ok(!r.text.includes(str(W.sellerA._id)), `GET /api/get_user_orders returns products[].seller_id (${str(W.sellerA._id)}) to the buyer`);
        });
        await test("error responses are generic (no stack traces / Mongo / Mongoose internals)", async () => {
            for (const [method, url, opts] of [
                ["GET", "/api/stores/NOT A SLUG!!", {}],
                ["POST", "/api/auth/log_in", { rawBody: "{bad json" }],
                ["PUT", "/api/seller/update_status_of_order", { as: W.sellerA, body: { order_id: "zzz", status_order: "new" } }],
                ["GET", "/api/no_such_endpoint", {}],
            ]) {
                const r = await call(method, url, opts);
                assert.ok(!/CastError|MongoServerError|ValidationError|node_modules|at \S+ \(|stack/i.test(r.text), `${method} ${url}: ${r.text.slice(0, 160)}`);
            }
        });
    }

    const failures = finish();

    // Second pass without express-mongo-sanitize (child process, same file).
    let childFailed = 0;
    if (SANITIZE && process.env.SECURITY_NO_CHILD !== "1") {
        const child = spawnSync(process.execPath, [__filename], { env: { ...process.env, SECURITY_SANITIZE: "off" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        process.stdout.write(child.stdout || "");
        if (child.stderr) process.stdout.write(child.stderr);
        childFailed = child.status === 0 ? 0 : 1;
    }
    out("\n(security suites ran against fake in-memory models; see tests/support/security_harness.js)");
    process.exit(failures || childFailed ? 1 : 0);
})().catch((error) => {
    process.stdout.write(`security suite crashed: ${error.stack}\n`);
    process.exit(1);
});