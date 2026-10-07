const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const { ObjectId } = require("./mock_models");

const PROJECT = path.join(__dirname, "..", "..");
const { validateEnvironment } = require(path.join(PROJECT, "config/env_check.js"));

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

function inject(rel, exportsValue) {
    const abs = require.resolve(path.join(PROJECT, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsValue };
}

class FakeUsers {
    constructor(data) {
        Object.assign(this, data);
        this._id = this._id || new ObjectId();
    }

    async save() {
        if (FakeUsers.records.some((user) => user.role === "super_admin" && this.role === "super_admin")) {
            const error = new Error("duplicate super admin");
            error.code = 11000;
            throw error;
        }
        if (FakeUsers.records.some((user) => user.email === this.email)) {
            const error = new Error("duplicate email");
            error.code = 11000;
            throw error;
        }
        FakeUsers.records.push({ ...this });
        return this;
    }

    static findOne(filter) {
        const found = FakeUsers.records.find((user) => Object.entries(filter).every(([key, value]) => String(user[key]) === String(value)));
        return {
            select() { return this; },
            lean: async () => found ? { ...found } : null,
        };
    }

    static reset() { FakeUsers.records = []; }
}
FakeUsers.records = [];

inject("models/users.js", FakeUsers);
const registerSuperAdmin = require(path.join(PROJECT, "controller/register_super_admin.js"));

function response() {
    return {
        statusCode: 0,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        cookie() { return this; },
    };
}

function request(setupToken, useHeader = false) {
    return {
        body: {
            name: "Initial Admin",
            email: "admin@example.test",
            password: "safe-test-password",
            ...(!useHeader && setupToken !== undefined ? { setup_token: setupToken } : {}),
        },
        headers: useHeader ? { "x-super-admin-setup-token": setupToken } : {},
    };
}

(async () => {
    console.log("\n=== Environment validation ===");
    await test("production rejects short, placeholder, and repeated JWT secrets", () => {
        for (const JWT_SECRET of ["short", "replace_with_a_secret", "MY_SECRETMY_SECRETMY_SECRETMY_SECRET"]) {
            const result = validateEnvironment({ NODE_ENV: "production", JWT_SECRET, MONGO_URL: "mongodb://db", STORE_URL: "https://store.test" });
            assert.ok(result.errors.some((error) => error.includes("JWT_SECRET")));
        }
    });
    await test("production accepts a random 48-byte secret", () => {
        const result = validateEnvironment({ NODE_ENV: "production", JWT_SECRET: crypto.randomBytes(48).toString("hex"), MONGO_URL: "mongodb://db", STORE_URL: "https://store.test/path" });
        assert.deepStrictEqual(result.errors, []);
    });
    await test("development warns but does not reject a placeholder", () => {
        const result = validateEnvironment({ NODE_ENV: "development", JWT_SECRET: "replace_me" });
        assert.deepStrictEqual(result.errors, []);
        assert.ok(result.warnings.length > 0);
    });

    console.log("\n=== Super-admin setup token ===");
    const previous = { NODE_ENV: process.env.NODE_ENV, SUPER_ADMIN_SETUP_TOKEN: process.env.SUPER_ADMIN_SETUP_TOKEN, JWT_SECRET: process.env.JWT_SECRET };
    process.env.NODE_ENV = "development";
    process.env.SUPER_ADMIN_SETUP_TOKEN = "correct-setup-token";
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");

    await test("missing and wrong setup tokens return 403", async () => {
        FakeUsers.reset();
        for (const token of [undefined, "wrong"]) {
            const res = response();
            await registerSuperAdmin(request(token), res);
            assert.strictEqual(res.statusCode, 403);
        }
    });
    await test("correct setup token creates the first super admin", async () => {
        FakeUsers.reset();
        const res = response();
        await registerSuperAdmin(request("correct-setup-token"), res);
        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(FakeUsers.records.length, 1);
    });
    await test("the setup token is also accepted in the request header", async () => {
        FakeUsers.reset();
        const res = response();
        await registerSuperAdmin(request("correct-setup-token", true), res);
        assert.strictEqual(res.statusCode, 201);
    });
    await test("an existing super admin is still rejected", async () => {
        const res = response();
        await registerSuperAdmin(request("correct-setup-token"), res);
        assert.strictEqual(res.statusCode, 400);
    });
    await test("concurrent initial registrations leave exactly one super admin", async () => {
        FakeUsers.reset();
        const first = response();
        const second = response();
        await Promise.all([
            registerSuperAdmin(request("correct-setup-token"), first),
            registerSuperAdmin({ ...request("correct-setup-token"), body: { ...request("correct-setup-token").body, email: "other@example.test" } }, second),
        ]);
        assert.deepStrictEqual([first.statusCode, second.statusCode].sort(), [201, 400]);
        assert.strictEqual(FakeUsers.records.length, 1);
    });
    await test("production without setup configuration hides the endpoint", async () => {
        FakeUsers.reset();
        process.env.NODE_ENV = "production";
        delete process.env.SUPER_ADMIN_SETUP_TOKEN;
        const res = response();
        await registerSuperAdmin(request("anything"), res);
        assert.strictEqual(res.statusCode, 404);
    });

    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.SUPER_ADMIN_SETUP_TOKEN === undefined) delete process.env.SUPER_ADMIN_SETUP_TOKEN; else process.env.SUPER_ADMIN_SETUP_TOKEN = previous.SUPER_ADMIN_SETUP_TOKEN;
    if (previous.JWT_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous.JWT_SECRET;

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
})();
