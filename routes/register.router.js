const express = require("express");

const { createRateLimiter } = require("../utils/rate_limit_store");

const router = express.Router();

const register_controller = require("../controller/register.controller");

// Registration attempts allowed per IP per window. The built-in default stays
// at 4 so behaviour does not change unless an operator opts in; set
// REGISTER_RATE_LIMIT_MAX (e.g. 10) in the environment to raise it.
const DEFAULT_REGISTER_RATE_LIMIT_MAX = 4;

function registerRateLimitMax() {
    const raw = process.env.REGISTER_RATE_LIMIT_MAX;
    if (raw === undefined || String(raw).trim() === "") return DEFAULT_REGISTER_RATE_LIMIT_MAX;
    const parsed = Number(raw);
    // Anything that is not a positive whole number falls back to the default
    // rather than silently disabling or breaking the limiter.
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REGISTER_RATE_LIMIT_MAX;
}

const logInLimiter = createRateLimiter({ prefix: "register",
    windowMs: 30 * 60 * 1000, // 30 minutes
    limit: registerRateLimitMax(),
    // Every attempt counts (including failed ones): the bcrypt hash is computed
    // before the duplicate-email check, so failed attempts are not free.
    skipFailedRequests: false,
    standardHeaders: "draft-8",
    legacyHeaders: false,

    message: {
        success: false,
        message: "Too many registration attempts. Please try again later."
    }
});

// FIX: logInLimiter was created above but never passed to this route,
// so /api/auth/register had NO rate limiting at all - unlike every
// other sensitive auth endpoint (log_in, register_super_admin,
// add_problem, order, post_review), which all wire their limiter into
// the route. That left registration wide open to abuse (mass account
// creation, bcrypt-hashing DoS, email-enumeration brute forcing).
router.post("/api/auth/register",logInLimiter,register_controller)

module.exports = router