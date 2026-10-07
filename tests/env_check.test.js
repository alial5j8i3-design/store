"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { validateEnvironment, trustProxyHops, mongoMaxPoolSize } = require("../config/env_check");

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS - ${name}`); passed += 1; }
    catch (error) { console.log(`  FAIL - ${name}\n         ${error.message}`); failed += 1; }
}

const validProduction = () => ({
    NODE_ENV: "production",
    JWT_SECRET: "safe-test-secret-value-with-at-least-thirty-two-characters",
    MONGO_URL: "mongodb://database.test/app",
    STORE_URL: "https://store.test",
});

(async () => {
    console.log("\n=== SEC-01 environment validation ===");
    await test("valid production security configuration is accepted", () => {
        const result = validateEnvironment(validProduction());
        assert.strictEqual(result.production, true);
        assert.deepStrictEqual(result.errors, []);
    });

    await test("production rejects a missing JWT secret instead of using a default", () => {
        const environment = validProduction();
        delete environment.JWT_SECRET;
        const result = validateEnvironment(environment);
        assert.ok(result.errors.some((message) => message.startsWith("JWT_SECRET")));
    });

    await test("production enforces the existing 32-character JWT secret minimum", () => {
        const result = validateEnvironment({ ...validProduction(), JWT_SECRET: "x".repeat(31) });
        assert.ok(result.errors.some((message) => message.startsWith("JWT_SECRET")));
    });

    await test("production rejects placeholder and repeated JWT secrets", () => {
        for (const JWT_SECRET of ["replace-with-a-secret-value-that-is-long-enough", "abc123abc123abc123abc123abc123abc123"]) {
            const result = validateEnvironment({ ...validProduction(), JWT_SECRET });
            assert.ok(result.errors.some((message) => message.startsWith("JWT_SECRET")));
        }
    });

    await test("production requires the configured Mongo URL and public store URL", () => {
        for (const key of ["MONGO_URL", "STORE_URL"]) {
            const environment = validProduction();
            delete environment[key];
            const result = validateEnvironment(environment);
            assert.ok(result.errors.some((message) => message.startsWith(key)));
        }
    });

    await test("proxy and Mongo pool configuration retain their safe documented defaults", () => {
        assert.strictEqual(trustProxyHops({}), 1);
        assert.strictEqual(trustProxyHops({ TRUST_PROXY_HOPS: "2" }), 2);
        assert.strictEqual(mongoMaxPoolSize({}), 10);
        assert.strictEqual(mongoMaxPoolSize({ MONGO_MAX_POOL_SIZE: "500" }), 100);
    });

    console.log("\n=== CFG-01 .env.example ===");
    const examplePath = path.join(__dirname, "..", ".env.example");
    const readExample = () => fs.readFileSync(examplePath, "utf8");
    const parseExample = (includeCommented) => {
        const values = {};
        for (const line of readExample().split(/\r?\n/)) {
            const match = /^\s*(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
            if (!match || (match[1] && !includeCommented)) continue;
            values[match[2]] = match[3].split(/\s+#/)[0].trim();
        }
        return values;
    };

    await test(".env.example exists and documents every required production variable", () => {
        assert.ok(fs.existsSync(examplePath), ".env.example is missing");
        const documented = parseExample(true);
        for (const key of ["NODE_ENV", "JWT_SECRET", "MONGO_URL", "STORE_URL", "TRUST_PROXY_HOPS", "REDIS_URL", "SUPER_ADMIN_SETUP_TOKEN"]) {
            assert.ok(key in documented, `${key} is not documented in .env.example`);
        }
    });

    await test(".env.example JWT_SECRET placeholder is refused by production validation", () => {
        const { JWT_SECRET } = parseExample(false);
        assert.ok(JWT_SECRET, "JWT_SECRET must be present as a placeholder");
        const result = validateEnvironment({ ...validProduction(), JWT_SECRET });
        assert.ok(result.errors.some((message) => message.startsWith("JWT_SECRET")));
    });

    await test(".env.example does not enable empty values that would override code defaults", () => {
        const active = parseExample(false);
        for (const key of ["TRUST_PROXY_HOPS", "MONGO_MAX_POOL_SIZE", "JWT_EXPIRES_IN", "AI_TEMPERATURE", "AI_MAX_RETRIES", "AI_REQUEST_TIMEOUT_MS"]) {
            assert.ok(!(key in active), `${key} must stay commented out in .env.example`);
        }
    });

    await test(".env.example contains no real-looking secrets", () => {
        const text = readExample();
        assert.ok(!/mongodb(\+srv)?:\/\/[^\s:@]+:[^\s@]+@/i.test(text), "Mongo URL with credentials found");
        assert.ok(!/redis(s)?:\/\/[^\s:@]*:[^\s@]+@/i.test(text), "Redis URL with credentials found");
        assert.ok(!/\b(sk|gsk|xai|AIza)[-_][A-Za-z0-9_-]{16,}/.test(text), "API-key-like value found");
        assert.ok(!/\b[a-f0-9]{48,}\b/i.test(text), "long hex secret found");
        assert.strictEqual(parseExample(false).AI_API_KEY, "");
    });

    await test("production warns when several workers run without REDIS_URL", () => {
        const withoutRedis = validateEnvironment({ ...validProduction(), PM2_INSTANCES: "4" });
        assert.deepStrictEqual(withoutRedis.errors, []);
        assert.ok(withoutRedis.warnings.some((message) => message.startsWith("REDIS_URL")));
        const withRedis = validateEnvironment({ ...validProduction(), PM2_INSTANCES: "4", REDIS_URL: "redis://cache.test:6379" });
        assert.ok(!withRedis.warnings.some((message) => message.startsWith("REDIS_URL")));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
})();