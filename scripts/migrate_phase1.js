/**
 * Phase 1 migration: store ownership + seller_id/store_id on products.
 *
 * USAGE
 * -----
 *   node scripts/migrate_phase1.js --dry-run   # report only, ZERO writes
 *   node scripts/migrate_phase1.js             # apply
 *
 * The connection string is read from MONGO_URL (environment / .env).
 * Nothing secret is printed, logged or stored by this script.
 *
 * WHAT IT DOES (real run)
 * -----------------------
 * 1. products.seller_id stored as a BSON *string* -> rewritten as an
 *    ObjectId with the SAME value (type change only, never a new owner).
 * 2. For each seller (users.role === "seller") that owns at least one
 *    product but has no store yet, creates ONE minimal placeholder store
 *    (name "<seller name>'s Store" + the seller's own contact fields).
 *    The owner is the seller_id already written on the product - it is
 *    never inferred from anything else.
 * 3. Sets products.store_id from the owner's store, ONLY where store_id
 *    is missing (an existing store_id is never overwritten).
 * 4. Makes sure the unique owner_id index on the stores collection is the
 *    partial one the model declares (see models/store.js). Only an index
 *    is touched - no documents.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * - Never deletes any document. Never touches users, orders, sections,
 *   coupons or promotion requests.
 * - Never guesses ownership. Anything ambiguous is left exactly as it is
 *   and listed in the report for a human decision:
 *     * products whose seller_id is not a valid ObjectId (or missing)
 *     * products whose seller_id matches no user (type still converted)
 *     * products whose owner exists but is not role "seller" (type still
 *       converted, NO store created, NO store_id set)
 *     * products whose existing store_id points to a missing store, or to
 *       a store owned by somebody else (READ-ONLY check, not modified)
 *     * stores with no owner_id (legacy single global store) or whose
 *       owner user does not exist (READ-ONLY, not modified)
 *
 * IDEMPOTENT: a second run finds nothing to change and reports 0 writes.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;
const OWNER_INDEX_NAME = "owner_id_1";
const OWNER_INDEX_OPTIONS = {
    unique: true,
    name: OWNER_INDEX_NAME,
    partialFilterExpression: { owner_id: { $exists: true } },
};

function slugBase(name) {
    const ascii = String(name || "store").normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return (ascii || "store").slice(0, 90).replace(/-+$/g, "") || "store";
}

async function uniqueSlug(storesCol, name) {
    const base = slugBase(name);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
        if (!await storesCol.findOne({ slug }, { projection: { _id: 1 } })) return slug;
    }
    throw new Error(`Unable to create a unique slug for ${name}`);
}

/**
 * @param {import("mongodb").Db} db
 * @param {{dryRun?: boolean, log?: Function, ObjectId?: any, names?: object}} opts
 * @returns {Promise<object>} the report
 */
