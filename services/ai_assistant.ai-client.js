const config = require("../config/ai_assistant.config");
const { TOOL_DEFINITIONS, executeTool } = require("./ai_assistant.tools");

const MAX_CARDS_PER_REPLY = 12;

// Tool calls are chosen by the model, whose input includes untrusted product
// and store text, so their number is bounded: a single provider response can
// not make the server run an unbounded number of database searches.
const MAX_TOOL_CALLS_PER_ROUND = 4;

const MAX_EMPTY_RECOVERIES = 2;
const MAX_QUEUE_LENGTH = 20;
const CONVERSATION_DEADLINE_MS = 25000;
const MAX_RETRIES = Math.min(Math.max(Number(config.AI_MAX_RETRIES) || 1, 1), 2);
const REQUEST_TIMEOUT_MS = Math.min(Math.max(Number(config.AI_REQUEST_TIMEOUT_MS) || 8000, 1000), 8000);


let aiRequestRunning = false;
const aiWaitingQueue = [];

function runAIRequest(task, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("AI conversation timed out"));
            return;
        }
        if (aiWaitingQueue.length >= MAX_QUEUE_LENGTH) {
            reject(new Error("AI assistant is busy; please try again shortly"));
            return;
        }
        const item = { task, resolve, reject, signal };
        const cancelQueuedTask = () => {
            const index = aiWaitingQueue.indexOf(item);
            if (index !== -1) aiWaitingQueue.splice(index, 1);
            reject(new Error("AI conversation timed out"));
        };
        signal?.addEventListener("abort", cancelQueuedTask, { once: true });
        item.cleanup = () => signal?.removeEventListener("abort", cancelQueuedTask);
        aiWaitingQueue.push(item);
        processAIQueue();
    });
}

function remainingTime(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("AI conversation timed out");
    return remaining;
}

function withDeadline(promise, deadline, controller) {
    const timeout = setTimeout(() => controller.abort(), remainingTime(deadline));
    return promise.finally(() => clearTimeout(timeout));
}

async function processAIQueue() {
    if (aiRequestRunning) return;

    const item = aiWaitingQueue.shift();
    if (!item) return;

    aiRequestRunning = true;
    try {
        if (item.signal?.aborted) throw new Error("AI conversation timed out");
        const result = await item.task();
        item.cleanup?.();
        item.resolve(result);
    } catch (error) {
        item.cleanup?.();
        item.reject(error);
    } finally {
        aiRequestRunning = false;
        setTimeout(processAIQueue, 100);
    }
}

function sleep(ms, deadline, signal) {
    const delay = Math.min(ms, remainingTime(deadline));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, delay);
        function done() {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }
        function onAbort() {
            clearTimeout(timer);
            reject(new Error("AI conversation timed out"));
        }
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function toAsciiHeaderValue(value, fallback) {
    const cleaned = String(value || "").replace(/[^\x20-\x7E]/g, "").trim();
    return cleaned || fallback;
}

function getRetryDelay(errorText, attempt) {
    const match = String(errorText || "").match(/try again in\s+([\d.]+)s/i);

    if (match) {
        const seconds = parseFloat(match[1]);
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.min((seconds + 1) * 1000, 30000);
        }
    }

    const delays = [2000, 5000, 10000, 20000];
    return delays[Math.min(attempt, delays.length - 1)];
}


function isReasoningModel(modelName) {
    return /gpt-oss/i.test(String(modelName || ""));
}


function stripThinkTags(text) {
    return String(text || "")
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<\/?think>/gi, "")
        .trim();
}

function extractText(message) {
    if (!message) return "";

    const raw = message.content;

    if (typeof raw === "string") return stripThinkTags(raw);

    if (Array.isArray(raw)) {
        return stripThinkTags(
            raw
                .map(part => (typeof part === "string" ? part : part?.text || ""))
                .join(" ")
        );
    }

    return "";
}


function sanitizeAssistantMessage(message) {
    const clean = {
        role: "assistant",
        content: typeof message.content === "string" ? message.content : "",
    };

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        clean.tool_calls = message.tool_calls.map(call => ({
            id: call.id,
            type: "function",
            function: {
                name: call.function?.name,
                arguments: call.function?.arguments || "{}",
            },
        }));
    }

    return clean;
}


