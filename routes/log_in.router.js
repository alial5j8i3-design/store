const express = require("express");
const { createRateLimiter } = require("../utils/rate_limit_store");
const router = express.Router();

const log_in_controller = require("../controller/log_in.controller");
const logInLimiter = createRateLimiter({ prefix: "login",
    windowMs: 30 * 60 * 1000, // 30 minutes
    limit: 5,                 // 5 FAILED attempts per IP
    // Successful logins no longer use up the allowance: before, every
    // successful login counted too, so users behind the same IP (family,
    // office, mobile carrier NAT) were locked out after 4 logins in total.
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,

    message: {
        success: false,
        message: "Too many login attempts. Please try again later."
    }
});
router.post("/api/auth/log_in",logInLimiter,log_in_controller)

module.exports = router
