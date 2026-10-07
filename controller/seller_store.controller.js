require("dotenv").config();

const store = require("../models/store");
const cache = require("../utils/cache");
const socket_events = require("../utils/socket_events");

// Allowlisting + validation of writable store fields lives in
// utils/store_fields.js (shared with the admin controller).
const { pick_store_fields } = require("../utils/store_fields");

function slug_base(name) {
    const ascii = String(name || "store")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return (ascii || "store").slice(0, 90).replace(/-+$/g, "") || "store";
}

// A slug is a public label, not a credential. The small random suffix only
// prevents name collisions; it grants no access and contains no secret.
async function create_unique_slug(name) {
    const base = slug_base(name);
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const suffix = Math.random().toString(36).slice(2, 8);
        const slug = `${base}-${suffix}`;
        const exists = await store.findOne({ slug }).select("_id").lean();
        if (!exists) return slug;
    }
    throw new Error("Could not allocate a unique public store slug");
}

function store_cache_key(owner_id) {
    return `store:owner=${owner_id}`;
}

// GET /api/seller/store
// Returns the authenticated seller's own store, and only their own -
// ownership comes from req.user (set by auth_seller), never from a
// query param or body.
const get_my_store = async (req, res) => {
    try {
        const owner_id = req.user._id;

        const cacheKey = store_cache_key(owner_id);
        const cached = await cache.get(cacheKey);
        if (cached) {
            return res.status(200).json({
                success: true,
                message: "store fetched successfully",
                data: cached,
            });
        }

        const my_store = await store.findOne({ owner_id }).lean();

        if (!my_store) {
            return res.status(404).json({
                success: false,
                message: "You don't have a store yet. Create one first.",
                data: null,
            });
        }

        await cache.set(cacheKey, my_store);

        return res.status(200).json({
            success: true,
            message: "store fetched successfully",
            data: my_store,
        });
    } catch (e) {
        console.error("get_my_store error:", e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

// POST /api/seller/store
// Creates the authenticated seller's store. A seller can have exactly
// one store (enforced by the unique index on owner_id AND by this
// explicit pre-check, which lets us return a clean 409 instead of a raw
// duplicate-key error).
const create_my_store = async (req, res) => {
    try {
        const owner_id = req.user._id;

        const existing = await store.findOne({ owner_id }).select("_id").lean();
        if (existing) {
            return res.status(409).json({
                success: false,
                message: "You already have a store. Use update instead.",
                data: null,
            });
        }

        const { data, error } = pick_store_fields(req.body);

        if (error) {
            return res.status(400).json({ success: false, message: error, data: null });
        }

        if (!data.store_name) {
            return res.status(400).json({
                success: false,
                message: "store_name is required",
                data: null,
            });
        }

        const slug = await create_unique_slug(data.store_name);
        const new_store = new store({
            ...data,
            owner_id,
            slug,
        });

        try {
            await new_store.save();
        } catch (saveError) {
            // Race condition guard: two concurrent creates for the same
            // owner_id. The unique index on owner_id is the real
            // safety net here; this just turns the resulting duplicate
            // key error into a clean 409 instead of a 500.
            if (saveError.code === 11000) {
                return res.status(409).json({
                    success: false,
                    message: "You already have a store. Use update instead.",
                    data: null,
                });
            }
            throw saveError;
        }

        await cache.del(store_cache_key(owner_id));

        return res.status(201).json({
            success: true,
            message: "store created successfully",
            data: new_store,
        });
    } catch (e) {
        console.error("create_my_store error:", e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

// PUT /api/seller/store
// Updates ONLY the authenticated seller's own store.
//
// FIX (Phase 1): this replaces the old `store.findOneAndUpdate({}, ...,
// { upsert: true })` in controller/store.controller.js, which matched
// (and overwrote) whatever single store document existed, for anyone
// who could reach the route. The query here is
// `{ owner_id: req.user._id }` - a seller can never match, and
// therefore never touch, another seller's store, because the filter
// itself makes that impossible regardless of what the client sends.
const update_my_store = async (req, res) => {
    try {
        const owner_id = req.user._id;

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

        const updated_store = await store.findOneAndUpdate(
            { owner_id },
            data,
            { new: true, runValidators: true },
        );

        if (!updated_store) {
            return res.status(404).json({
                success: false,
                message: "You don't have a store yet. Create one first.",
                data: null,
            });
        }

        await cache.del(store_cache_key(owner_id));
        // Drop the cached public pages of this store (60s cache, see
        // public_store.controller.js). Falls back to every public store page
        // if the document has no slug yet (legacy stores).
        await cache.delByPrefix(updated_store.slug ? `store:public:${updated_store.slug}:` : "store:public:");
        // Product listings embed this store's public phone / WhatsApp
        // (get_products), so a store edit must also move the shared epoch.
        await cache.delByPrefix("products");

        // The full store document is not broadcast; clients re-fetch it.
        socket_events.emit_to(
            req.io,
            socket_events.CATALOG_ROOM,
            "store_updated",
            socket_events.store_payload(updated_store)
        );

        return res.status(200).json({
            success: true,
            message: "store updated successfully",
            data: updated_store,
        });
    } catch (e) {
        console.error("update_my_store error:", e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = { get_my_store, create_my_store, update_my_store };