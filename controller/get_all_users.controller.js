const users = require("../models/users");

// Route is protected by auth_super_admin (routes/get_all_users.router.js).

// Explicit allowlist of the fields returned. Before, the query only
// excluded `password`, so any sensitive field added to the users model
// later (reset token, verification code, ...) would have been sent to the
// client automatically.
const SAFE_FIELDS = "_id name email role phone_number GPS_URL whatsApp_number createdAt updatedAt";

// Optional pagination (default 200 users, hard cap 500). Parsing is strict
// (utils/pagination.js): a malformed / out-of-range page or limit is answered
// with 400. `data` keeps its old shape (array of users) and the paging info is
// a separate top-level `pagination` object.
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const { read_pagination } = require("../utils/pagination");

const get_all_users = async (req, res) => {
    try {
        const pg = read_pagination(req, res, { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT });
        if (!pg) return;
        const { page, limit, skip } = pg;

        const [all_users, total] = await Promise.all([
            users
                .find()
                .select(SAFE_FIELDS)
                .sort({ _id: 1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            users.countDocuments(),
        ]);

        const totalPages = Math.ceil(total / limit);

        return res.status(200).json({
            success: true,
            message: "users retrieved successfully",
            data: all_users,
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
        console.error("Get all users error:", e.message);
        // Do not leak internal error details to the client
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = get_all_users;