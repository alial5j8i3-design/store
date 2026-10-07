/*
 * Global Express error handling (BUG-03).
 *
 * Contract preserved: every error body is `{ success: false, message }`.
 * The client only ever receives one of the fixed messages below - never
 * `error.message`, stack traces, MongoDB / Mongoose details, file paths or
 * library internals. Server-side logging keeps the detail (the stack only
 * outside production).
 */

const CLIENT_ERROR_MESSAGES = {
    400: "Bad request",
    401: "Authentication required",
    403: "Access denied",
    404: "Resource not found",
    409: "Conflict",
    413: "Request body is too large",
    415: "Unsupported media type",
    429: "Too many requests",
};

const JWT_ERRORS = new Set(["JsonWebTokenError", "TokenExpiredError", "NotBeforeError"]);

// Maps an error to `{ status, message }`, or null when it is not a known
// client-side failure (=> 500).
function classify_error(error) {
    if (!error || typeof error !== "object") return null;

    if (error instanceof SyntaxError && "body" in error) {
        return { status: 400, message: "Malformed JSON request body" };
    }

    // body-parser / http-errors style 4xx
    const status = Number(error.status ?? error.statusCode);
    if (Number.isInteger(status) && status >= 400 && status <= 499) {
        const code = error.type === "entity.too.large" ? 413 : status;
        return { status: code, message: CLIENT_ERROR_MESSAGES[code] || "Request could not be processed" };
    }

    // Mongoose: a malformed id / value cast, or a schema validation failure,
    // is caused by the request, not by the server.
    if (error.name === "CastError") return { status: 400, message: "Invalid request parameter" };
    if (error.name === "ValidationError") return { status: 400, message: "Invalid request data" };

    // MongoDB duplicate key (unique index).
    if (error.code === 11000 || error.code === 11001) {
        return { status: 409, message: "Resource already exists" };
    }

    if (JWT_ERRORS.has(error.name)) return { status: 401, message: "Invalid or expired token" };

    return null;
}

// Server-side logs must not become a secret store: connection strings
// (mongodb://user:pass@host), bearer tokens and JWT-looking strings that a
// driver / library error message may embed are masked before logging.
function redact(text) {
    return String(text)
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "***jwt***");
}

function log_unexpected(error, req) {
    // Logging must never be the reason a request fails or the process dies.
    try {
        const where = `${req && req.method ? req.method : "?"} ${req && req.path ? req.path : "?"}`;
        const name = error && error.name ? error.name : "Error";
        const message = error && error.message ? error.message : String(error);
        if (process.env.NODE_ENV === "production") {
            console.error(`Unhandled request error [${where}] ${name}: ${redact(message)}`);
        } else {
            console.error(`Unhandled request error [${where}]`, error && error.stack ? redact(error.stack) : redact(message));
        }
    } catch (_) { /* ignore */ }
}

// Express error middleware (4 arguments - required for Express to treat it as one).
function error_handler(error, req, res, next) {
    if (res.headersSent) return next(error);

    let known = null;
    try {
        known = classify_error(error);
    } catch (_) { /* classification must never throw: treat as unexpected */ }
    if (known) return res.status(known.status).json({ success: false, message: known.message });

    log_unexpected(error, req);
    return res.status(500).json({ success: false, message: "Internal server error" });
}

// Last route: anything that no API route, static file or page matched and that
// is not a GET/HEAD page navigation (those get public/404.html earlier).
function not_found_handler(req, res) {
    res.status(404).json({ success: false, message: "Resource not found" });
}

module.exports = { classify_error, error_handler, not_found_handler, CLIENT_ERROR_MESSAGES, redact };