async function callAIOnce(messages, { withTools = true, deadline, signal } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        remainingTime(deadline);
        const controller = new AbortController();
        const abortRequest = () => controller.abort();
        signal?.addEventListener("abort", abortRequest, { once: true });
        const timeout = setTimeout(
            () => controller.abort(),
            Math.min(REQUEST_TIMEOUT_MS, remainingTime(deadline))
        );

        try {
            const payload = {
                model: config.AI_MODEL,
                messages,
                temperature: config.AI_TEMPERATURE,
                max_tokens: config.AI_MAX_OUTPUT_TOKENS,
            };

            if (withTools) {
                payload.tools = TOOL_DEFINITIONS;
                payload.tool_choice = "auto";
            }


            if (isReasoningModel(config.AI_MODEL)) {
                // gpt-oss on Groq: control effort and hide the reasoning text
                // with include_reasoning (reasoning_format is for Qwen/DeepSeek).
                // Reasoning tokens count toward max_tokens, so keep effort low.
                payload.reasoning_effort = config.AI_REASONING_EFFORT;
                payload.include_reasoning = false;
            }

            const response = await fetch(config.AI_API_BASE_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${config.AI_API_KEY}`,
                    "HTTP-Referer": toAsciiHeaderValue(config.STORE_URL, "http://localhost:3000"),
                    "X-Title": `${toAsciiHeaderValue(config.STORE_NAME, "Store")} AI Assistant`,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            clearTimeout(timeout);
            signal?.removeEventListener("abort", abortRequest);
            const responseText = await response.text();

            if (response.ok) {
                try {
                    return JSON.parse(responseText);
                } catch (_) {
                    throw new Error("Invalid AI JSON response");
                }
            }

            const isRateLimited =
                response.status === 429 ||
                responseText.includes("rate_limit_exceeded") ||
                responseText.includes("Rate limit reached");

            const isServerError = [500, 502, 503, 504].includes(response.status);

            if (isRateLimited || isServerError) {
                const delay = getRetryDelay(responseText, attempt);
                console.error(
                        `[ai_assistant.ai-client] ${
                        isRateLimited ? "Rate limit" : "Server error " + response.status
                    }. Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms`
                );
                lastError = new Error(`AI provider error ${response.status}`);
                await sleep(delay, deadline, signal);
                continue;
            }


            console.error(
                "[ai_assistant.ai-client] Unrecoverable provider error:",
                response.status,
                responseText.slice(0, 200)
            );
            throw new Error(`AI provider returned ${response.status}`);
        } catch (error) {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abortRequest);
            lastError = error;

            const isRetryable =
                error.name === "AbortError" ||
                error.code === "ECONNRESET" ||
                error.code === "ETIMEDOUT" ||
                error.code === "ECONNREFUSED" ||
                error.message?.includes("fetch failed");

            if (isRetryable) {
                const delay = getRetryDelay("", attempt);
                console.error(
                    `[ai_assistant.ai-client] Network error. Retry ${attempt + 1}/${MAX_RETRIES}`
                );
                await sleep(delay, deadline, signal);
                continue;
            }

            break;
        }
    }

    throw lastError || new Error("AI request failed");
}


function mergeCards(collected, seen, newCards) {
    for (const card of newCards) {
        if (!card) continue;
        const key = card.id || card.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        collected.push(card);
    }
}

async function runConversation(initialMessages) {
    const deadline = Date.now() + CONVERSATION_DEADLINE_MS;
    const controller = new AbortController();
    const messages = [...initialMessages];

    const collectedCards = [];
    const seenCardKeys = new Set();

    let emptyRecoveries = 0;

    for (let round = 0; round < config.AI_MAX_TOOL_ROUNDS; round++) {
        const result = await withDeadline(
            runAIRequest(() => callAIOnce(messages, { deadline, signal: controller.signal }), controller.signal),
            deadline,
            controller
        );

        const message = result?.choices?.[0]?.message;

        if (!message) {
            throw new Error("AI returned no message object");
        }

        const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
            .slice(0, MAX_TOOL_CALLS_PER_ROUND);

        if (toolCalls.length === 0) {
            const reply = extractText(message);

            if (reply) {
                return {
                    reply,
                    usedTools: round > 0,
                    products: collectedCards.slice(0, MAX_CARDS_PER_REPLY),
                };
            }


            if (emptyRecoveries < MAX_EMPTY_RECOVERIES) {
                emptyRecoveries++;
                if (config.AI_DEBUG) {
                    console.log(
                        "[ai_assistant.ai-client] Empty content, asking for a written reply:",
                        JSON.stringify(message).slice(0, 500)
                    );
                }
                messages.push(sanitizeAssistantMessage(message));
                messages.push({
                    role: "user",
                    content:
                        "Write the final response to the client now as direct plain text, without any steps of thought.",
                });
                round--; 
                continue;
            }

            throw new Error("AI returned empty content repeatedly");
        }

        // Only the calls that will actually be answered are echoed back, so
        // every tool_call id in the history has a matching tool message.
        messages.push(sanitizeAssistantMessage({ ...message, tool_calls: toolCalls }));

        for (const call of toolCalls) {
            // Tool execution must respect the same conversation deadline as
            // the provider calls (throws -> the controller's fallback reply).
            remainingTime(deadline);

            const { result: toolResult, cards } = await executeTool(
                call.function?.name,
                call.function?.arguments
            );

            mergeCards(collectedCards, seenCardKeys, cards || []);

            if (config.AI_DEBUG) {
                console.log(
                    `[ai_assistant.ai-client] tool ${call.function?.name}`,
                    call.function?.arguments,
                    "->",
                    JSON.stringify(toolResult).slice(0, 300)
                );
            }

            messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify(toolResult),
            });
        }
    }

    const finalAttempt = await withDeadline(
        runAIRequest(() => callAIOnce(
            [
                ...messages,
                {
                    role: "user",
                    content:
                        "Please give me a brief, final answer now, based solely on the information available to you.",
                },
            ],
            { withTools: false, deadline, signal: controller.signal }
        ), controller.signal),
        deadline,
        controller
    );

    const finalReply = extractText(finalAttempt?.choices?.[0]?.message);

    if (!finalReply) {
        throw new Error("AI returned empty response after tool rounds");
    }

    return {
        reply: finalReply,
        usedTools: true,
        products: collectedCards.slice(0, MAX_CARDS_PER_REPLY),
    };
}

module.exports = {
    runConversation,
};