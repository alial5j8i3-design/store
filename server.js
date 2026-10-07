require("dotenv").config();
const { assertRuntimeEnvironment, trustProxyHops, mongoMaxPoolSize, clientIpFromRequest } = require("./config/env_check");
assertRuntimeEnvironment();

const express = require("express");
const mongoose = require("mongoose");
const { verifyToken } = require("./utils/jwt");
const http = require("http");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");
const path = require("path");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const compression = require("compression");

const { createRateLimiter } = require("./utils/rate_limit_store");
const { error_handler, not_found_handler, redact } = require("./utils/http_errors");
const { create_graceful_shutdown } = require("./utils/graceful_shutdown");
const { install: install_async_safety_net } = require("./utils/async_safe");
const origin_check = require("./middleware/origin_check");
const mongoSanitize = require("express-mongo-sanitize");
const redis = require("./config/redis");
const users = require("./models/users");
const { CATALOG_ROOM, ADMINS_ROOM, user_room, seller_room } = require("./utils/socket_events");

// Express 4: a rejected async handler is forwarded to the error handler
// instead of leaving the request open (see utils/async_safe.js).
install_async_safety_net();

const app = express();

const PORT = process.env.PORT || 3000;

/*
 * =========================================
 * Trust proxy
 *
 * Required so express-rate-limit can use the client's real IP
 * when the server runs behind Nginx/load balancer, and also so secure cookies
 * work correctly behind a proxy performing TLS
 * termination.
 * =========================================
 */

// Number of proxies in front of the app comes from TRUST_PROXY_HOPS (default 1).
app.set("trust proxy", trustProxyHops());

/*
 * =========================================
 * Security & performance middleware
 * =========================================
 */

/*
 * Content-Security-Policy is intentionally NOT enforced: the pages use inline
 * <script>/style blocks and several CDNs, so an enforced policy would break
 * them. Set CSP_REPORT_ONLY=1 to send it as Content-Security-Policy-Report-Only
 * instead: browsers log violations (DevTools console, or POST them to
 * CSP_REPORT_URI if set) but block nothing. Unset = no CSP header, as before.
 */
const cspReportOnly = process.env.CSP_REPORT_ONLY === "1";
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.socket.io"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
  fontSrc: ["'self'", "data:", "https://cdnjs.cloudflare.com"],
  imgSrc: ["'self'", "data:", "blob:", "https:"],
  connectSrc: ["'self'", "ws:", "wss:", "https://api.cloudinary.com"],
  frameSrc: ["https://www.google.com", "https://maps.google.com"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"],
};
if (process.env.CSP_REPORT_URI) {
  cspDirectives.reportUri = [process.env.CSP_REPORT_URI];
}

