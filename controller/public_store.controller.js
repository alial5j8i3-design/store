const store = require("../models/store");
const products = require("../models/products");
const users = require("../models/users");
const cache = require("../utils/cache");
const { read_pagination } = require("../utils/pagination");

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Public store pages are cached for 60 seconds. Key:
//   store:public:{slug}:v{epoch}:{page}:{limit}
// - `epoch` is the shared products cache epoch (CACHE-01). Every product
//   change, new/deleted review and seller role change already bumps it
//   (cache.delByPrefix("products")), so those writes invalidate this cache too.
// - Store edits call cache.delByPrefix(`store:public:${slug}:`) (see
//   seller_store / admin_store controllers) to drop the pages of that store.
// Only successful (200) responses are cached; 400/404 are never stored.
const PUBLIC_STORE_CACHE_TTL_SECONDS = 60;

const RATING_AGGREGATE_MAX_TIME_MS = 5000;
const PUBLIC_STORE_DEFAULT_LIMIT = 12;
const PUBLIC_STORE_MAX_LIMIT = 50;

// GET /api/stores/:slug
// This endpoint is intentionally public and returns an explicit allowlist.
// It never serializes the owner document or the store document directly.
const get_public_store = async (req, res) => {
    try {
        const slug = typeof req.params.slug === "string" ? req.params.slug.toLowerCase() : "";
        if (!SLUG_PATTERN.test(slug) || slug.length > 120) {
            return res.status(400).json({ success: false, message: "Invalid store slug", data: null });
        }

        const pg = read_pagination(
            req,
            res,
            { defaultLimit: PUBLIC_STORE_DEFAULT_LIMIT, maxLimit: PUBLIC_STORE_MAX_LIMIT },
            { data: null },
        );
        if (!pg) return;
        const { page, limit, skip } = pg;
        const epoch = cache.getProductsEpoch ? await cache.getProductsEpoch() : 0;
        const cacheKey = `store:public:${slug}:v${epoch}:${page}:${limit}`;
        const cached = await cache.get(cacheKey);
        if (cached) {
            return res.status(200).json({
                success: true,
                message: "Public store fetched successfully",
                data: cached.data,
                pagination: cached.pagination,
            });
        }

        const foundStore = await store.findOne({ slug })
            .select("_id owner_id slug store_name store_description store_phone store_whatsApp_number store_GPS")
            .lean();
        if (!foundStore) {
            return res.status(404).json({ success: false, message: "Store not found", data: null });
        }

        // The owner is only queried to derive the public verification label;
        // no user fields (especially password) are selected or returned.
        const owner = await users.findById(foundStore.owner_id).select("role").lean();
        const filter = { store_id: foundStore._id, seller_id: foundStore.owner_id, quantity: { $gt: 0 }, is_active: { $ne: false } };
        // Rating summary: one $group document comes back (no review documents
        // are loaded into Node). It still walks the embedded reviews of this
        // store's products, so it carries a query-level time limit instead of
        // relying only on the socket timeout.
        const ratingAggregate = products.aggregate([
            { $match: filter },
            { $unwind: "$reviews" },
            { $match: { "reviews.rating": { $gte: 1, $lte: 5 } } },
            { $group: { _id: null, reviewCount: { $sum: 1 }, rating: { $avg: "$reviews.rating" } } },
        ]);
        if (ratingAggregate && typeof ratingAggregate.option === "function") {
            ratingAggregate.option({ maxTimeMS: RATING_AGGREGATE_MAX_TIME_MS });
        }

        const [activeProducts, ratingSummary, totalProducts] = await Promise.all([
            products.find(filter)
                // `reviews` is deliberately NOT selected: the embedded array is
                // unbounded and was loaded for up to 50 products only to be
                // discarded below. The rating summary comes from the aggregate.
                .select("name description price discount final_price images section quantity createdAt")
                .populate("section", "name")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            ratingAggregate,
            products.countDocuments(filter),
        ]);

        const reviewCount = ratingSummary[0]?.reviewCount || 0;
        const averageRating = ratingSummary[0]?.rating;

        const publicProducts = activeProducts.map(({ reviews, ...product }) => product);
        const totalPages = Math.ceil(totalProducts / limit);
        const data = {
            store: {
                slug: foundStore.slug,
                name: foundStore.store_name,
                description: foundStore.store_description || "",
                phone: foundStore.store_phone || "",
                whatsapp: foundStore.store_whatsApp_number || "",
                location: foundStore.store_GPS || "",
                verification_status: owner && owner.role === "seller" ? "verified" : "unverified",
                rating: reviewCount ? Number(Number(averageRating).toFixed(1)) : null,
                review_count: reviewCount,
            },
            products: publicProducts,
        };
        const pagination = {
            page, limit, totalProducts, totalPages,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1,
        };

        // Empty pages past the first are not cached: they would let a client
        // create one cache key per arbitrary ?page= value.
        if (publicProducts.length > 0 || page === 1) {
            await cache.set(cacheKey, { data, pagination }, PUBLIC_STORE_CACHE_TTL_SECONDS);
        }

        return res.status(200).json({
            success: true,
            message: "Public store fetched successfully",
            data,
            pagination,
        });
    } catch (error) {
        console.error("get_public_store error:", error.message);
        return res.status(500).json({ success: false, message: "Internal server error", data: null });
    }
};

module.exports = { get_public_store };