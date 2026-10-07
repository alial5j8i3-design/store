/**
 * Build the indexes declared in the Mongoose schemas.
 *
 * USAGE
 * -----
 *   node scripts/sync_indexes.js      (or: npm run sync:indexes)
 *
 * The connection string is read from MONGO_URL (environment / .env), the same
 * variable server.js uses. It is never printed.
 *
 * WHAT IT DOES
 * ------------
 * Calls Model.createIndexes() for every model. That only ADDS indexes that are
 * missing; indexes that already exist with the same definition are a no-op.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * - Never calls syncIndexes() and never drops or rebuilds an index.
 * - Never reads, writes or migrates documents.
 *
 * If one model fails (for example a unique index cannot be built because the
 * collection already holds duplicates, or an index with the same key but
 * different options already exists) the error is reported, the remaining
 * models are still processed, and the process exits with code 1. Nothing is
 * changed automatically in that case - resolve it by hand on staging first.
 */
require("dotenv").config();

const mongoose = require("mongoose");

function loadModels() {
    return [
        require("../models/Promotion_requests_for_salesperson"),
        require("../models/coupon"),
        require("../models/order"),
        require("../models/order_archive"),
        require("../models/products"),
        require("../models/section"),
        require("../models/store"),
        require("../models/ticket"),
        require("../models/users"),
    ];
}

async function run() {
    if (!process.env.MONGO_URL) {
        console.error("MONGO_URL is not set. Aborting - nothing was changed.");
        return 1;
    }

    // autoIndex is off for this connection: indexes are built only by the
    // explicit createIndexes() calls below, one model at a time.
    await mongoose.connect(process.env.MONGO_URL, {
        autoIndex: false,
        maxPoolSize: 2,
        serverSelectionTimeoutMS: 10000,
    });

    let failures = 0;
    for (const model of loadModels()) {
        try {
            await model.createIndexes();
            console.log(`${model.modelName}: indexes ensured`);
        } catch (error) {
            failures += 1;
            console.error(`${model.modelName}: FAILED - ${error.message}`);
        }
    }

    if (failures) {
        console.error(`${failures} model(s) failed. No index was dropped or modified.`);
        return 1;
    }
    console.log("All indexes ensured.");
    return 0;
}

if (require.main === module) {
    run()
        .catch((error) => {
            console.error("Failed to ensure indexes:", error.message);
            return 1;
        })
        .then(async (code) => {
            try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
            process.exitCode = code;
        });
}

module.exports = { run, loadModels };