async function runMigration(db, opts = {}) {
    const dryRun = !!opts.dryRun;
    const log = opts.log || console.log;
    const ObjectId = opts.ObjectId || mongoose.Types.ObjectId;
    const names = {
        products: "products",
        users: "users",
        stores: "stores",
        ...(opts.names || {}),
    };

    const productsCol = db.collection(names.products);
    const usersCol = db.collection(names.users);
    const storesCol = db.collection(names.stores);

    const report = {
        dry_run: dryRun,
        products_total: 0,
        seller_id_type_converted: 0,
        stores_created: 0,
        store_id_backfilled: 0,
        index_action: "none",
        needs_manual_review: {
            invalid_or_missing_seller_id: [],
            seller_id_matches_no_user: [],
            owner_is_not_a_seller: [],
            store_id_points_to_missing_store: [],
            store_id_owner_mismatch: [],
            stores_without_owner: [],
            stores_whose_owner_user_is_missing: [],
        },
    };
    const review = report.needs_manual_review;

    report.products_total = await productsCol.countDocuments({});

    // ---- 1. products that need work (real BSON types, no Mongoose casting)
    const candidates = await productsCol
        .find({ $or: [{ seller_id: { $type: "string" } }, { store_id: { $exists: false } }] })
        .project({ seller_id: 1, store_id: 1 })
        .toArray();

    const bySeller = new Map(); // seller_id string -> [product docs]
    for (const p of candidates) {
        const key = p.seller_id === undefined || p.seller_id === null ? "" : String(p.seller_id);
        if (!bySeller.has(key)) bySeller.set(key, []);
        bySeller.get(key).push(p);
    }
    log(`Products needing attention: ${candidates.length} (across ${bySeller.size} distinct seller_id value(s)).`);

    for (const [sellerKey, docs] of bySeller.entries()) {
        if (!OBJECT_ID_RE.test(sellerKey)) {
            review.invalid_or_missing_seller_id.push(
                ...docs.map((d) => ({ product_id: String(d._id), seller_id: sellerKey || null })),
            );
            continue;
        }

        const sellerObjectId = new ObjectId(sellerKey);
        const stringTyped = docs.filter((d) => typeof d.seller_id === "string");

        // Type-only change: same value, string -> ObjectId.
        const convertType = async () => {
            if (stringTyped.length === 0) return;
            if (!dryRun) {
                await productsCol.updateMany(
                    { _id: { $in: stringTyped.map((d) => d._id) }, seller_id: { $type: "string" } },
                    { $set: { seller_id: sellerObjectId } },
                );
            }
            report.seller_id_type_converted += stringTyped.length;
        };

        const owner = await usersCol.findOne({ _id: sellerObjectId });

        if (!owner) {
            await convertType();
            review.seller_id_matches_no_user.push(
                ...docs.map((d) => ({ product_id: String(d._id), seller_id: sellerKey })),
            );
            continue;
        }

        if (owner.role !== "seller") {
            await convertType();
            review.owner_is_not_a_seller.push(
                ...docs.map((d) => ({ product_id: String(d._id), seller_id: sellerKey, owner_role: owner.role || null })),
            );
            continue;
        }

        await convertType();

        const needStoreId = docs.filter((d) => d.store_id === undefined || d.store_id === null);
        if (needStoreId.length === 0) continue;

        let sellerStore = await storesCol.findOne({ owner_id: sellerObjectId });

        if (!sellerStore) {
            const storeName = owner.name ? `${owner.name}'s Store` : "My Store";
            if (!dryRun) {
                const now = new Date();
                const slug = await uniqueSlug(storesCol, storeName);
                const r = await storesCol.insertOne({
                    owner_id: sellerObjectId,
                    store_name: storeName,
                    slug,
                    store_description: "",
                    store_phone: owner.phone_number || "",
                    store_whatsApp_number: owner.whatsApp_number || "",
                    store_GPS: owner.GPS_URL || "",
                    store_design: {},
                    createdAt: now,
                    updatedAt: now,
                });
                sellerStore = { _id: r.insertedId };
            } else {
                sellerStore = { _id: null };
            }
            report.stores_created += 1;
            log(`  ${dryRun ? "[dry-run] would create" : "created"} store "${storeName}" for seller ${sellerKey}`);
        }

        if (!dryRun) {
            await productsCol.updateMany(
                {
                    _id: { $in: needStoreId.map((d) => d._id) },
                    $or: [{ store_id: { $exists: false } }, { store_id: null }],
                },
                { $set: { store_id: sellerStore._id } },
            );
        }
        report.store_id_backfilled += needStoreId.length;
    }

    // ---- 2. read-only consistency checks (never modified) ----
    const withStore = await productsCol
        .find({ store_id: { $exists: true, $ne: null } })
        .project({ seller_id: 1, store_id: 1 })
        .toArray();

    if (withStore.length) {
        const storeIds = [...new Set(withStore.map((p) => String(p.store_id)))].filter((s) => OBJECT_ID_RE.test(s));
        const storeDocs = storeIds.length
            ? await storesCol.find({ _id: { $in: storeIds.map((s) => new ObjectId(s)) } }).project({ owner_id: 1 }).toArray()
            : [];
        const storeOwner = new Map(storeDocs.map((s) => [String(s._id), s.owner_id ? String(s.owner_id) : null]));

        for (const p of withStore) {
            const sk = String(p.store_id);
            if (!storeOwner.has(sk)) {
                review.store_id_points_to_missing_store.push({ product_id: String(p._id), store_id: sk });
            } else if (storeOwner.get(sk) !== String(p.seller_id)) {
                review.store_id_owner_mismatch.push({
                    product_id: String(p._id),
                    seller_id: String(p.seller_id),
                    store_id: sk,
                    store_owner_id: storeOwner.get(sk),
                });
            }
        }
    }

    const allStores = await storesCol.find({}).project({ owner_id: 1, store_name: 1 }).toArray();
    const ownerIds = [...new Set(allStores.filter((s) => s.owner_id).map((s) => String(s.owner_id)))].filter((s) => OBJECT_ID_RE.test(s));
    const existingOwners = ownerIds.length
        ? new Set(
              (await usersCol.find({ _id: { $in: ownerIds.map((s) => new ObjectId(s)) } }).project({ _id: 1 }).toArray()).map((u) =>
                  String(u._id),
              ),
          )
        : new Set();

    for (const s of allStores) {
        if (!s.owner_id) {
            review.stores_without_owner.push({ store_id: String(s._id), store_name: s.store_name || null });
        } else if (!existingOwners.has(String(s.owner_id))) {
            review.stores_whose_owner_user_is_missing.push({ store_id: String(s._id), owner_id: String(s.owner_id) });
        }
    }

    // ---- 3. index: partial unique owner_id on stores (index only, no data) ----
    let existingIndexes = [];
    try {
        existingIndexes = await storesCol.indexes();
    } catch (e) {
        existingIndexes = []; // collection does not exist yet
    }
    const ownerIdx = existingIndexes.find((i) => i.name === OWNER_INDEX_NAME);

    if (!ownerIdx) {
        report.index_action = dryRun ? "would create partial unique owner_id index" : "created partial unique owner_id index";
        if (!dryRun) await storesCol.createIndex({ owner_id: 1 }, OWNER_INDEX_OPTIONS);
    } else if (!ownerIdx.partialFilterExpression) {
        report.index_action = dryRun
            ? "would replace non-partial owner_id index with partial unique index"
            : "replaced non-partial owner_id index with partial unique index";
        if (!dryRun) {
            await storesCol.dropIndex(OWNER_INDEX_NAME);
            await storesCol.createIndex({ owner_id: 1 }, OWNER_INDEX_OPTIONS);
        }
    } else {
        report.index_action = "already correct";
    }

    return report;
}

