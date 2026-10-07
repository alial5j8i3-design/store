// Single place for every JWT sign / verify in the app (SEC-08).
//
//  * verifyToken() ALWAYS pins the accepted algorithm to HS256. Without an
//    explicit `algorithms` list a token signed with another algorithm
//    (HS512, or "alg: none" on a misconfigured key) would not be rejected
//    by jsonwebtoken's defaults on the key type alone - pinning removes the
//    whole class of algorithm-confusion problems.
//  * signToken() signs with the same algorithm and the shared lifetime.
//
// Lifetime: JWT_EXPIRES_IN (e.g. "7d", "12h", "30m", "3600" = seconds).
// When it is NOT set, the previous behaviour (30 days) is kept so that
// deploying this change does not silently shorten anyone's session.
// Recommended for production: JWT_EXPIRES_IN=7d.
const jwt = require("jsonwebtoken");

const ALGORITHM = "HS256";
const DEFAULT_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60; // 30 days (previous value)

const UNIT_SECONDS = { s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60, w: 7 * 24 * 60 * 60 };

// Returns the token lifetime in SECONDS. Invalid values fall back to the
// default (and warn) instead of crashing or producing a token that never
// expires. A plain number is always seconds (jsonwebtoken would read the
// string "3600" as milliseconds, so we normalise to a number ourselves).
function jwtExpiresInSeconds(environment = process.env) {
    const raw = environment.JWT_EXPIRES_IN;
    if (typeof raw !== "string" || !raw.trim()) return DEFAULT_EXPIRES_IN_SECONDS;

    const match = /^(\d+)\s*([smhdw])?$/i.exec(raw.trim());
    if (match) {
        const amount = Number.parseInt(match[1], 10);
        const unit = (match[2] || "s").toLowerCase();
        const seconds = amount * UNIT_SECONDS[unit];
        if (seconds > 0) return seconds;
    }

    console.warn(`[config] Invalid JWT_EXPIRES_IN "${raw}" (use e.g. 7d, 12h, 30m or seconds); using 30d.`);
    return DEFAULT_EXPIRES_IN_SECONDS;
}

function signToken(payload) {
    return jwt.sign(payload, process.env.JWT_SECRET, {
        algorithm: ALGORITHM,
        expiresIn: jwtExpiresInSeconds(),
    });
}

// Throws on any problem (bad signature, wrong algorithm, expired, malformed)
// exactly like jwt.verify did, so every caller's existing try/catch -> 401
// handling keeps working unchanged.
function verifyToken(token) {
    return jwt.verify(token, process.env.JWT_SECRET, { algorithms: [ALGORITHM] });
}

module.exports = { ALGORITHM, DEFAULT_EXPIRES_IN_SECONDS, jwtExpiresInSeconds, signToken, verifyToken };