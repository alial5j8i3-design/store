const express = require("express");
const { createRateLimiter } = require("../utils/rate_limit_store");

const router = express.Router();

const add_seller = require("../controller/add_seller.controller");

const auth = require("../middleware/auth");

const request_limiter = createRateLimiter({ prefix: "seller-promotion",
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: 5, // max 5 requests per user per hour
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user._id),
    message: {
        success: false,
        message: "Too many requests, please try again later"
    }
});

router.put("/api/request_seller_promotion", auth, request_limiter, add_seller);

module.exports = router;
