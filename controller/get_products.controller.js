const products = require("../models/products");
const users = require("../models/users");
const store = require("../models/store");
const cache = require("../utils/cache");
const { read_pagination } = require("../utils/pagination");

// GET /api/get_products - the PUBLIC product catalog.
//
// Public contract (consumed by public/js/app.js productCard, product.html,
// products.html, index.html):
//   - product fields: name, description, price, discount, final_price,
//     images, section {_id,name}, quantity, createdAt
//   - seller / store info derived server-side:
//       seller_name       -> seller's display name
//       store_slug        -> link target for /store/:slug
//       seller_phone      -> the STORE phone (store_phone)
//       seller_whatsapp   -> the STORE WhatsApp (store_whatsApp_number)
//   - NEVER returned: seller_id, store_id, reviews, or any personal contact
//     field of the seller's user account (phone_number, whatsApp_number,
//     email, ...). seller_id / store_id are only read to look the seller and
//     store up; they are dropped before the response is built.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const PRODUCT_FIELDS =
    "name description price discount final_price images section quantity createdAt seller_id store_id";

const get_products = async (req, res) => {
    try {
        // Only page / limit are read from the query string; every other
        // query parameter is ignored (no client-controlled filters).
        const pg = read_pagination(req, res, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });
        if (!pg) return;
        const { page, limit, skip } = pg;

        const epoch = cache.getProductsEpoch ? await cache.getProductsEpoch() : 0;
        const cacheKey = `products:v${epoch}:page=${page}:limit=${limit}`;

        const cached = await cache.get(cacheKey);
        if (cached) {
            return res.status(200).json({
                success: true,
                message: "Get products successfully",
                data: cached.data,
                pagination: cached.pagination,
            });
        }

        // Same visibility rule as the public store page: in stock and not
        // deactivated (a missing is_active on a legacy document is active).
        const filter = { quantity: { $gt: 0 }, is_active: { $ne: false } };

        const [rows, totalProducts] = await Promise.all([
            products
                .find(filter)
                .select(PRODUCT_FIELDS)
                .populate("section", "name")
                .sort({ createdAt: -1, _id: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            products.countDocuments(filter),
        ]);

        const seller_ids = [...new Set(rows.map((p) => p.seller_id).filter(Boolean).map(String))];
        const store_ids = [...new Set(rows.map((p) => p.store_id).filter(Boolean).map(String))];

        const [seller_rows, store_rows] = await Promise.all([
            seller_ids.length
                ? users.find({ _id: { $in: seller_ids } }).select("name").lean()
                : [],
            store_ids.length
                ? store
                    .find({ _id: { $in: store_ids } })
                    .select("slug store_phone store_whatsApp_number")
                    .lean()
                : [],
        ]);

        const seller_by_id = new Map(seller_rows.map((u) => [String(u._id), u]));
        const store_by_id = new Map(store_rows.map((s) => [String(s._id), s]));

        const data = rows.map(({ seller_id, store_id, reviews, ...product }) => {
            const seller = seller_by_id.get(String(seller_id)) || {};
            const owner_store = store_by_id.get(String(store_id)) || {};
            return {
                ...product,
                seller_name: seller.name || "",
                store_slug: owner_store.slug || "",
                seller_phone: owner_store.store_phone || "",
                seller_whatsapp: owner_store.store_whatsApp_number || "",
            };
        });

        const totalPages = Math.ceil(totalProducts / limit);
        const pagination = {
            page,
            limit,
            totalProducts,
            totalPages,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1,
        };

        // An empty page past the first is not cached (one key per arbitrary ?page=).
        if (data.length > 0 || page === 1) {
            await cache.set(cacheKey, { data, pagination }, cache.PRODUCTS_CACHE_TTL_SECONDS || 60);
        }

        return res.status(200).json({
            success: true,
            message: data.length ? "Get products successfully" : "No products found",
            data,
            pagination,
        });
    } catch (e) {
        console.log(e.message);

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

module.exports = get_products;