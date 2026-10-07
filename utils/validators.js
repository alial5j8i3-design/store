const PHONE_REGEX = /^\+?[0-9\s\-()]{7,20}$/;

const MAX_URL_LENGTH = 500;

function is_valid_http_url(value, max = MAX_URL_LENGTH) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max) return false;
    try {
        const url = new URL(trimmed);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch (_) {
        return false;
    }
}

function check_optional_http_url(value, max = MAX_URL_LENGTH) {
    if (typeof value !== "string") return { ok: true, value: "" };
    const trimmed = value.trim();
    if (!trimmed) return { ok: true, value: "" };
    if (!is_valid_http_url(trimmed, max)) return { ok: false };
    return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Image URLs (SEC-06)
//
// Images are uploaded by the browser straight to Cloudinary; this server only
// ever STORES the resulting URL and never fetches it, so there is no
// server-side SSRF. The URL is still attacker-controlled data that every
// viewer's browser (and the seller dashboard's HTML templates) will load, so
// it is validated here, once, for every product write path.
// ---------------------------------------------------------------------------

// Characters that can never appear in a URL we are willing to store: any
// whitespace/control character, quotes, angle brackets, backtick and
// backslash. A value like  https://x/a" onerror="...  is a valid WHATWG URL
// (the parser percent-encodes the quote) but, stored raw, breaks out of an
// HTML attribute. Legitimate URLs percent-encode these characters.
const UNSAFE_URL_CHARS = /[\s"'<>`\\\u0000-\u001f\u007f]/;

// The project has no use for SVG (it can carry active content) or for
// anything that is not a raster image.
const BLOCKED_IMAGE_EXTENSIONS = new Set([
    "svg", "svgz", "html", "htm", "xhtml", "xml", "js", "mjs",
    "php", "exe", "sh", "bat", "swf",
]);

// Host of the Cloudinary `secure_url` the seller dashboard receives. Always
// accepted when an allowlist is configured so enabling the allowlist can
// never break the built-in upload flow.
const TRUSTED_IMAGE_HOSTS = ["res.cloudinary.com"];

function configured_image_hosts() {
    return String(process.env.ALLOWED_IMAGE_HOSTS || "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
}

// IP literals (the WHATWG parser normalises 0x7f.1 / 2130706433 to dotted
// decimal, so one check covers them), IPv6 literals and well-known internal
// names. Viewers' browsers must not be pointed at internal services.
function is_internal_host(host) {
    if (host.startsWith("[")) return true;
    if (/^\d+(\.\d+){0,3}$/.test(host)) return true;
    return (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".lan") ||
        host.endsWith(".home.arpa")
    );
}

// ALLOWED_IMAGE_HOSTS unset  -> http/https image URLs are accepted (previous
//                               behaviour), minus everything rejected below.
// ALLOWED_IMAGE_HOSTS set    -> https only, and the host must be listed (or be
//                               Cloudinary). Production should set it.
function is_valid_image_url(value, max = MAX_URL_LENGTH) {
    if (typeof value !== "string") return false;
    if (!value || value.length > max) return false;
    if (UNSAFE_URL_CHARS.test(value)) return false;

    let url;
    try {
        url = new URL(value);
    } catch (_) {
        return false;
    }

    // Blocks javascript:, data:, file:, ftp:, blob:, ...
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    // url.port is "" for the default port, so any explicit port is unusual.
    if (url.port) return false;

    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || is_internal_host(host)) return false;

    const extension = (url.pathname.match(/\.([a-z0-9]+)$/i) || [])[1];
    if (extension && BLOCKED_IMAGE_EXTENSIONS.has(extension.toLowerCase())) return false;

    const allowed = configured_image_hosts();
    if (allowed.length > 0) {
        return url.protocol === "https:" && [...allowed, ...TRUSTED_IMAGE_HOSTS].includes(host);
    }

    return true;
}

module.exports = { PHONE_REGEX, MAX_URL_LENGTH, is_valid_http_url, check_optional_http_url, is_valid_image_url };