const express = require("express");

const { createRateLimiter } = require("../utils/rate_limit_store");
const { aiDailyBudgetGuard } = require("../utils/ai_daily_budget");

const ai_assistant = require("../controller/ai_assistant.controller");
const config = require("../config/ai_assistant.config");

const router = express.Router();

const too_many_requests = {
    success: false,
    message: "Too many requests in a short period. Please try again in a little while.",
    data: [],
};


const aiAssistantRateLimiter = createRateLimiter({
    prefix: "ai-window",
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    limit: config.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: too_many_requests,
});


const aiAssistantHourlyLimiter = createRateLimiter({
    prefix: "ai-hour",
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: Number(process.env.AI_RATE_LIMIT_HOURLY ?? 100),
    standardHeaders: true,
    legacyHeaders: false,
    message: too_many_requests,
});

router.post(
    "/api/ai_assistant",
    aiAssistantRateLimiter,
    aiAssistantHourlyLimiter,
    aiDailyBudgetGuard,
    ai_assistant
);

module.exports = router;
