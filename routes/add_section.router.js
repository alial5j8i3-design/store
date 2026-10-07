const express = require("express");
const { createRateLimiter } = require("../utils/rate_limit_store");

const router = express.Router();

const add_section = require("../controller/add_section.controller");

const auth_seller = require("../middleware/auth_seller");

// Limits how many categories one seller can create in a short time.
// Runs after auth_seller, so it is keyed by seller id (not IP).
const add_section_limiter = createRateLimiter({ prefix: "add-section",
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: 10, // max 10 add-section requests per seller per hour
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user._id),
    message: {
        success: false,
        message: "طلبات كثيرة لإضافة أقسام، حاول مرة أخرى لاحقاً",
        data: [],
    },
});

// Sellers add categories. There is intentionally NO update/delete route.
router.post("/api/seller/add_section", auth_seller, add_section_limiter, add_section);

module.exports = router;