app.use(
  helmet({
    contentSecurityPolicy: cspReportOnly
      ? { useDefaults: false, reportOnly: true, directives: cspDirectives }
      : false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(compression());

const generalLimiter = createRateLimiter({
  prefix: "api-general",
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // 500 requests per IP within 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests from this device. Please try again later.",
    data: [],
  },
});

app.use("/api", generalLimiter);

/*
 * Note: login and registration already have
 * dedicated and stricter rate limiters inside
 * routes/log_in.router.js and
 * routes/register.router.js, so there is no need
 * to duplicate them here.
 */

/*
 * =========================================
 * Middleware
 * =========================================
 */

// Rejects cross-origin state-changing requests. No-op unless
// NODE_ENV=production AND ENFORCE_ORIGIN_CHECK=1 (see middleware/origin_check.js).
// Placed before the body parsers so a blocked request is never parsed.
app.use(origin_check);

app.use(cookieParser());

// Explicit, finite body limits (these equal the former implicit defaults, so
// behaviour is unchanged; they are spelled out so the limit is visible and
// cannot silently change with a dependency upgrade).
app.use(
  express.urlencoded({
    extended: true,
    limit: "100kb",
    parameterLimit: 1000,
  }),
);

app.use(express.json({ limit: "100kb" }));


app.use(
  mongoSanitize({
    replaceWith: "_",
  }),
);

/*
 * =========================================
 * MongoDB
 * =========================================
 */

mongoose
  .connect(process.env.MONGO_URL, {
    // Per-process pool. Total connections = this x PM2 workers, so it is
    // configurable (MONGO_MAX_POOL_SIZE, default 10) to stay under the Atlas limit.
    maxPoolSize: mongoMaxPoolSize(),
    serverSelectionTimeoutMS: 10000,
    // Both default to 0 (= wait forever) in the driver. With them unset, a
    // hung MongoDB socket or an exhausted pool leaves requests open
    // indefinitely. Finite values turn that into a fast, handled error.
    socketTimeoutMS: 45000,
    waitQueueTimeoutMS: 10000,
    // Production index builds are performed explicitly by
    // scripts/sync_indexes.js so application startup cannot block on a
    // large collection. Development keeps Mongoose's convenient default.
    autoIndex: process.env.NODE_ENV !== "production",
  })
  .then(() => {
    console.log("MongoDB conneted");
  })
  .catch((error) => {
    console.error("MongoDB initial connection failed:", error.message);
    process.exit(1);
  });

mongoose.connection.on("disconnected", () => {
  console.warn(
    "MongoDB disconnected - mongoose will try to reconnect automatically",
  );
});

mongoose.connection.on("reconnected", () => {
  console.log("MongoDB reconnected");
});

/*
 * =========================================
 * HTTP Server
 * =========================================
 */

const server = http.createServer(app);

/*
 * =========================================
 * Socket.IO
 * =========================================
 */

// Same normalised allow-list as the HTTP origin check (SEC-08): STORE_URL may
// contain a path or trailing slash, but a browser Origin header never does.
const allowedSocketOrigins = origin_check.allowedOrigins();

function socketOriginAllowed(origin) {
  if (!origin) return process.env.NODE_ENV !== "production";
  return allowedSocketOrigins.has(origin);
}

const io = new Server(server, {
  cors: {
    origin: [...allowedSocketOrigins],
    credentials: true,
  },

  transports: ["polling", "websocket"],
allowRequest: (request, callback) => {
  console.log("[socket origin]", request.headers.origin);
  console.log("[allowed origins]", [...allowedSocketOrigins]);

  callback(null, socketOriginAllowed(request.headers.origin));
},


// Redis clients created for the Socket.IO adapter; closed on shutdown.
const adapterClients = [];

if (redis.isRedisConfigured()) {
  const adapterOptions = { enableOfflineQueue: true, enableReadyCheck: true, maxRetriesPerRequest: null };
  const pubClient = new Redis(process.env.REDIS_URL, adapterOptions);
  const subClient = new Redis(process.env.REDIS_URL, adapterOptions);

  pubClient.on("error", (err) => {
    console.error("[socket.io redis pub] error:", err.message);
  });

  subClient.on("error", (err) => {
    console.error("[socket.io redis sub] error:", err.message);
  });

  adapterClients.push(pubClient, subClient);
  io.adapter(createAdapter(pubClient, subClient));

  console.log(
    "[socket.io] Redis adapter enabled - broadcasts now reach all PM2 workers",
  );
} else {
  console.warn(
    "[socket.io] REDIS_URL not set - real-time events (new_product, new_order, " +
      "update_status, ...) will only reach clients connected to THIS process. " +
      "That's fine for a single process, but BREAKS notifications once you run " +
      "with PM2 cluster mode / instances > 1. Set REDIS_URL before scaling.",
  );
}

/*
 * =========================================
 * Make Socket.IO available in routes/controllers
 * =========================================
 */

app.use((req, res, next) => {
  req.io = io;
  next();
});

/*
 * =========================================
 * Socket.IO connection
 * =========================================
 */

const MAX_SOCKET_TOKEN_LENGTH = 4096;

function get_token_from_socket(socket) {
  const raw_cookie = socket.handshake.headers.cookie;

  if (!raw_cookie) {
    return null;
  }

  const match = raw_cookie.match(/(?:^|;\s*)token=([^;]+)/);

  if (!match) return null;

  // A malformed %-escape must not throw out of the handshake middleware.
  try {
    return decodeURIComponent(match[1]);
  } catch (_) {
    return null;
  }
}

io.use(async (socket, next) => {
  // The JWT signature/expiry is verified BEFORE any database access, so
  // guests and forged tokens never cost a query. Invalid, expired or
  // unknown-user sessions simply stay visitor sessions (catalog room only).
  try {
    const token = get_token_from_socket(socket);
    if (token && token.length <= MAX_SOCKET_TOKEN_LENGTH) {
      const decoded = verifyToken(token);
      if (decoded?.id) {
        const user = await users.findById(decoded.id).select("_id role").lean();
        if (user) socket.data.user = user;
      }
    }
  } catch (_) { /* expired or invalid tokens remain visitor sessions */ }
  next();
});

/*
 * Per-IP connection-rate limit (20 connections / 10 s), evaluated on the raw
 * engine connection, i.e. BEFORE the auth middleware, so floods never reach
 * MongoDB.
 *
 * Memory is bounded: every entry carries its own expiry, entries are expired
 * from the front of the Map (insertion order == expiry order because all
 * windows have the same length and a restarted window is re-inserted at the
 * end), a single process-wide unref'd timer prunes them, and the Map can never
 * hold more than CONNECT_MAX_TRACKED_IPS keys.
 */
const CONNECT_WINDOW_MS = 10_000;
const CONNECT_MAX_PER_WINDOW = 20;
const CONNECT_MAX_TRACKED_IPS = 50_000;
const CONNECT_SWEEP_INTERVAL_MS = 30_000;
const SOCKET_TRUST_HOPS = trustProxyHops();
const connectionAttempts = new Map(); // ip -> { count, resetAt }

function pruneExpiredConnectionAttempts(now) {
  for (const [ip, entry] of connectionAttempts) {
    if (entry.resetAt > now) break; // the rest expire later
    connectionAttempts.delete(ip);
  }
}

function connectionAllowed(ip, now = Date.now()) {
  let entry = connectionAttempts.get(ip);
  if (entry && entry.resetAt <= now) {
    connectionAttempts.delete(ip);
    entry = undefined;
  }
  if (!entry) {
    if (connectionAttempts.size >= CONNECT_MAX_TRACKED_IPS) {
      pruneExpiredConnectionAttempts(now);
      if (connectionAttempts.size >= CONNECT_MAX_TRACKED_IPS) {
        connectionAttempts.delete(connectionAttempts.keys().next().value);
      }
    }
    connectionAttempts.set(ip, { count: 1, resetAt: now + CONNECT_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= CONNECT_MAX_PER_WINDOW;
}

// ONE timer for the whole process (not per connection); unref() so it never
// keeps Node alive, and cleared on graceful shutdown.
const connectionAttemptsSweeper = setInterval(
  () => pruneExpiredConnectionAttempts(Date.now()),
  CONNECT_SWEEP_INTERVAL_MS,
);
connectionAttemptsSweeper.unref();

io.engine.on("connection", (rawSocket) => {
  // Same trust rule as Express's "trust proxy" (TRUST_PROXY_HOPS), so behind
  // Nginx / a load balancer every visitor is counted by their own IP and a
  // forged X-Forwarded-For cannot dodge the limit.
  const ip = clientIpFromRequest(rawSocket.request, SOCKET_TRUST_HOPS);
  if (ip === "unknown") return; // peer already gone: nothing to attribute
  if (!connectionAllowed(ip)) rawSocket.close();
});

io.on("connection", (socket) => {
  if (process.env.SOCKET_DEBUG === "1") console.debug("Socket connected:", socket.id);
  socket.join(CATALOG_ROOM);
  if (socket.data.user) {
    socket.join(user_room(socket.data.user._id));
    if (socket.data.user.role === "super_admin") socket.join(ADMINS_ROOM);
    if (socket.data.user.role === "seller") socket.join(seller_room(socket.data.user._id));
  }

  let eventWindowStarted = Date.now();
  let eventCount = 0;
  socket.use((packet, next) => {
    const now = Date.now();
    if (now - eventWindowStarted >= 10_000) { eventWindowStarted = now; eventCount = 0; }
    if (++eventCount > 10) { socket.disconnect(true); return; }
    next();
  });

  /*
    Admin joins admins room
   */

  socket.on("join_admin", () => {
    if (socket.data.user?.role === "super_admin") socket.join(ADMINS_ROOM);
  });

  /*
   * Every client (guest or logged in) joins the public "catalog" room.
   * Events sent there carry public, minimal data only (see
   * utils/socket_events.js). Authenticated clients additionally join their
   * own private "user:<id>" room, which is the only place user-specific
   * events (order status, role changes) are delivered.
   */

  socket.on("join_users", () => {
    socket.join(CATALOG_ROOM);
    if (socket.data.user) socket.join(user_room(socket.data.user._id));
  });

  /*
   * Socket disconnected
   */

  socket.on("disconnect", () => {
    if (process.env.SOCKET_DEBUG === "1") console.debug("Socket disconnected:", socket.id);
  });
});

/*
 * =========================================
 * APIs
 * =========================================
 */

const register = require("./routes/register.router");

const register_super_admin = require("./routes/register_super_admin.router");

const log_in = require("./routes/log_in.router");

const log_out = require("./routes/log_out.router");

const auth_me_router = require("./routes/auth_me.router");

const get_cloudinary_config = require("./routes/get_cloudinary_config.router");

const add_seller = require("./routes/add_seller.router");

const from_user_to_seller = require("./routes/from_user_to_seller.router");

const seller_coupon = require("./routes/seller_coupon.router");

const add_products = require("./routes/add_products.router");

const add_section = require("./routes/add_section.router");

const delete_product = require("./routes/delete_product.router");

const get_products = require("./routes/get_products.router");

const get_seller_products = require("./routes/get_seller_products.router");

const order = require("./routes/order.router");

const delete_order = require("./routes/delete_order.router");

const update_status_of_order = require("./routes/update_status.router");

const get_user_orders = require("./routes/get_user_orders.router");

const get_all_orders = require("./routes/get_all_orders.router");

const get_all_sections = require("./routes/get_all_sections.router");

const get_requset_to_sellers = require("./routes/get_requset_to_sellers.router");

const ai_assistant = require("./routes/ai_assistant.router");

const update_admin_to_user = require("./routes/update_admin_to_user.router");

const post_review = require("./routes/post_review.router");

const delete_review = require("./routes/delete_review.router");

const get_all_users = require("./routes/get_all_users.router");

const get_product_reviews = require("./routes/get_product_reviews.router");

const update_product = require("./routes/update_produt.router");

const seller_store = require("./routes/seller_store.router");

const admin_store = require("./routes/admin_store.router");

const public_store = require("./routes/public_store.router");

const ticket_router = require("./routes/ticket.router");

app.use(auth_me_router);

app.use(register);

app.use(log_in);

app.use(log_out);

app.use(register_super_admin);

app.use(get_cloudinary_config);

app.use(add_seller);

app.use(from_user_to_seller);

app.use(seller_coupon);

app.use(add_products);

app.use(add_section);

app.use(delete_product);

app.use(get_products);

app.use(get_seller_products);

app.use(order);

app.use(delete_order);

app.use(update_status_of_order);

app.use(get_user_orders);

app.use(get_all_orders);

app.use(get_all_sections);

app.use(get_requset_to_sellers);

app.use(ai_assistant);

app.use(update_admin_to_user);

app.use(post_review);

app.use(delete_review);

app.use(get_all_users);

app.use(get_product_reviews);

app.use(update_product)

app.use(seller_store);

app.use(admin_store);

app.use(public_store);

app.use(ticket_router);

// API routes must always return JSON, including unknown endpoints.
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "API endpoint not found" });
});
/*
 * =========================================
 * Static files
 * =========================================
 */

app.use(express.static(path.join(__dirname, "public")));

/*
 * =========================================
 * Pages
 * =========================================
 */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/products", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "products.html"));
});

app.get("/product", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "product.html"));
});

