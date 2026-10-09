const mongoose = require("mongoose");

const orders = require("../models/order");
const store = require("../models/store");
const { read_pagination } = require("../utils/pagination");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const STATUSES = ["new", "processing", "shipped", "delivered", "cancelled"];

const escape_regex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET /api/admin/orders
// Global, paginated list of EVERY order on the platform with its status and
// the store(s) it was placed with. super_admin only (route-level
// auth_super_admin).
//
// Optional query params (all validated, never passed to Mongo raw):
//   page, limit  -> strict pagination (utils/pagination.js)
//   status       -> one of new | processing | shipped | delivered | cancelled
//   store_id     -> only orders of that store (ObjectId)
//   search       -> order number or customer name (case-insensitive contains)
//
// An order's store is derived from products.seller_id (the seller's user id)
// matched with store.owner_id, the same ownership rule the seller endpoints use.
const list_all_orders = async (req, res) => {
    try {
        const pg = read_pagination(req, res, {
            defaultLimit: DEFAULT_LIMIT,
            maxLimit: MAX_LIMIT,
        });
        if (!pg) return;
        const { page, limit, skip } = pg;

        const filter = {};

        // ---- status -------------------------------------------------------
        if (req.query.status !== undefined && req.query.status !== "") {
            const status = req.query.status;
            if (typeof status !== "string" || !STATUSES.includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid status parameter",
                    data: [],
                });
            }
            filter.status = status;
        }

        // ---- store_id -----------------------------------------------------
        if (req.query.store_id !== undefined && req.query.store_id !== "") {
            const store_id = req.query.store_id;
            if (typeof store_id !== "string" || !mongoose.Types.ObjectId.isValid(store_id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid store_id parameter",
                    data: [],
                });
            }
            const found = await store.findById(store_id).select("owner_id").lean();
            if (!found) {
                // Unknown store -> empty result, not an error.
                return res.status(200).json({
                    success: true,
                    message: "Orders retrieved successfully",
                    data: [],
                    pagination: { page, limit, total: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: page > 1 },
                });
            }
            filter["products.seller_id"] = String(found.owner_id);
        }

        // ---- search -------------------------------------------------------
        if (req.query.search !== undefined && req.query.search !== "") {
            const search = req.query.search;
            if (typeof search !== "string" || search.trim().length > 100) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid search parameter",
                    data: [],
                });
            }
            const rx = new RegExp(escape_regex(search.trim()), "i");
            filter.$or = [{ orderNumber: rx }, { user_name: rx }];
        }

        const [all_orders, total] = await Promise.all([
            orders
                .find(filter)
                // Internal stock bookkeeping must never reach a client.
                .select("-stock_restored")
                .sort({ createdAt: -1, _id: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            orders.countDocuments(filter),
        ]);

        // ---- attach store info (one extra query for the whole page) ------
        const owner_ids = new Set();
        for (const o of all_orders) {
            for (const p of o.products || []) {
                if (p.seller_id && mongoose.Types.ObjectId.isValid(p.seller_id)) {
                    owner_ids.add(String(p.seller_id));
                }
            }
        }

        const stores_by_owner = new Map();
        if (owner_ids.size > 0) {
            const found_stores = await store
                .find({ owner_id: { $in: [...owner_ids] } })
                .select("_id store_name slug owner_id")
                .lean();
            for (const s of found_stores) {
                stores_by_owner.set(String(s.owner_id), {
                    _id: s._id,
                    store_name: s.store_name,
                    slug: s.slug,
                });
            }
        }

        const data = all_orders.map((o) => {
            const seen = new Set();
            const order_stores = [];
            for (const p of o.products || []) {
                const sid = p.seller_id ? String(p.seller_id) : null;
                if (!sid || seen.has(sid)) continue;
                seen.add(sid);
                // A seller without a store document (legacy) is still listed
                // so the order never appears "store-less" by mistake.
                order_stores.push(
                    stores_by_owner.get(sid) || { _id: null, store_name: null, slug: null, seller_id: sid }
                );
            }
            return { ...o, stores: order_stores };
        });

        const totalPages = Math.ceil(total / limit);

        return res.status(200).json({
            success: true,
            message: "Orders retrieved successfully",
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1,
            },
        });
    } catch (e) {
        console.error("list_all_orders (admin) error:", e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

module.exports = { list_all_orders };