function printReport(report, log = console.log) {
    log("\n================ PHASE 1 MIGRATION REPORT ================");
    log(`Mode: ${report.dry_run ? "DRY RUN (nothing was written)" : "APPLIED"}`);
    log(`Products in collection: ${report.products_total}`);
    log(`${report.dry_run ? "Would convert" : "Converted"} seller_id string -> ObjectId: ${report.seller_id_type_converted}`);
    log(`${report.dry_run ? "Would create" : "Created"} stores for existing sellers: ${report.stores_created}`);
    log(`${report.dry_run ? "Would backfill" : "Backfilled"} store_id on products: ${report.store_id_backfilled}`);
    log(`Stores index: ${report.index_action}`);
    log("\n--- Records needing MANUAL review (left untouched, ownership NOT guessed) ---");
    let any = false;
    for (const [k, v] of Object.entries(report.needs_manual_review)) {
        log(`${k}: ${v.length}`);
        if (v.length) {
            any = true;
            log(JSON.stringify(v, null, 2));
        }
    }
    if (!any) log("(none)");
    log("=============================================================\n");
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");

    if (!process.env.MONGO_URL) {
        console.error("MONGO_URL is not set - aborting.");
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 10000 });
    console.log(`Connected to MongoDB.${dryRun ? " (DRY RUN - no writes)" : ""}`);

    // Real collection names come from the Mongoose models themselves, so
    // they can never drift from what the application actually uses.
    const names = {
        products: require("../models/products").collection.name,
        users: require("../models/users").collection.name,
        stores: require("../models/store").collection.name,
    };

    const report = await runMigration(mongoose.connection.db, { dryRun, names });
    printReport(report);

    await mongoose.disconnect();
}

if (require.main === module) {
    main().catch((err) => {
        console.error("Migration failed:", err.message);
        process.exit(1);
    });
}

module.exports = { runMigration, printReport };
