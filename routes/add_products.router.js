const express = require("express");
const { createRateLimiter } = require("../utils/rate_limit_store");

const router = express.Router();

const add_product = require("../controller/add_products.controller");

const auth_seller = require("../middleware/auth_seller");

// Limits how many products one seller can add in a short time.
// It runs after auth_seller, so it is keyed by seller id (not IP).
const add_product_limiter = createRateLimiter({ prefix: "add-product",
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 30, // max 30 add-product requests per seller per window
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user._id),
    message: {
        success: false,
        message: "Too many products added, please try again later",
        data: []
    }
});

router.post("/api/seller/add_product", auth_seller, add_product_limiter, add_product);

module.exports = router;
