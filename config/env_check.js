const PLACEHOLDER_SECRET = /^(?:change|replace|your|my[_-]?secret|secret|example|placeholder)/i;

function isRepeatedShortSegment(value) {
    return /^(.{1,16})\1+$/.test(value);
}

function workerCount(environment) {
    const values = [
        environment.WEB_CONCURRENCY,
        environment.PM2_INSTANCES,
        environment.NODE_CLUSTER_WORKERS,
    ];
    return Math.max(0, ...values.map((value) => Number.parseInt(value, 10) || 0));
}

// Number of reverse proxies in front of the app (Express "trust proxy").
// Default 1 (a single Nginx / load balancer). Invalid values fall back to 1.
function trustProxyHops(environment = process.env) {
    const raw = environment.TRUST_PROXY_HOPS;
    if (typeof raw !== "string" || !/^\d{1,2}$/.test(raw.trim())) return 1;
    return Number.parseInt(raw, 10);
}

// Client IP of a raw Node request (used for Socket.IO, which has no req.ip).
// Mirrors Express's numeric "trust proxy": the `hops` closest addresses (the
// socket peer first, then X-Forwarded-For from the right) are trusted proxies
// and the first address beyond them is the client. Entries a client forged on
// the left of X-Forwarded-For are therefore never used while the proxy chain
// is configured correctly, and with hops = 0 the header is ignored entirely.
function normalizeIp(value) {
    if (typeof value !== "string") return "";
    let ip = value.trim().toLowerCase();
    if (!ip || ip.length > 64) return "";
    if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7);
    return ip;
}

function clientIpFromRequest(request, hops = trustProxyHops()) {
    const peer = normalizeIp(request?.socket?.remoteAddress) || "unknown";
    if (!(hops > 0)) return peer;
    const header = request?.headers?.["x-forwarded-for"];
    const raw = Array.isArray(header) ? header.join(",") : header;
    if (typeof raw !== "string" || !raw) return peer;
    const chain = raw.split(",", 64).map(normalizeIp).filter(Boolean);
    chain.push(peer);
    return chain[Math.max(0, chain.length - 1 - hops)];
}

// MongoDB connection pool size PER PROCESS. With PM2 cluster mode the total is
// pool size x number of workers, so the default is small (10). Invalid or
// non-positive values fall back to 10; capped at 100.
function mongoMaxPoolSize(environment = process.env) {
    const raw = environment.MONGO_MAX_POOL_SIZE;
    if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw.trim())) return 10;
    const value = Number.parseInt(raw, 10);
    return value >= 1 ? Math.min(value, 100) : 10;
}

function runningUnderPm2(environment) {
    return environment.pm_id !== undefined;
}

function validateEnvironment(environment = process.env) {
    const production = environment.NODE_ENV === "production";
    const jwtSecret = typeof environment.JWT_SECRET === "string" ? environment.JWT_SECRET.trim() : "";
    const errors = [];
    const warnings = [];

    if (!production) {
        if (!jwtSecret || jwtSecret.length < 32 || PLACEHOLDER_SECRET.test(jwtSecret) || isRepeatedShortSegment(jwtSecret)) {
            warnings.push("JWT_SECRET is missing, weak, or a placeholder; production startup will be refused.");
        }
        if (workerCount(environment) > 1) {
            warnings.push("Multiple workers should run with NODE_ENV=production.");
        }
        if (runningUnderPm2(environment)) {
            warnings.push("Running under PM2 with NODE_ENV!=production: cookies will not be marked secure and Mongo autoIndex stays enabled in every worker.");
        }
        return { production, errors, warnings };
    }

    if (!jwtSecret || jwtSecret.length < 32 || PLACEHOLDER_SECRET.test(jwtSecret) || isRepeatedShortSegment(jwtSecret)) {
        errors.push("JWT_SECRET must be a non-placeholder random value of at least 32 characters.");
    }
    if (typeof environment.MONGO_URL !== "string" || !environment.MONGO_URL.trim()) {
        errors.push("MONGO_URL is required in production.");
    }
    if (typeof environment.STORE_URL !== "string" || !environment.STORE_URL.trim()) {
        errors.push("STORE_URL is required in production.");
    }
    if (workerCount(environment) > 1 && environment.NODE_ENV !== "production") {
        errors.push("Multiple workers require NODE_ENV=production.");
    }

    if ((workerCount(environment) > 1 || runningUnderPm2(environment)) &&
        (typeof environment.REDIS_URL !== "string" || !environment.REDIS_URL.trim())) {
        warnings.push("REDIS_URL is not set while running multiple workers; each worker will use a separate local cache. Set REDIS_URL so all workers share one cache.");
    }

    if (typeof environment.TRUST_PROXY_HOPS !== "string" || !environment.TRUST_PROXY_HOPS.trim()) {
        warnings.push("TRUST_PROXY_HOPS is not set; assuming 1 reverse proxy in front of the app. Set it to the real number of proxies so client IPs (rate limiting) and secure cookies work correctly.");
    }

    return { production, errors, warnings };
}

function assertRuntimeEnvironment(environment = process.env) {
    const result = validateEnvironment(environment);
    for (const warning of result.warnings) console.warn(`[config] ${warning}`);
    if (result.errors.length) {
        console.error(`[config] Refusing to start:\n- ${result.errors.join("\n- ")}`);
        process.exit(1);
    }
    return result;
}

module.exports = { validateEnvironment, assertRuntimeEnvironment, isRepeatedShortSegment, trustProxyHops, mongoMaxPoolSize, clientIpFromRequest };