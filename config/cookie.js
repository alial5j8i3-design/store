const { jwtExpiresInSeconds } = require("../utils/jwt");

const isProduction = process.env.NODE_ENV === "production";

const COOKIE_OPTIONS = {
    httpOnly: true,
    // sameSite "none" requires secure: true, so it is only used in production (HTTPS).
    // Needed because the frontend (GitHub Pages) and the API (Railway) are on different sites.
    // On local http development we keep "lax" because browsers reject "none" without secure.
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax"
};

// maxAge only applies when SETTING the cookie (log_in/register/
// register_super_admin) - clearCookie() should NOT receive maxAge, so
// it's kept separate rather than merged into COOKIE_OPTIONS.
//
// Kept equal to the JWT lifetime (JWT_EXPIRES_IN, default 30 days) so the
// browser drops the cookie at the same moment the token inside expires.
const COOKIE_MAX_AGE_MS = jwtExpiresInSeconds() * 1000;

module.exports = { COOKIE_OPTIONS, COOKIE_MAX_AGE_MS };
