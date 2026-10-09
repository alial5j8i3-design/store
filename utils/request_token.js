// Single place that decides WHERE the session JWT is read from.
//
// Priority:
//   1. httpOnly "token" cookie   (primary - safest, used when the page and the
//                                 API share an origin)
//   2. Authorization: Bearer ... (fallback - lets a session survive when the
//                                 frontend fails over to a different server /
//                                 domain, where the cookie is never sent)
//
// Both carry the SAME JWT signed with the SAME JWT_SECRET, so any server that
// shares the database and the secret accepts it.

const MAX_TOKEN_LENGTH = 4096;

function from_authorization_header(req) {
    const header = req.headers && req.headers.authorization;
    if (typeof header !== "string") return null;
    const match = header.match(/^Bearer\s+(\S+)$/i);
    return match ? match[1] : null;
}

function extract_token(req) {
    const cookie = req.cookies && req.cookies.token;
    const token = (typeof cookie === "string" && cookie) ? cookie : from_authorization_header(req);
    if (!token || token.length > MAX_TOKEN_LENGTH) return null;
    return token;
}

// Socket.IO handshake: explicit auth payload first, then the cookie.
function extract_token_from_socket(socket) {
    const handshake = socket.handshake || {};

    const explicit = handshake.auth && handshake.auth.token;
    if (typeof explicit === "string" && explicit && explicit.length <= MAX_TOKEN_LENGTH) {
        return explicit;
    }

    const raw_cookie = handshake.headers && handshake.headers.cookie;
    if (!raw_cookie) return null;

    const match = raw_cookie.match(/(?:^|;\s*)token=([^;]+)/);
    if (!match) return null;

    // A malformed %-escape must not throw out of the handshake middleware.
    try {
        const value = decodeURIComponent(match[1]);
        return value.length <= MAX_TOKEN_LENGTH ? value : null;
    } catch (_) {
        return null;
    }
}

module.exports = { extract_token, extract_token_from_socket };