require("dotenv").config();
const path = require("path");
const jwt = require("jsonwebtoken");
const assert = require("assert");
const { makeFakeModel, realSchema, ObjectId } = require("./mock_models");

const FakeUsers = makeFakeModel("user", { schema: realSchema("users") });
const PROJECT = path.join(__dirname, "..", "..");
function injectFakeModule(rel, exportsValue) {
    const abs = require.resolve(path.join(PROJECT, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsValue };
}
injectFakeModule("models/users.js", FakeUsers);

const auth = require(path.join(PROJECT, "middleware/auth.js"));
const auth_seller = require(path.join(PROJECT, "middleware/auth_seller.js"));
const auth_super_admin = require(path.join(PROJECT, "middleware/auth_super_admin.js"));

const sellerA = { _id: new ObjectId(), name: "Seller A", role: "seller" };
const normalUser = { _id: new ObjectId(), name: "Normal", role: "user" };
FakeUsers.__seed([sellerA, normalUser]);

function makeRes() {
    return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function signFor(user) {
    return jwt.sign({ id: user._id, name: user.name, role: user.role }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS - ${name}`); passed++; }
    catch (e) { console.log(`  FAIL - ${name}\n         ${e.message}`); failed++; }
}

(async () => {
    console.log("=== Auth middleware ===");

    await test("auth_seller: no cookie -> 401", async () => {
        const req = { cookies: {} };
        const res = makeRes();
        let nextCalled = false;
        await auth_seller(req, res, () => { nextCalled = true; });
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(nextCalled, false);
    });

    await test("auth_seller: valid token but role=user -> 403", async () => {
        const req = { cookies: { token: signFor(normalUser) } };
        const res = makeRes();
        let nextCalled = false;
        await auth_seller(req, res, () => { nextCalled = true; });
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(nextCalled, false);
    });

    await test("auth_seller: valid token + role=seller -> next() called, req.user set", async () => {
        const req = { cookies: { token: signFor(sellerA) } };
        const res = makeRes();
        let nextCalled = false;
        await auth_seller(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(req.user._id.toString(), sellerA._id.toString());
    });

    await test("auth_super_admin: seller token -> 403", async () => {
        const req = { cookies: { token: signFor(sellerA) } };
        const res = makeRes();
        let nextCalled = false;
        await auth_super_admin(req, res, () => { nextCalled = true; });
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(nextCalled, false);
    });

    await test("auth: tampered token -> 401", async () => {
        const req = { cookies: { token: signFor(sellerA) + "tampered" } };
        const res = makeRes();
        let nextCalled = false;
        await auth(req, res, () => { nextCalled = true; });
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(nextCalled, false);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();