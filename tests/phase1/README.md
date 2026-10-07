# Phase 1 offline tests

Run all: `npm test`   (or each file with `node tests/phase1/<file>`)

| File | What it exercises |
|---|---|
| store_and_product_ownership.test.js | controllers called directly (ownership, mass-assignment, IDOR) |
| auth_middleware.test.js | auth / auth_seller / auth_super_admin behaviour |
| http_routes.test.js | REAL Express + routers + auth middleware (JWT cookie) + controllers over HTTP, incl. super_admin global access |
| migration_and_ai.test.js | runMigration() (dry-run, real run, idempotency, ambiguous records, index) and the multi-store AI store lookup |

IMPORTANT LIMITATION: no MongoDB/Redis is reachable where these were written, so the
Mongoose models and the MongoDB driver are replaced by in-memory fakes (mock_models.js and a
fake collection API in migration_and_ai.test.js). They prove the application logic, not real
MongoDB behaviour (unique-index enforcement, ObjectId casting in real queries, real `$type`
semantics, real index build). Before production: follow docs/PHASE1_MIGRATION.md on a STAGING copy
and click through the seller dashboard with two real seller accounts and a super_admin.
