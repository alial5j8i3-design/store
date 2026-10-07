require("dotenv").config();

const AI_API_BASE_URL =
    process.env.AI_API_BASE_URL ||
    "https://api.groq.com/openai/v1/chat/completions";

const AI_API_KEY = process.env.AI_API_KEY || null;


const AI_MODEL = process.env.AI_MODEL || "openai/gpt-oss-120b";


const AI_REASONING_EFFORT = process.env.AI_REASONING_EFFORT || "low";

const AI_REASONING_FORMAT = process.env.AI_REASONING_FORMAT || "hidden";

const config = {
    AI_API_BASE_URL,
    AI_API_KEY,
    AI_MODEL,
    AI_REASONING_EFFORT,
    AI_REASONING_FORMAT,


    AI_TEMPERATURE: Number(process.env.AI_TEMPERATURE ?? 0.3),

    AI_MAX_OUTPUT_TOKENS: Number(process.env.AI_MAX_OUTPUT_TOKENS ?? 2000),

    AI_REQUEST_TIMEOUT_MS: Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 60000),

    AI_MAX_RETRIES: Number(process.env.AI_MAX_RETRIES ?? 4),


    AI_MAX_TOOL_ROUNDS: Number(process.env.AI_MAX_TOOL_ROUNDS ?? 6),

    AI_MAX_SEARCH_RESULTS: Math.min(
        Number(process.env.AI_MAX_SEARCH_RESULTS ?? 12),
        20
    ),

    MAX_USER_MESSAGE_LENGTH: 800,
    MAX_HISTORY_MESSAGES: 16,
    MAX_HISTORY_MESSAGE_LENGTH: 600,

    STORE_NAME: process.env.STORE_NAME || "store",
    STORE_URL: process.env.STORE_URL || "http://localhost:3000",

    RATE_LIMIT_WINDOW_MS: Number(process.env.AI_RATE_LIMIT_WINDOW_MS ?? 60000),
    RATE_LIMIT_MAX_REQUESTS: Number(process.env.AI_RATE_LIMIT_MAX ?? 20),

    // 0 disables the cap for local development. Production should set a
    // positive value so public traffic cannot exhaust provider spend.
    AI_DAILY_BUDGET_REQUESTS: Math.max(Number(process.env.AI_DAILY_BUDGET_REQUESTS ?? 0), 0),

    AI_DEBUG: String(process.env.AI_DEBUG || "") === "1",
};

if (!config.AI_API_KEY) {
    console.warn(
        "[ai_assistant.config] Warning: AI_API_KEY is not present in the environment. " +
        "The smart assistant will operate in fallback mode only."
    );
}

module.exports = config;