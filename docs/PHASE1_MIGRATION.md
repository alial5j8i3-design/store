# Phase 1 migration runbook (staging first)

The script reads the DB address from the `MONGO_URL` environment variable.
NEVER paste connection strings/passwords into chat or commit them.
`.env` is loaded by dotenv but a variable already exported in your shell WINS,
so always export the STAGING url explicitly before running (so you can't
accidentally hit production because `.env` points there).

## 1. Backup (do this first)
    export MONGO_URL='<staging or prod connection string>'   # typed in YOUR terminal only
    mongodump --uri="$MONGO_URL" --gzip --out="./backup-$(date +%Y%m%d-%H%M)"
Atlas users: also take a cloud snapshot. Restore if needed:
    mongorestore --uri="$MONGO_URL" --gzip --drop ./backup-<folder>

## 2. Dry run (ZERO writes)
    npm run migrate:phase1:dry        # same as: node scripts/migrate_phase1.js --dry-run

## 3. Real migration (only after the dry-run report looks right)
    npm run migrate:phase1            # same as: node scripts/migrate_phase1.js
It is idempotent: running it again changes nothing.

## What changes
- products: `seller_id` string -> ObjectId (same value); `store_id` added where missing.
- stores: one placeholder store inserted per real seller (role=seller) who owns products but has no store.
- stores collection index: unique partial index on `owner_id` (index only).
- Nothing deleted; users / orders / sections / coupons / promotion requests untouched.

## Ambiguous records (listed in the report, left untouched)
invalid_or_missing_seller_id, seller_id_matches_no_user (type converted only),
owner_is_not_a_seller (type converted only, no store), store_id_points_to_missing_store,
store_id_owner_mismatch, stores_without_owner (legacy global store), stores_whose_owner_user_is_missing.

## Verify afterwards (mongosh)
    db.products.countDocuments({ seller_id: { $type: "string" } })          // expect: only the "invalid id" ones
    db.products.countDocuments({ store_id: { $exists: false } })            // expect: == ambiguous product count
    db.stores.aggregate([{ $group: { _id: "$owner_id", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])  // expect: none
    db.stores.getIndexes()                                                  // owner_id_1 unique + partialFilterExpression
    // users / orders counts must equal the counts you noted before migrating
Then start the app and, as two real sellers + one super_admin, exercise the dashboard and endpoints.
