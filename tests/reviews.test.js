"use strict";

const assert = require("assert");
const { bootServer, createRunner, ObjectId } = require("./security_harness");

const { test, section, finish } = createRunner("reviews");
const id = (value) => String(value);

(async () => {
    const h = await bootServer();
    const { call, models } = h;
    const seller = h.mkUser("ReviewSeller", "seller");
    const buyer = h.mkUser("ReviewBuyer", "user");
    const stranger = h.mkUser("ReviewStranger", "user");
    const admin = h.mkUser("ReviewAdmin", "super_admin");
    const sectionId = new ObjectId();
    const storeId = new ObjectId();
    const productId = new ObjectId();
    const inactiveProductId = new ObjectId();
    models.sections.__seed([{ _id: sectionId, name: "Reviews" }]);
    models.products.__seed([
        { _id: productId, name: "Review product", description: "description", price: 10, section: sectionId, quantity: 2, seller_id: seller._id, store_id: storeId, reviews: [] },
        { _id: inactiveProductId, name: "Inactive", description: "description", price: 10, section: sectionId, quantity: 0, is_active: false, seller_id: seller._id, store_id: storeId, reviews: [] },
    ]);
    const review = (as, body) => call("POST", "/api/post_review", { as, body });

    section("review validation and delivered-purchase requirement");
    await test("missing content, invalid id, invalid rating, and overlong content are rejected", async () => {
        const invalid = [
            { product_id: id(productId), rating: 5 },
            { product_id: "bad-id", review_text: "Useful review", rating: 5 },
            { product_id: id(productId), review_text: "Useful review", rating: 0 },
            { product_id: id(productId), review_text: "Useful review", rating: 5.1 },
            { product_id: id(productId), review_text: "x".repeat(1001), rating: 5 },
        ];
        for (const body of invalid) {
            const response = await review(buyer, body);
            assert.strictEqual(response.status, 400, JSON.stringify(body).slice(0, 100));
            assert.strictEqual(response.body.success, false);
        }
        assert.strictEqual(models.products.__docs[0].reviews.length, 0);
    });

    await test("a user without a delivered purchase cannot review", async () => {
        const response = await review(stranger, { product_id: id(productId), review_text: "I did not buy this", rating: 5 });
        assert.strictEqual(response.status, 403);
        assert.match(response.body.message, /delivered purchase/i);
        assert.strictEqual(models.products.__docs[0].reviews.length, 0);
    });

    await test("new, processing, and shipped purchases do not authorize a review", async () => {
        for (const status of ["new", "processing", "shipped"]) {
            models.orders.__seed([{
                _id: new ObjectId(), orderNumber: `REVIEW-${status}`, user_id: id(buyer._id), status,
                products: [{ product: productId, seller_id: id(seller._id), name: "Review product", price: 10, quantity: 1 }],
                total_price: 10, user_name: buyer.name, phone_number: buyer.phone_number, GPS_URL: "https://maps.test/x", whatsApp_number: buyer.phone_number,
            }]);
            const response = await review(buyer, { product_id: id(productId), review_text: `Not delivered: ${status}`, rating: 4 });
            assert.strictEqual(response.status, 403, status);
        }
        assert.strictEqual(models.products.__docs[0].reviews.length, 0);
    });

    let reviewId;
    await test("a delivered purchase permits one persisted review associated with the purchased product", async () => {
        models.orders.__seed([{
            _id: new ObjectId(), orderNumber: "REVIEW-DELIVERED", user_id: id(buyer._id), status: "delivered",
            products: [{ product: productId, seller_id: id(seller._id), name: "Review product", price: 10, quantity: 1 }],
            total_price: 10, user_name: buyer.name, phone_number: buyer.phone_number, GPS_URL: "https://maps.test/x", whatsApp_number: buyer.phone_number,
        }]);
        const response = await review(buyer, { product_id: id(productId), review_text: "Really useful and as described", rating: 4.4 });
        assert.strictEqual(response.status, 201);
        assert.strictEqual(response.body.success, true);
        assert.strictEqual(response.body.data.length, 1);
        assert.strictEqual(response.body.data[0].rating, 4);
        reviewId = response.body.data[0]._id;
        const stored = models.products.__docs.find((doc) => id(doc._id) === id(productId));
        assert.strictEqual(stored.reviews.length, 1);
        assert.strictEqual(id(stored.reviews[0].user_id), id(buyer._id));
        assert.strictEqual(stored.reviews[0].content, "Really useful and as described");
    });

    await test("a duplicate review is rejected without adding another review", async () => {
        const response = await review(buyer, { product_id: id(productId), review_text: "Trying again", rating: 5 });
        assert.strictEqual(response.status, 409);
        assert.strictEqual(models.products.__docs.find((doc) => id(doc._id) === id(productId)).reviews.length, 1);
    });

    await test("a seller cannot review their own product even with a delivered purchase", async () => {
        models.orders.__seed([{
            _id: new ObjectId(), orderNumber: "SELLER-DELIVERED", user_id: id(seller._id), status: "delivered",
            products: [{ product: productId, seller_id: id(seller._id), name: "Review product", price: 10, quantity: 1 }],
            total_price: 10, user_name: seller.name, phone_number: seller.phone_number, GPS_URL: "https://maps.test/x", whatsApp_number: seller.phone_number,
        }]);
        const response = await review(seller, { product_id: id(productId), review_text: "Self review", rating: 5 });
        assert.strictEqual(response.status, 403);
    });

    section("review retrieval and administration");
    await test("review retrieval exposes public fields only and rejects invalid products", async () => {
        const response = await call("GET", `/api/get_product_reviews?product_id=${productId}`, { as: stranger });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.data.length, 1);
        assert.strictEqual(response.body.data[0]._id, reviewId);
        assert.ok(!Object.hasOwn(response.body.data[0], "user_id"));
        const invalid = await call("GET", "/api/get_product_reviews?product_id=bad", { as: stranger });
        assert.strictEqual(invalid.status, 400);
        const missing = await call("GET", `/api/get_product_reviews?product_id=${new ObjectId()}`, { as: stranger });
        assert.strictEqual(missing.status, 404);
    });

    await test("only a super admin can delete a review and deletion changes persisted state", async () => {
        const forbidden = await call("DELETE", "/api/admin/delete_review", { as: buyer, body: { product_id: id(productId), review_id: id(reviewId) } });
        assert.strictEqual(forbidden.status, 403);
        assert.strictEqual(models.products.__docs.find((doc) => id(doc._id) === id(productId)).reviews.length, 1);
        const removed = await call("DELETE", "/api/admin/delete_review", { as: admin, body: { product_id: id(productId), review_id: id(reviewId) } });
        assert.strictEqual(removed.status, 200);
        assert.strictEqual(models.products.__docs.find((doc) => id(doc._id) === id(productId)).reviews.length, 0);
    });

    await h.stop();
    process.exitCode = finish();
})();
