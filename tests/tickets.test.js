"use strict";

const assert = require("assert");
const { bootServer, createRunner, ObjectId } = require("./security_harness");

const { test, section, finish } = createRunner("tickets");
const id = (value) => String(value);

(async () => {
    const h = await bootServer();
    const { call, models } = h;
    const sellerA = h.mkUser("TicketSellerA", "seller");
    const sellerB = h.mkUser("TicketSellerB", "seller");
    const customer = h.mkUser("TicketCustomer", "user");
    const otherCustomer = h.mkUser("TicketOtherCustomer", "user");
    const admin = h.mkUser("TicketAdmin", "super_admin");
    const storeA = { _id: new ObjectId(), owner_id: sellerA._id, store_name: "A", slug: "ticket-store-a" };
    const storeB = { _id: new ObjectId(), owner_id: sellerB._id, store_name: "B", slug: "ticket-store-b" };
    models.store.__seed([storeA, storeB]);
    const validTicket = { issue_type: "other", phone_number: "+20 100 123 4567", details: "The package arrived with a clear defect." };

    section("ticket creation validation and ownership");
    await test("a customer can open a valid ticket for another seller's store", async () => {
        const response = await call("POST", `/api/stores/${storeA.slug}/tickets`, { as: customer, body: validTicket });
        assert.strictEqual(response.status, 201);
        assert.strictEqual(response.body.success, true);
        assert.strictEqual(response.body.data.status, "new");
        const created = models.tickets.__docs.find((doc) => id(doc._id) === id(response.body.data._id));
        assert.strictEqual(id(created.customer_id), id(customer._id));
        assert.strictEqual(id(created.seller_id), id(sellerA._id));
        assert.strictEqual(id(created.store_id), id(storeA._id));
    });

    await test("a seller cannot open a ticket against their own store", async () => {
        const response = await call("POST", `/api/stores/${storeA.slug}/tickets`, { as: sellerA, body: validTicket });
        assert.strictEqual(response.status, 400);
        assert.strictEqual(models.tickets.__docs.length, 1);
    });

    await test("creation rejects invalid issue, phone, short details, bad store, and missing required photo", async () => {
        const invalid = [
            ["invalid issue", { ...validTicket, issue_type: "invented" }],
            ["invalid phone", { ...validTicket, phone_number: "x" }],
            ["short details", { ...validTicket, details: "short" }],
            ["missing photo", { ...validTicket, issue_type: "damaged" }],
        ];
        for (const [label, body] of invalid) {
            const response = await call("POST", `/api/stores/${storeA.slug}/tickets`, { as: otherCustomer, body });
            assert.strictEqual(response.status, 400, label);
            assert.strictEqual(response.body.success, false);
        }
        const unknown = await call("POST", "/api/stores/missing-store/tickets", { as: otherCustomer, body: validTicket });
        assert.strictEqual(unknown.status, 404);
    });

    section("seller ticket isolation and status protection");
    let ticketB;
    await test("each seller inbox contains only its own store tickets", async () => {
        const created = await call("POST", `/api/stores/${storeB.slug}/tickets`, { as: otherCustomer, body: validTicket });
        assert.strictEqual(created.status, 201);
        ticketB = created.body.data._id;
        const inboxA = await call("GET", "/api/seller/tickets?limit=1&page=1", { as: sellerA });
        assert.strictEqual(inboxA.status, 200);
        assert.strictEqual(inboxA.body.data.length, 1);
        assert.strictEqual(id(inboxA.body.data[0].seller_id), id(sellerA._id));
        assert.strictEqual(inboxA.body.pagination.total, 1);
        const inboxB = await call("GET", "/api/seller/tickets", { as: sellerB });
        assert.strictEqual(inboxB.status, 200);
        assert.strictEqual(inboxB.body.data.length, 1);
        assert.strictEqual(id(inboxB.body.data[0]._id), id(ticketB));
    });

    await test("seller A cannot update seller B's ticket and no state changes", async () => {
        const response = await call("PATCH", `/api/seller/tickets/${ticketB}/status`, { as: sellerA, body: { status: "resolved" } });
        assert.strictEqual(response.status, 404);
        const stored = models.tickets.__docs.find((doc) => id(doc._id) === id(ticketB));
        assert.strictEqual(stored.status, "new");
    });

    await test("only a seller may access seller ticket endpoints, and status values are validated", async () => {
        const buyerInbox = await call("GET", "/api/seller/tickets", { as: customer });
        assert.strictEqual(buyerInbox.status, 403);
        const adminInbox = await call("GET", "/api/seller/tickets", { as: admin });
        assert.strictEqual(adminInbox.status, 403);
        const invalidId = await call("PATCH", "/api/seller/tickets/not-an-id/status", { as: sellerB, body: { status: "resolved" } });
        assert.strictEqual(invalidId.status, 400);
        const invalidStatus = await call("PATCH", `/api/seller/tickets/${ticketB}/status`, { as: sellerB, body: { status: "deleted" } });
        assert.strictEqual(invalidStatus.status, 400);
    });

    await test("the owning seller can transition only the status field", async () => {
        const response = await call("PATCH", `/api/seller/tickets/${ticketB}/status`, {
            as: sellerB, body: { status: "resolved", customer_id: id(sellerB._id), seller_id: id(sellerA._id) },
        });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.data.status, "resolved");
        const stored = models.tickets.__docs.find((doc) => id(doc._id) === id(ticketB));
        assert.strictEqual(id(stored.customer_id), id(otherCustomer._id));
        assert.strictEqual(id(stored.seller_id), id(sellerB._id));
    });

    await h.stop();
    process.exitCode = finish();
})();
