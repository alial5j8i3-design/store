// Tests for (1) scripts/migrate_phase1.js runMigration() against an
// in-memory fake of the MongoDB driver's collection API, and (2) the
// multi-store-aware AI assistant store lookup.
//
// The fake db implements only the operators the migration uses ($or,
// $type:"string", $exists, $in, $ne, equality incl. null-matches-missing).
// It is NOT real MongoDB - see README for what still must be verified on
// a real staging database.

const path = require("path");
const assert = require("assert");
const mongoose = require(path.join(__dirname, "..", "..", "node_modules/mongoose"));
const { ObjectId } = mongoose.Types;

const PROJECT = path.join(__dirname, "..", "..");
const { runMigration } = require(path.join(PROJECT, "scripts/migrate_phase1.js"));

// ---------------- minimal fake driver ----------------
const sameId = (a, b) => String(a) === String(b);
function matchValue(docVal, cond) {
    if (cond && typeof cond === "object" && !(cond instanceof ObjectId) && !Array.isArray(cond)) {
        return Object.entries(cond).every(([op, arg]) => {
            switch (op) {
                case "$type": return arg === "string" ? typeof docVal === "string" : false;
                case "$exists": return arg ? docVal !== undefined : docVal === undefined;
                case "$in": return arg.some((v) => docVal !== undefined && sameId(v, docVal));
                case "$ne": return !(docVal !== undefined && docVal !== null && sameId(docVal, arg)) && !(arg === null && (docVal === undefined || docVal === null));
                default: throw new Error(`fake db: unsupported operator ${op}`);
            }
        });
    }
    if (cond === null) return docVal === undefined || docVal === null;
    return docVal !== undefined && docVal !== null && sameId(docVal, cond);
}
function matches(doc, filter) {
    return Object.entries(filter).every(([k, cond]) => {
        if (k === "$or") return cond.some((f) => matches(doc, f));
        return matchValue(doc[k], cond);
    });
}
function makeDb(seed) {
    const cols = {};
    const writes = { n: 0 };
    const col = (name) => {
        if (cols[name]) return cols[name];
        const docs = (seed[name] || []).map((d) => ({ ...d }));
        let indexes = seed[`${name}__indexes`] ? [...seed[`${name}__indexes`]] : null;
        const api = {
            _docs: docs,
            countDocuments: async (f = {}) => docs.filter((d) => matches(d, f)).length,
            find: (f = {}) => ({
                project() { return this; },
                toArray: async () => docs.filter((d) => matches(d, f)).map((d) => ({ ...d })),
            }),
            findOne: async (f) => { const d = docs.find((x) => matches(x, f)); return d ? { ...d } : null; },
            insertOne: async (d) => { writes.n++; const doc = { _id: new ObjectId(), ...d }; docs.push(doc); return { insertedId: doc._id }; },
            updateMany: async (f, u) => {
                let n = 0;
                for (const d of docs) if (matches(d, f)) { Object.assign(d, u.$set); n++; }
                if (n) writes.n++;
                return { modifiedCount: n };
            },
            indexes: async () => { if (!indexes) throw new Error("ns not found"); return indexes; },
            createIndex: async (keys, opts) => { writes.n++; indexes = (indexes || []).concat([{ key: keys, ...opts }]); },
            dropIndex: async (name) => { writes.n++; indexes = indexes.filter((i) => i.name !== name); },
        };
        return (cols[name] = api);
    };
    return { collection: col, writes };
}

// ---------------- scenario ----------------
const sellerOk = { _id: new ObjectId(), name: "Ahmed", role: "seller", phone_number: "0100" };
const sellerHasStore = { _id: new ObjectId(), name: "Sara", role: "seller" };
const demoted = { _id: new ObjectId(), name: "Demoted", role: "user" };
const ghostId = new ObjectId();
const existingStore = { _id: new ObjectId(), owner_id: sellerHasStore._id, store_name: "Sara Shop" };
const legacyStore = { _id: new ObjectId(), store_name: "Old global store" }; // no owner_id