// Store "Problem Resolution Center" (help center) page
app.get("/store/:slug/help", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "help-center.html"));
});

app.get("/store/:slug", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "store.html"));
});

app.get("/cart", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "cart.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

/*
 * =========================================
 * Register page
 * =========================================
 */

app.get("/register", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});

/*
 * =========================================
 * 404 page
 *
 * Reached only when no API route, static file or page route above matched.
 * /api/* never gets here (it already returned the JSON 404 above). Only
 * GET/HEAD navigations get the HTML page; other methods keep Express's
 * default handling.
 * =========================================
 */

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"), (err) => {
    if (err && !res.headersSent) {
      res.status(404).type("text/plain").send("Page not found");
    }
  });
});

/*
 * =========================================
 * Unknown routes + error handler
 *
 * Non-GET/HEAD requests that matched nothing (and are not under /api, which
 * already returned a JSON 404) get the same JSON 404 envelope instead of
 * Express's default HTML page. The error handler (utils/http_errors.js) maps
 * client-side failures to 4xx (malformed JSON 400, too large 413, Mongoose
 * CastError/ValidationError 400, duplicate key 409, JWT 401) and returns a
 * generic 500 for everything else. The client never receives error.message,
 * stack traces or driver internals.
 * =========================================
 */

app.use(not_found_handler);

