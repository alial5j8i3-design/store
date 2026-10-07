/*
 * Express 4 does not handle a rejected promise returned by a route handler or
 * middleware: the rejection is never passed to next(), so the request hangs
 * until the client gives up and Node reports an unhandled rejection. (Express 5
 * fixes this; this project is on Express 4.)
 *
 * Every current controller already wraps its body in try/catch, so this is a
 * safety net for the cases that slip through (a throw inside a catch block, a
 * future handler without try/catch): the rejection is forwarded to next(err)
 * and ends up in the global error handler (utils/http_errors.js) instead of
 * leaving the request open.
 *
 * It wraps Layer#handle_request once, for the whole app, and changes nothing
 * for handlers that return a non-promise or that never reject.
 */

let installed = false;

function install() {
    if (installed) return true;
    let Layer;
    try {
        Layer = require("express/lib/router/layer");
    } catch (_) {
        console.warn("[async-safe] express Layer not found - async errors rely on controller try/catch");
        return false;
    }
    if (!Layer || !Layer.prototype || typeof Layer.prototype.handle_request !== "function") return false;

    const original = Layer.prototype.handle_request;
    Layer.prototype.handle_request = function handle_request(req, res, next) {
        const fn = this.handle;
        // Error-handling middleware (4 args) is skipped by Express here; keep that.
        if (typeof fn !== "function" || fn.length > 3) return original.call(this, req, res, next);

        try {
            const result = fn(req, res, next);
            if (result && typeof result.then === "function") {
                result.then(undefined, (error) => next(error));
            }
        } catch (error) {
            next(error);
        }
        return undefined;
    };
    installed = true;
    return true;
}

module.exports = { install };