const assert = require("assert");
const path = require("path");
const { authenticatedUserKey } = require(path.join(__dirname, "..", "..", "utils/rate_limit_store.js"));

const first = authenticatedUserKey({ ip: "203.0.113.1", user: { _id: "buyer-a" } });
const second = authenticatedUserKey({ ip: "203.0.113.1", user: { _id: "buyer-b" } });
assert.strictEqual(first, "buyer-a");
assert.strictEqual(second, "buyer-b");
assert.notStrictEqual(first, second);
console.log("PASS - authenticated operation limit keys use user id, not shared IP");
// Requiring the store module starts an ioredis client that keeps retrying when Redis is down; exit so the test cannot hang.
process.exit(0);