app.use(error_handler);

/*
 * =========================================
 * Start Server
 * =========================================
 */

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

/*
 * =========================================
 * Graceful shutdown
 *
 * Important with PM2 (especially in cluster mode and during every
 * reload/restart). The logic lives in utils/graceful_shutdown.js: it is
 * idempotent (a repeated signal never starts a second shutdown), bounded by a
 * hard timer, and closes HTTP, Socket.IO (+ its Redis adapter clients),
 * MongoDB and the shared Redis client. ecosystem.config.js sets PM2's
 * kill_timeout above that timer so PM2 does not SIGKILL the worker mid-way.
 * =========================================
 */

const SHUTDOWN_TIMEOUT_MS = 10000;

const gracefulShutdown = create_graceful_shutdown({
  server,
  io,
  mongoose,
  close_redis: () => redis.closeRedis(),
  extra_closers: adapterClients.map((client, index) => ({
    name: `Socket.IO Redis adapter client ${index + 1}`,
    close: async () => {
      try {
        await client.quit();
      } catch (_) {
        client.disconnect();
      }
    },
  })),
  before_close: () => clearInterval(connectionAttemptsSweeper),
  timeout_ms: SHUTDOWN_TIMEOUT_MS,
});

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Request-level failures never reach these handlers: every controller has its
// own try/catch and utils/async_safe.js forwards any rejected route promise to
// the error handler. What arrives here is a failure outside any request (a
// stray background promise, a bug in a timer/event callback). Its effect on
// the process state is unknown, so - like Node's own default since v15 - it is
// treated as fatal, but NOT abruptly: in-flight requests are drained and every
// connection is closed (bounded by the same hard timer) before exiting with a
// non-zero code, and PM2 restarts the worker. gracefulShutdown() is
// idempotent, so a failure that happens while shutting down cannot recurse or
// start a second cleanup; it only makes the final exit code non-zero.
function fatal(label, error) {
  try {
    const detail = process.env.NODE_ENV !== "production" && error && error.stack
      ? error.stack
      : error && error.message ? error.message : String(error);
    console.error(`${label}:`, redact(detail));
  } catch (_) { /* logging must not throw */ }
  try {
    gracefulShutdown(label, 1);
  } catch (_) {
    process.exit(1);
  }
}
process.on("unhandledRejection", (reason) => fatal("Unhandled promise rejection", reason));
process.on("uncaughtException", (error) => fatal("Uncaught exception", error));
