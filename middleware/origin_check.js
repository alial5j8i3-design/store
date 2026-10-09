// CSRF defence-in-depth for state-changing requests (SEC-08).
//
// The session cookie is SameSite=Lax, which already blocks most cross-site
// POSTs. This adds a second, server-side check on POST/PUT/PATCH/DELETE:
//
//   * Origin header present  -> it must match one of the origins in STORE_URL
//                               (comma separated list, same variable the
//                               Socket.IO CORS check uses).
//   * Origin header absent   -> allowed, UNLESS the browser says
//                               Sec-Fetch-Site: cross-site (then 403).
//                               Non-browser clients (curl, mobile apps,
//                               server-to-server) send neither header and pass.
//
// It only runs when BOTH are true:
//   NODE_ENV=production   (so local development and the test suites are
//                          never affected)
//   ENFORCE_ORIGIN_CHECK=1 (explicit opt-in: a browser-origin allow-list can
//                           block legitimate API clients that do send an
//                           Origin, so it is never switched on silently)
//
// The variables are read on every request (not at require-time) so the
// behaviour follows the live environment and is testable.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let warnedAboutEmptyAllowList = false;

function normaliseOrigin(value) {
    try {
        const url = new URL(String(value).trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.origin; // scheme + host + port, no path / trailing slash
    } catch (_) {
        return null;
    }
}

// STORE_URL may legitimately contain a path ("https://shop.example/app") -
// the Origin header never does, so compare origins only.
function allowedOrigins(environment = process.env) {
    return new Set(
        String(environment.STORE_URL || "")
            .split(",")
            .map(normaliseOrigin)
            .filter(Boolean),
    );
}

function isEnforced(environment = process.env) {
    return environment.NODE_ENV === "production" && environment.ENFORCE_ORIGIN_CHECK === "1";
}

function forbidden(res) {
    return res.status(403).json({
        success: false,
        message: "Cross-origin request blocked",
    });
}

function origin_check(req, res, next) {
    if (!isEnforced() || !MUTATING_METHODS.has(req.method)) return next();

    const origin = req.headers.origin;

    if (origin === undefined) {
        // No Origin: only a browser-declared cross-site request is refused.
        if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") {
            return forbidden(res);
        }
        return next();
    }

    const allowed = allowedOrigins();
    if (allowed.size === 0 && !warnedAboutEmptyAllowList) {
        warnedAboutEmptyAllowList = true;
        console.warn("[origin_check] ENFORCE_ORIGIN_CHECK=1 but STORE_URL has no valid origin; every request carrying an Origin header will be refused.");
    }

    // Origin: "null" (sandboxed iframe / privacy redirect) normalises to
    // null and is therefore refused, as is anything not in the allow-list.
    const normalised = normaliseOrigin(origin);
    if (normalised && allowed.has(normalised)) return next();

    return forbidden(res);
}

module.exports = origin_check;
module.exports.allowedOrigins = allowedOrigins;
module.exports.isEnforced = isEnforced;