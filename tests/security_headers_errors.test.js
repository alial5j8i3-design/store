"use strict";

const assert = require("assert");
const { bootServer, createRunner } = require("./security_harness");

const { test, section, finish } = createRunner("security headers and errors");

(async () => {
    const h = await bootServer();
    const buyer = h.mkUser("ErrorBuyer", "user");
    const seller = h.mkUser("ErrorSeller", "seller");

    section("HTTP error envelopes");
    await test("an API route miss is JSON 404 with the application envelope", async () => {
        const response = await h.call("GET", "/api/does-not-exist");
        assert.strictEqual(response.status, 404);
        assert.deepStrictEqual(response.body, { success: false, message: "API endpoint not found" });
        assert.match(response.headers.get("content-type"), /^application\/json/);
    });

    await test("malformed JSON is converted by error middleware to the documented 400 envelope", async () => {
        const response = await h.call("POST", "/api/auth/log_in", { rawBody: "{not-json" });
        assert.strictEqual(response.status, 400);
        assert.deepStrictEqual(response.body, { success: false, message: "Malformed JSON request body" });
        assert.ok(!response.text.includes("SyntaxError"));
    });

    await test("a payload larger than the configured body-parser limit returns 413 without implementation details", async () => {
        const response = await h.call("POST", "/api/auth/log_in", { rawBody: JSON.stringify({ data: "x".repeat(110_000) }) });
        assert.strictEqual(response.status, 413);
        assert.deepStrictEqual(response.body, { success: false, message: "Request body is too large" });
        assert.ok(!response.text.includes("PayloadTooLargeError"));
    });

    await test("existing protected routes preserve their precise 401 and 403 response envelopes", async () => {
        const unauthenticated = await h.call("GET", "/api/seller/coupons");
        assert.strictEqual(unauthenticated.status, 401);
        assert.deepStrictEqual(unauthenticated.body, { success: false, message: "Not authenticated" });
        const forbidden = await h.call("GET", "/api/seller/coupons", { as: buyer });
        assert.strictEqual(forbidden.status, 403);
        assert.deepStrictEqual(forbidden.body, { success: false, message: "Access restricted to sellers" });
    });

    await test("coupon validation returns a contract 400 rather than an error middleware 500", async () => {
        const response = await h.call("POST", "/api/seller/coupons", { as: seller, body: { coupon_name: "BAD", discount: 0, end_time: "not-a-date" } });
        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.success, false);
        assert.strictEqual(response.body.message, "Discount must be a number greater than 0 and at most 100");
    });

    await h.stop();
    process.exitCode = finish();
})();
