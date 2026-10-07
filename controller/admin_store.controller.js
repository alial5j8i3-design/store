const mongoose = require("mongoose");

const store = require("../models/store");
const cache = require("../utils/cache");
const { read_pagination } = require("../utils/pagination");

// Allowlisting + validation of writable store fields lives in
// utils/store_fields.js (shared with the seller controller).
const { pick_store_fields } = require("../utils/store_fields");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// GET /api/admin/stores
// Global, paginated list of every store on the platform. super_admin
// only (route-level auth_super_admin).
const list_stores = async (req, res) => {
    try {
        // Strict parsing (utils/pagination.js): malformed / out-of-range
        // page or limit -> 400 instead of a database error or a silent change.
        const pg = read_pagination(req, res, {
            defaultLimit: DEFAULT_LIMIT,
            maxLimit: MAX_LIMIT,
        });
        if (!pg) return;
        const { page, limit, skip } = pg;

        const [stores, totalStores] = await Promise.all([
            store
                .find()
                .populate("owner_id", "name email phone_number")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            store.countDocuments(),
        ]);

        const totalPages = Math.ceil(totalStores / limit);

        return res.status(200).json({
            success: true,
            message: "stores fetched successfully",
            data: stores,
            pagination: {
                page,
                limit,
                totalStores,
                totalPages,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1,
            },
        });
    } catch (e) {
        console.error("list_stores error:", e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

// GET /api/admin/store/:store_id
const get_store = async (req, res) => {
    try {
        const { store_id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(store_id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid store id",
                data: null,
            });
        }

        const found_store = await store
            .findById(store_id)
            .populate("owner_id", "name email phone_number")
            .lean();

        if (!found_store) {
            return res.status(404).json({
                success: false,
                message: "Store not found",
                data: null,
            });
        }

        return res.status(200).json({
            success: true,
            message: "store fetched successfully",
            data: found_store,
        });
    } catch (e) {
        console.error("get_store (admin) error:", e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

// PUT /api/admin/store/:store_id
// super_admin can edit any seller's store content (moderation /
// support use case), but still can never change *ownership* through
// this endpoint - owner_id is not an updatable field (see utils/store_fields.js).
const update_store = async (req, res) => {
    try {
        const { store_id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(store_id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid store id",
                data: null,
            });
        }

        const { data, error } = pick_store_fields(req.body);

        if (error) {
            return res.status(400).json({ success: false, message: error, data: null });
        }

        if (Object.keys(data).length === 0) {
            return res.status(400).json({
                success: false,
                message: "At least one updatable field is required",
                data: null,
            });
        }

        const updated_store = await store.findByIdAndUpdate(store_id, data, {
            new: true,
            runValidators: true,
        });

        if (!updated_store) {
            return res.status(404).json({
                success: false,
                message: "Store not found",
                data: null,
            });
        }

        await cache.del(`store:owner=${updated_store.owner_id}`);
        // Drop the cached public pages of this store (60s cache, see
        // public_store.controller.js). Falls back to every public store page
        // if the document has no slug yet (legacy stores).
        await cache.delByPrefix(updated_store.slug ? `store:public:${updated_store.slug}:` : "store:public:");
        // Product listings embed this store's public phone / WhatsApp
        // (get_products), so a store edit must also move the shared epoch.
        await cache.delByPrefix("products");

        // Audit trail: who edited which store (super_admin edits other
        // sellers' content, so this should be traceable).
        console.info(
            `[admin] store ${updated_store._id} updated by ${req.user._id}: ${Object.keys(data).join(", ")}`
        );

        return res.status(200).json({
            success: true,
            message: "store updated successfully",
            data: updated_store,
        });
    } catch (e) {
        console.error("update_store (admin) error:", e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = { list_stores, get_store, update_store };