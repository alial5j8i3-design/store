const express = require("express");
const { createRateLimiter, authenticatedUserKey } = require("../utils/rate_limit_store");

const router = express.Router();

const order = require("../controller/order.controller");

const auth = require("../middleware/auth")
const orderLimiter = createRateLimiter({
    prefix: "order-user",
    windowMs: 10 * 60 * 1000, // 10 minutes
    limit: 15,                 // 15 requests
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: authenticatedUserKey,


    message: {
        success: false,
        message: "Too many order attempts. Please try again later."
    }
});
router.post("/api/order", auth, orderLimiter, order)

module.exports = router
