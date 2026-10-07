const orders = require("../models/order");

// Optional pagination (default 100 orders, hard cap 200 per page). Parsing is
// strict (utils/pagination.js): a malformed / out-of-range page or limit is
// answered with 400 instead of being silently changed. `data` keeps its old
// shape (an array of orders); the paging info is a separate top-level
// `pagination` object.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const { read_pagination } = require("../utils/pagination");

// Buyer view: drop internal fields (same idea as buyerOrderView in
// order.controller.js). `stock_restored` is excluded in the query itself;
// `seller_id` is removed from each product item here.
const buyer_order_view = (order) => ({
    ...order,
    products: (order.products || []).map(({ seller_id, ...item }) => item),
});

const get_user_orders = async (req, res) => {
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
        const filter = { user_id: String(user._id) };

        const [all_orders, total] = await Promise.all([
            orders
                .find(filter)
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
            data: all_orders.map(buyer_order_view),
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

module.exports = get_user_orders;