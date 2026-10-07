const orders = require("../models/order");

// Optional pagination (default 100 orders, hard cap 200 per page). Parsing is
// strict (utils/pagination.js): a malformed / out-of-range page or limit is
// answered with 400 instead of being silently changed. `data` keeps its old
// shape (an array of orders); the paging info is a separate top-level
// `pagination` object.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const { read_pagination } = require("../utils/pagination");

// Seller-side order list. Ownership is the same rule the seller's status /
// delete endpoints use: an order belongs to the seller when one of its line
// items carries that seller's id (products.seller_id, served by the
// {products.seller_id, createdAt} index). The seller id comes ONLY from the
// authenticated user (req.user._id, set by middleware/auth_seller.js); query
// string / body values are never read.
const get_all_orders = async (req, res) => {
    try {

        const user = req.user;

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
                data: []
            });
        }

        const pg = read_pagination(req, res, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });
        if (!pg) return;
        const { page, limit, skip } = pg;
        // NOT { user_id }: that would return the orders the seller placed as
        // a customer instead of the orders received for their own products.
        const filter = { "products.seller_id": String(user._id) };

        const [all_orders, total] = await Promise.all([
            orders
                .find(filter)
                // Internal stock bookkeeping must never reach a client
                // (see utils/order_stock.js / update_status_of_order).
                .select("-stock_restored")
                .sort({ createdAt: -1, _id: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            orders.countDocuments(filter),
        ]);

        const totalPages = Math.ceil(total / limit);

        return res.status(200).json({
            success: true,
            message: "Orders retrieved successfully",
            data: all_orders,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1,
            },
        });
    }
    catch (e) {
        console.log(e.message);

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};

module.exports = get_all_orders;