const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const { makeFakeModel, realSchema } = require("./mock_models");

const PROJECT = path.join(__dirname, "..", "..");
const Order = require(path.join(PROJECT, "models/order.js"));
const Products = require(path.join(PROJECT, "models/products.js"));
const Ticket = require(path.join(PROJECT, "models/ticket.js"));
const { is_valid_http_url, PHONE_REGEX } = require(path.join(PROJECT, "utils/validators.js"));
const { pick_store_fields } = require(path.join(PROJECT, "utils/store_fields.js"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS - ${name}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL - ${name}\n         ${error.message}`);
        failed++;
    }
}

function hasIndex(model, fields) {
    return model.schema.indexes().some(([keys]) => JSON.stringify(keys) === JSON.stringify(fields));
}

function inject(rel, exportsValue) {
    const abs = require.resolve(path.join(PROJECT, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsValue };
}

const FakeUsers = makeFakeModel("users", { uniqueFields: ["email"], schema: realSchema("users") });
inject("models/users.js", FakeUsers);
const register = require(path.join(PROJECT, "controller/register.controller.js"));

function response() {
    return {
        statusCode: 0,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        cookie() { return this; },
    };
}

function registration(extra = {}) {
    return {
        body: {
            name: "Valid User",
            email: "valid@example.test",
            password: "safe-test-password",
            phone_number: "+20 (10) 123-4567",
            whatsApp_number: "+20 10 123 4567",
            GPS_URL: "https://maps.app.goo.gl/example",
            ...extra,
        },
    };
}

(async () => {
    console.log("\n=== PERF-01 schema indexes ===");
    await test("order query indexes are declared", () => {
        assert.ok(hasIndex(Order, { "products.seller_id": 1, createdAt: -1 }));
        assert.ok(hasIndex(Order, { user_id: 1, createdAt: -1 }));
    });
    await test("product listing and section indexes are declared", () => {
        assert.ok(hasIndex(Products, { createdAt: -1 }));
        assert.ok(hasIndex(Products, { section: 1, createdAt: -1 }));
    });
    await test("ticket customer/store index is declared", () => {
        assert.ok(hasIndex(Ticket, { customer_id: 1, store_id: 1, createdAt: -1 }));
    });

    console.log("\n=== SEC-03 URL and contact validation ===");
    await test("only http/https URLs within the limit are accepted", () => {
        for (const value of ["javascript:alert(1)", "data:text/plain,x", "file:///tmp/x", "ftp://example.test", `https://example.test/${"x".repeat(501)}`]) {
            assert.strictEqual(is_valid_http_url(value), false);
        }
        assert.strictEqual(is_valid_http_url("  https://maps.app.goo.gl/example  "), true);
    });
    await test("store fields reject unsafe links and malformed phone numbers", () => {
        assert.ok(pick_store_fields({ store_GPS: "javascript:alert(1)" }).error);
        assert.ok(pick_store_fields({ store_phone: "letters-only" }).error);
        assert.ok(pick_store_fields({ store_whatsApp_number: "+20 (10) 123-4567", store_GPS: "https://maps.app.goo.gl/example" }).data);
        assert.ok(PHONE_REGEX.test("+20 (10) 123-4567"));
    });

    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    await test("registration rejects unsafe URL schemes and oversized URLs", async () => {
        for (const GPS_URL of ["javascript:alert(1)", "data:text/plain,x", "file:///tmp/x", "ftp://example.test", `https://example.test/${"x".repeat(501)}`]) {
            const res = response();
            await register(registration({ GPS_URL, email: `${Math.random()}@example.test` }), res);
            assert.strictEqual(res.statusCode, 400);
        }
    });
    await test("registration returns 400 before Mongoose for oversized names and bad phones", async () => {
        const longName = response();
        await register(registration({ name: "n".repeat(101), email: "long-name@example.test" }), longName);
        assert.strictEqual(longName.statusCode, 400);
        const badPhone = response();
        await register(registration({ phone_number: "letters", email: "bad-phone@example.test" }), badPhone);
        assert.strictEqual(badPhone.statusCode, 400);
    });
    await test("registration accepts a valid https GPS URL", async () => {
        const res = response();
        await register(registration(), res);
        assert.strictEqual(res.statusCode, 201);
    });
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
})();