const redis = require("../config/redis");
const config = require("../config/ai_assistant.config");

function dayKey(date = new Date()) {
    return `ai_daily_budget:${date.toISOString().slice(0, 10)}`;
}

async function consumeDailyBudget(limit = config.AI_DAILY_BUDGET_REQUESTS) {
    if (!Number.isFinite(limit) || limit <= 0) return { allowed: true };

    if (!redis.isRedisConfigured() || !redis.isRedisReady()) {
        console.error("[ai_daily_budget] Redis is unavailable; skipping provider call to protect the daily AI budget.");
        return { allowed: false, unavailable: true };
    }

    try {
        const key = dayKey();
        const count = await redis.client.incr(key);
        if (count === 1) await redis.client.expire(key, 2 * 24 * 60 * 60);
        return { allowed: count <= limit, count };
    } catch (error) {
        console.error("[ai_daily_budget] Redis counter failed; skipping provider call:", error.message);
        return { allowed: false, unavailable: true };
    }
}

async function aiDailyBudgetGuard(req, res, next) {
    // There is no provider spend in fallback-only mode.
    if (!config.AI_API_KEY) return next();
    const result = await consumeDailyBudget();
    if (!result.allowed) req.aiDailyBudgetExceeded = true;
    next();
}

module.exports = { dayKey, consumeDailyBudget, aiDailyBudgetGuard };
