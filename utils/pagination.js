/*
 * Shared, server-enforced bounds for list endpoints (PERF-02 / LOGIC-09).
 *
 * Rules (all enforced here so every list endpoint behaves the same way):
 *   - `page` / `limit` MISSING or empty  -> the endpoint default is used.
 *   - `page` / `limit` PRESENT but malformed (text, "5abc", "1.5", "0", "-1",
 *     arrays, objects, more than 15 digits)  -> PaginationError (HTTP 400).
 *     A request that was not understood is never silently turned into a
 *     different request.
 *   - `limit` above the endpoint's maxLimit -> served with maxLimit. This is
 *     the long-standing, documented behaviour of every list endpoint and the
 *     response always echoes the limit that was actually applied.
 *   - `page` whose skip ((page - 1) * limit) would exceed MAX_SKIP -> 400.
 *     It is NOT clamped to "the last page": a client asking for page
 *     999999999 gets an explicit error, not different data.
 *
 * Limitation (documented, not hidden): a collection with more than MAX_SKIP
 * rows cannot be paged past that point with skip/limit. Reaching those rows
 * would need cursor (keyset) pagination, which is a contract change and is
 * deliberately NOT done here.
 */

const MAX_SKIP = 100000;

// Public category list / similarity scans. Categories are short
// (_id + name) documents; this is a ceiling for the PUBLIC LIST only. It is
// never used to decide whether a name is a duplicate (see add_section /
// update_section: those use a direct findOne plus a complete keyset scan).
const MAX_SECTION_ROWS = 2000;

const MAX_DIGITS = 15; // keeps every parsed value a safe integer

class PaginationError extends Error {
    constructor(message) {
        super(message);
        this.name = "PaginationError";
        this.status = 400;
        this.code = "INVALID_PAGINATION";
    }
}

// undefined | "" -> undefined (caller uses its default).
// Only a plain digit string (or an integer number) >= 1 is a valid value.
function strict_positive_int(value, name) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string") {
        const text = value.trim();
        if (text === "") return undefined;
        if (!new RegExp(`^\\d{1,${MAX_DIGITS}}$`).test(text)) {
            throw new PaginationError(`Invalid ${name} parameter`);
        }
        const n = Number(text);
        if (!Number.isSafeInteger(n) || n < 1) throw new PaginationError(`Invalid ${name} parameter`);
        return n;
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 1) throw new PaginationError(`Invalid ${name} parameter`);
        return value;
    }
    // arrays (?page=1&page=2, ?page[]=1) and objects (?page[a]=1)
    throw new PaginationError(`Invalid ${name} parameter`);
}

/**
 * @param {object} query            req.query
 * @param {{defaultLimit:number, maxLimit:number}} opts
 * @returns {{page:number, limit:number, skip:number}}
 * @throws {PaginationError}
 */
function paginate(query, { defaultLimit, maxLimit }) {
    const q = query || {};
    const requested_limit = strict_positive_int(q.limit, "limit");
    const requested_page = strict_positive_int(q.page, "page");

    const limit = Math.min(requested_limit === undefined ? defaultLimit : requested_limit, maxLimit);
    const page = requested_page === undefined ? 1 : requested_page;
    const skip = (page - 1) * limit;

    if (skip > MAX_SKIP) {
        throw new PaginationError("Requested page is out of range");
    }
    return { page, limit, skip };
}

/**
 * Express helper: returns { page, limit, skip } or - after sending the 400
 * response itself - null. Controllers keep their own envelope via `body`.
 *
 *   const pg = read_pagination(req, res, { defaultLimit: 10, maxLimit: 50 });
 *   if (!pg) return;
 */
function read_pagination(req, res, opts, body = { data: [] }) {
    try {
        return paginate(req.query, opts);
    } catch (error) {
        if (error instanceof PaginationError) {
            res.status(400).json({ success: false, message: error.message, ...body });
            return null;
        }
        throw error;
    }
}

module.exports = {
    MAX_SKIP,
    MAX_SECTION_ROWS,
    PaginationError,
    paginate,
    read_pagination,
};