const P = (over) => ({ _id: new ObjectId(), name: "p", ...over });
function seedData() {
    const products = [
        P({ seller_id: String(sellerOk._id) }),                       // string id, no store  -> convert + create store + backfill
        P({ seller_id: String(sellerOk._id) }),                       // same seller
        P({ seller_id: sellerHasStore._id }),                         // ObjectId, no store_id -> backfill to existing store
        P({ seller_id: String(sellerHasStore._id), store_id: existingStore._id }), // string type only -> convert, keep store_id
        P({ seller_id: "not-an-objectid" }),                          // garbage -> manual
        P({ name: "no-seller" }),                                     // missing seller_id -> manual
        P({ seller_id: String(ghostId) }),                            // no such user -> convert type, manual
        P({ seller_id: demoted._id }),                                // owner not seller -> manual, no store
        P({ seller_id: sellerHasStore._id, store_id: new ObjectId() }), // dangling store_id -> read-only report
        P({ seller_id: sellerOk._id, store_id: existingStore._id }),  // store owned by someone else -> read-only report
    ];
    return { products, users: [sellerOk, sellerHasStore, demoted], stores: [existingStore, legacyStore] };
}

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  PASS - ${name}`); passed++; }
    catch (e) { console.log(`  FAIL - ${name}\n         ${e.message}`); failed++; }
}
const quiet = () => {};

(async () => {
    console.log("\n=== migrate_phase1: dry run ===");
    const dryDb = makeDb(seedData());
    const before = JSON.stringify([dryDb.collection("products")._docs, dryDb.collection("users")._docs, dryDb.collection("stores")._docs]);
    let dry;
    await test("dry run makes ZERO writes and leaves every collection identical", async () => {
        dry = await runMigration(dryDb, { dryRun: true, log: quiet });
        eq(dryDb.writes.n, 0);
        eq(JSON.stringify([dryDb.collection("products")._docs, dryDb.collection("users")._docs, dryDb.collection("stores")._docs]), before);
    });
    await test("dry run predicts the work (1 store to create; conversions counted)", async () => {
        eq(dry.stores_created, 1); // only sellerOk
        eq(dry.seller_id_type_converted, 4); // 2 (Ahmed) + 1 (Sara, string) + 1 (ghost owner); the garbage id is NOT converted
        eq(dry.store_id_backfilled, 3);    // products 0,1 (new store) + 2 (Sara's existing store)
        eq(dry.index_action, "would create partial unique owner_id index");
    });

    console.log("\n=== migrate_phase1: real run ===");
    const db = makeDb(seedData());
    const prods = db.collection("products")._docs;
    const stores = db.collection("stores")._docs;
    let rep;
    await test("applies without throwing; real counts equal the dry-run prediction", async () => {
        rep = await runMigration(db, { log: quiet });
        eq(rep.seller_id_type_converted, dry.seller_id_type_converted);
        eq(rep.stores_created, dry.stores_created);
        eq(rep.store_id_backfilled, dry.store_id_backfilled);
    });

    await test("string seller_id -> ObjectId with the SAME value (no owner change)", async () => {
        const p0 = prods[0];
        assert.ok(p0.seller_id instanceof ObjectId);
        eq(String(p0.seller_id), String(sellerOk._id));
        assert.ok(prods[3].seller_id instanceof ObjectId);
    });
    await test("placeholder store created only for the real seller who owns products", async () => {
        const mine = stores.filter((s) => sameId(s.owner_id, sellerOk._id));
        eq(mine.length, 1); // exactly one placeholder store created
        const created = mine.find((s) => s.store_name === "Ahmed's Store");
        assert.ok(created);
        eq(created.store_phone, "0100");
        eq(stores.filter((s) => sameId(s.owner_id, demoted._id)).length, 0);
        eq(stores.filter((s) => sameId(s.owner_id, ghostId)).length, 0);
    });
    await test("store_id backfilled from the seller's OWN store", async () => {
        const createdStore = stores.find((s) => s.store_name === "Ahmed's Store");
        eq(String(prods[0].store_id), String(createdStore._id));
        eq(String(prods[1].store_id), String(createdStore._id));
        eq(String(prods[2].store_id), String(existingStore._id));
    });
    await test("existing store_id values are never overwritten", async () => {
        eq(String(prods[3].store_id), String(existingStore._id));
        eq(String(prods[9].store_id), String(existingStore._id));
        assert.ok(prods[8].store_id);
    });
    await test("ambiguous records are NOT assigned an owner/store and are reported", async () => {
        eq(prods[4].seller_id, "not-an-objectid");
        eq(prods[4].store_id, undefined);
        eq(prods[5].seller_id, undefined);
        eq(prods[7].store_id, undefined);
        eq(prods[6].store_id, undefined);
        const r = rep.needs_manual_review;
        eq(r.invalid_or_missing_seller_id.length, 2);
        eq(r.seller_id_matches_no_user.length, 1);
        eq(r.owner_is_not_a_seller.length, 1);
        eq(r.store_id_points_to_missing_store.length, 1);
        eq(r.store_id_owner_mismatch.length, 1);
        eq(r.stores_without_owner.length, 1);
    });
    await test("legacy ownerless store is left untouched", async () => {
        const legacy = stores.find((s) => String(s._id) === String(legacyStore._id));
        eq(legacy.owner_id, undefined);
        eq(legacy.store_name, "Old global store");
    });
    await test("nothing is deleted (same document counts)", async () => {
        eq(prods.length, 10);
        eq(db.collection("users")._docs.length, 3);
        eq(stores.length, 3); // 2 seeded + 1 created
    });
    await test("index created as PARTIAL unique on owner_id", async () => {
        const idx = await db.collection("stores").indexes();
        eq(idx.length, 1);
        assert.ok(idx[0].unique && idx[0].partialFilterExpression);
    });

    console.log("\n=== migrate_phase1: idempotency ===");
    await test("second real run changes nothing (0 writes, 0 conversions, 0 new stores)", async () => {
        const writesBefore = db.writes.n;
        const snapshot = JSON.stringify([prods, stores]);
        const again = await runMigration(db, { log: quiet });
        eq(db.writes.n, writesBefore);
        eq(again.stores_created, 0);
        eq(again.store_id_backfilled, 0);
        eq(again.index_action, "already correct");
        // only string-typed ambiguous ids may be re-counted (they stay unconverted by design)
        eq(JSON.stringify([prods, stores]), snapshot);
    });

    console.log("\n=== migrate_phase1: pre-existing NON-partial index gets replaced ===");
    await test("old plain-unique owner_id index -> replaced by partial (index only)", async () => {
        const db2 = makeDb({ ...seedData(), stores__indexes: [{ name: "owner_id_1", key: { owner_id: 1 }, unique: true }] });
        const d = await runMigration(db2, { dryRun: true, log: quiet });
        eq(d.index_action, "would replace non-partial owner_id index with partial unique index");
        const r = await runMigration(db2, { log: quiet });
        eq(r.index_action, "replaced non-partial owner_id index with partial unique index");
        assert.ok((await db2.collection("stores").indexes())[0].partialFilterExpression);
    });

    console.log("\n=== AI assistant: no blind global store lookup ===");
    // fake store model for the tools module
    const Module = require("module");
    const storeAbs = require.resolve(path.join(PROJECT, "models/store.js"));
    const aiStores = [
        { _id: new ObjectId(), owner_id: new ObjectId(), store_name: "Alpha Electronics", store_phone: "111", store_whatsApp_number: "222", store_GPS: "g1", createdAt: 3 },
        { _id: new ObjectId(), owner_id: new ObjectId(), store_name: "Beta Books", store_phone: "333", createdAt: 2 },
        { _id: new ObjectId(), owner_id: new ObjectId(), store_name: "Alpha Toys", store_phone: "444", createdAt: 1 },
    ];
    let lastFilter = null;
    const fakeStoreModel = {
        find(filter = {}) {
            lastFilter = filter;
            let out = aiStores.filter((s) => {
                const c = filter.store_name;
                if (!c) return true;
                return new RegExp(c.$regex, c.$options).test(s.store_name);
            });
            const q = {
                select(fields) { this._fields = String(fields).split(/\s+/); return this; },
                sort() { return this; },
                limit(n) { this._n = n; return this; },
                async lean() {
                    return out.slice(0, this._n || out.length).map((s) => {
                        const r = { _id: s._id };
                        for (const f of this._fields || []) if (s[f] !== undefined) r[f] = s[f];
                        return r;
                    });
                },
            };
            return q;
        },
        findOne() { throw new Error("findOne({}) must never be used for AI store info"); },
    };
    require.cache[storeAbs] = { id: storeAbs, filename: storeAbs, loaded: true, exports: fakeStoreModel };
    for (const m of ["models/products.js", "models/section.js"]) {
        const abs = require.resolve(path.join(PROJECT, m));
        require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: {} };
    }
    const tools = require(path.join(PROJECT, "services/ai_assistant.tools.js"));

    await test("only product/section tools are exposed (no store, users, orders, admin)", async () => {
        const names = tools.TOOL_DEFINITIONS.map(t => t.function.name).sort();
        assert.deepStrictEqual(names, ["get_sections", "search_products"]);
    });
    await test("store/user tools requested by the model are rejected", async () => {
        for (const name of ["get_store_info", "get_users", "get_orders", "get_super_admin"]) {
            const r = await tools.executeTool(name, "{}");
            assert.ok(r.result.error, name + " must be refused");
        }
    });
    await test("tools module no longer exposes store lookups", async () => {
        assert.strictEqual(tools.executeGetStoreInfo, undefined);
        assert.strictEqual(tools.findStoreMentionedIn, undefined);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);

    function eq(a, b) { assert.strictEqual(a, b); }
})();