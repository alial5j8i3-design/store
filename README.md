# Phase 1 offline tests

Run all: `npm test`   (or each file with `node tests/phase1/<file>`)

| File | What it exercises |
|---|---|
| store_and_product_ownership.test.js | controllers called directly (ownership, mass-assignment, IDOR) |
| auth_middleware.test.js | auth / auth_seller / auth_super_admin behaviour |
| http_routes.test.js | REAL Express + routers + auth middleware (JWT cookie) + controllers over HTTP, incl. super_admin global access |
| mock_models.test.js | the fake model layer itself (type strictness, $inc/$push/$pull/$gte/$ne, update semantics, min/max/enum) - `npm run test:infra` |
| migration_and_ai.test.js | runMigration() (dry-run, real run, idempotency, ambiguous records, index) and the multi-store AI store lookup |

IMPORTANT LIMITATION: no MongoDB/Redis is reachable where these were written, so the
Mongoose models and the MongoDB driver are replaced by in-memory fakes (mock_models.js and a
fake collection API in migration_and_ai.test.js). They prove the application logic, not real
MongoDB behaviour (unique-index enforcement, ObjectId casting in real queries, real `$type`
semantics, real index build). Before production: follow docs/PHASE1_MIGRATION.md on a STAGING copy
and click through the seller dashboard with two real seller accounts and a super_admin.

## Strict fake models

`mock_models.js` compares values WITH their type (`ObjectId("x")` never matches `"x"`), throws on unknown
query/update operators, returns the pre-update document from `findOneAndUpdate` unless `new: true`, and
validates min/max/enum/required. Pass the real schema so it casts only the paths Mongoose would cast:
`makeFakeModel("products", { schema: realSchema("products") })`. Call `realSchema()` before a test injects a fake
over `models/*.js` (results are cached). Paths Mongoose treats as Mixed (e.g. `reviews._id`) are NOT cast.

## Real MongoDB tests

`npm run test:integration` runs `tests/integration/real_mongoose.test.js` against mongodb-memory-server with the
real models. If the mongod binary cannot be downloaded/started it prints SKIPPED (nothing verified) and exits 0;
set `REQUIRE_REAL_DB=1` to make that a failure.


## MongoDB indexes (production)

`server.js` connects with `autoIndex: NODE_ENV !== "production"`, so development and test keep Mongoose's automatic
index creation, while production never builds indexes at application start (no blocking builds on large collections
and no race between PM2 workers). In production, build the indexes explicitly - on staging first, then production,
with `MONGO_URL` set:

```bash
npm run sync:indexes        # same as: node scripts/sync_indexes.js
```

The script only calls `createIndexes()`: it adds missing indexes, never drops or rebuilds one, and never touches
documents. It is safe to re-run. If a model fails (e.g. a unique index over existing duplicate data, or an index with
the same key but different options) it reports that model, continues with the rest, and exits with code 1.
Run it after deploying a release that changes a schema's indexes.