// Single source of truth for which store fields a client may write, and
// how they are validated. Shared by the seller store controller and the
// super_admin store controller so the two can't drift apart.
//
// Ownership (owner_id) and any future privileged flags (verification
// status, ratings, ...) are deliberately NOT here: they can never be set
// from a request body.

const { PHONE_REGEX, is_valid_http_url } = require("./validators");

const STRING_FIELDS = {
    store_name: 120,
    store_description: 1000,
    store_phone: 40,
    store_whatsApp_number: 40,
    store_GPS: 500,
};

const MAX_DESIGN_JSON_LENGTH = 5000;

// Returns { data } on success or { error } (a client-safe message) on
// invalid input. Unknown fields are silently ignored (allowlist).
function pick_store_fields(body) {
    const src = body && typeof body === "object" ? body : {};
    const data = {};

    for (const [field, max] of Object.entries(STRING_FIELDS)) {
        if (src[field] === undefined) continue;

        if (typeof src[field] !== "string") {
            return { error: `${field} must be a string` };
        }

        const value = src[field].trim();

        if (value.length > max) {
            return { error: `${field} must be at most ${max} characters` };
        }

        if ((field === "store_phone" || field === "store_whatsApp_number") && value && !PHONE_REGEX.test(value)) {
            return { error: `${field} must be a valid phone number` };
        }

        if (field === "store_GPS" && value && !is_valid_http_url(value, max)) {
            return { error: "store_GPS must be a valid http/https link" };
        }

        data[field] = value;
    }

    if (src.store_design !== undefined) {
        const d = src.store_design;
        if (d === null || typeof d !== "object" || Array.isArray(d)) {
            return { error: "store_design must be an object" };
        }
        if (JSON.stringify(d).length > MAX_DESIGN_JSON_LENGTH) {
            return { error: "store_design is too large" };
        }
        data.store_design = d;
    }

    if (data.store_name !== undefined && data.store_name === "") {
        return { error: "store_name cannot be empty" };
    }

    return { data };
}

module.exports = { pick_store_fields };
