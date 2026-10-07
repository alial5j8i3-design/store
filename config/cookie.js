const { jwtExpiresInSeconds } = require("../utils/jwt");

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax"
};

// maxAge only applies when SETTING the cookie (log_in/register/
// register_super_admin) - clearCookie() should NOT receive maxAge, so
// it's kept separate rather than merged into COOKIE_OPTIONS.
//
// Kept equal to the JWT lifetime (JWT_EXPIRES_IN, default 30 days) so the
// browser drops the cookie at the same moment the token inside expires.
const COOKIE_MAX_AGE_MS = jwtExpiresInSeconds() * 1000;

module.exports = { COOKIE_OPTIONS, COOKIE_MAX_AGE_MS };