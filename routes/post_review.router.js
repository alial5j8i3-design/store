const express = require("express");

const router = express.Router();
const { createRateLimiter, authenticatedUserKey } = require("../utils/rate_limit_store");

const post_review = require("../controller/post_review.controller");

const auth = require("../middleware/auth")
const postReviewLimiter = createRateLimiter({
    prefix: "review-user",
    windowMs: 10 * 60 * 1000, // 10 minutes
    limit: 10,                 // 10 requests
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: authenticatedUserKey,

    message: {
        success: false,
        message: "Too many reviews submitted. Please try again later."
    }
});
router.post("/api/post_review",auth,postReviewLimiter,post_review)

module.exports = router
