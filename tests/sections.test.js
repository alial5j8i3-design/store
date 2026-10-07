"use strict";

const assert = require("assert");
const path = require("path");
const { bootServer, createRunner, ObjectId } = require("./security_harness");

const { test, section, finish } = createRunner("sections");
const id = (value) => String(value);
const response = () => ({ statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

(async () => {
    const h = await bootServer();
    const { call, models } = h;
    const sellerA = h.mkUser("SectionSellerA", "seller");
    const sellerB = h.mkUser("SectionSellerB", "seller");
    const buyer = h.mkUser("SectionBuyer", "user");
    const admin = h.mkUser("SectionAdmin", "super_admin");

    section("seller creation and public section data");
    await test("only sellers can create sections, and the server assigns created_by", async () => {
        const forbidden = await call("POST", "/api/seller/add_section", { as: buyer, body: { section_name: "Phones" } });
        assert.strictEqual(forbidden.status, 403);
        const created = await call("POST", "/api/seller/add_section", { as: sellerA, body: { section_name: "  Phones   and   tablets  ", created_by: id(sellerB._id) } });
        assert.strictEqual(created.status, 201);
        assert.strictEqual(created.body.data.name, "Phones and tablets");
        const stored = models.sections.__docs.find((doc) => id(doc._id) === id(created.body.data._id));
        assert.strictEqual(id(stored.created_by), id(sellerA._id));
    });

    await test("section names enforce required, 2-50 character, forbidden-character, and duplicate rules", async () => {
        const invalid = ["", "A", "x".repeat(51), "<script>"];
        for (const section_name of invalid) {
            const result = await call("POST", "/api/seller/add_section", { as: sellerB, body: { section_name } });
            assert.strictEqual(result.status, 400, section_name);
        }
        const duplicate = await call("POST", "/api/seller/add_section", { as: sellerB, body: { section_name: "phones and tablets" } });
        assert.strictEqual(duplicate.status, 409);
        assert.strictEqual(models.sections.__docs.length, 1);
    });

    await test("public listing returns only public section fields", async () => {
        const result = await call("GET", "/api/get_all_sections");
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.body.data.length, 1);
        assert.deepStrictEqual(Object.keys(result.body.data[0]).sort(), ["_id", "name"]);
    });

    section("super-admin-only mutation controller contracts");
    // The two controllers exist but their routers are not registered in server.js.
    // Exercise the controllers with the same server-injected fake models so their
    // authorization-independent validation and product-reference guardrails remain covered.
    const project = path.join(__dirname, "..");
    const updateSection = require(path.join(project, "controller/update_section.controller.js"));
    const deleteSection = require(path.join(project, "controller/delete_section.controller.js"));
    let sectionId;
    await test("update controller rejects invalid IDs and prevents duplicate names", async () => {
        sectionId = models.sections.__docs[0]._id;
        let res = response();
        await updateSection({ user: admin, body: { section_id: "bad", section_name: "Computers" } }, res);
        assert.strictEqual(res.statusCode, 400);
        models.sections.__seed([{ _id: new ObjectId(), name: "Computers", normalized_name: "computers", created_by: sellerB._id }]);
        res = response();
        await updateSection({ user: admin, body: { section_id: id(sectionId), section_name: "Computers" } }, res);
        assert.strictEqual(res.statusCode, 409);
        assert.strictEqual(models.sections.__docs.find((doc) => id(doc._id) === id(sectionId)).name, "Phones and tablets");
    });

    await test("delete controller refuses sections referenced by products and deletes an unreferenced section", async () => {
        models.products.__seed([{
            _id: new ObjectId(), name: "Uses section", description: "description", price: 10, section: sectionId, quantity: 1,
            seller_id: sellerA._id, store_id: new ObjectId(), reviews: [],
        }]);
        let res = response();
        await deleteSection({ user: admin, body: { section_id: id(sectionId) } }, res);
        assert.strictEqual(res.statusCode, 409);
        const unused = models.sections.__docs.find((doc) => doc.name === "Computers");
        res = response();
        await deleteSection({ user: admin, body: { section_id: id(unused._id) } }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(!models.sections.__docs.some((doc) => id(doc._id) === id(unused._id)));
    });

    await test("admin update and delete routes are mounted and protected", async () => {
        const update = await call("PUT", "/api/admin/update_section", { as: admin, body: { section_id: id(sectionId), section_name: "Mobile devices" } });
        assert.strictEqual(update.status, 200, `expected registered admin update route, got ${update.status}: ${update.text}`);
        const remove = await call("DELETE", "/api/admin/delete_section", { as: sellerA, body: { section_id: id(sectionId) } });
        assert.strictEqual(remove.status, 403, `expected protected admin delete route, got ${remove.status}: ${remove.text}`);
    });

    await h.stop();
    process.exitCode = finish();
})();
