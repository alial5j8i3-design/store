// Shared harness for the authentication / security suites
// (tests/auth_flows.test.js, tests/security_vulnerabilities.test.js).
//
// What is REAL:  server.js itself (helmet, compression, rate limiters,
//   cookie-parser, express.urlencoded({extended:true}), express.json,
//   express-mongo-sanitize, every router, every auth middleware, every
//   controller, the shared error handler) and utils/jwt.js, bcrypt,
//   jsonwebtoken. Requests go over a real TCP socket with fetch().
// What is FAKED: only the Mongoose models (in-memory, from
//   tests/phase1/mock_models.js, which loads the REAL schemas so casting /
//   enum / required rules match) and the cache layer. No MongoDB or Redis is
//   reachable in the environment these were written in, so NOTHING here proves
//   real-MongoDB behaviour (index enforcement, real query-operator semantics).
//
// Options:
//   sanitize:false  replaces express-mongo-sanitize with a pass-through so the
//                   suites can prove the controllers/validators defend
//                   themselves without relying on that single middleware.

"use strict";

const path = require("path");
const crypto = require("crypto");
const http = require("http");

const PROJECT = path.join(__dirname, "..");
const { makeFakeModel, realSchema, ObjectId } = require("./phase1/mock_models");

const PASSWORD = "CorrectHorse1";
const SETUP_TOKEN = "setup-" + crypto.randomBytes(12).toString("hex");

function inject(rel, exportsValue) {
    const abs = require.resolve(path.join(PROJECT, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsValue };
}

let ipCounter = 0;
const freshIp = () => {
    ipCounter += 1;
    return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

function silenceConsole() {
    if (process.env.SECURITY_TEST_VERBOSE === "1") return;
    for (const level of ["log", "info", "warn", "debug"]) console[level] = () => {};
}

async function bootServer({ sanitize = true } = {}) {
    // ---- environment (set BEFORE server.js / dotenv run; dotenv never overrides) ----
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
    process.env.MONGO_URL = "mongodb://127.0.0.1:1/never_connected";
    process.env.REDIS_URL = "";
    process.env.PORT = "0";
    process.env.STORE_URL = "http://localhost";
    process.env.ALLOWED_IMAGE_HOSTS = "img.test";
    process.env.SUPER_ADMIN_SETUP_TOKEN = SETUP_TOKEN;
    delete process.env.JWT_EXPIRES_IN;
    delete process.env.ENFORCE_ORIGIN_CHECK;
    silenceConsole();

    // ---- fake models over the REAL schemas ----
    const users = makeFakeModel("user", { uniqueFields: ["email"], schema: realSchema("users") });
    const store = makeFakeModel("store", { uniqueFields: ["owner_id", "slug"], schema: realSchema("store") });
    const products = makeFakeModel("products", { requiredFields: ["seller_id", "store_id", "quantity", "section"], schema: realSchema("products") });
    const coupons = makeFakeModel("coupon", { uniqueFields: ["name"], schema: realSchema("coupon") });
    const orders = makeFakeModel("order", { uniqueFields: ["orderNumber"], schema: realSchema("order") });
    const ticketReal = realSchema("ticket");
    const tickets = makeFakeModel("ticket", { schema: ticketReal });
    tickets.ISSUE_TYPES = ticketReal.ISSUE_TYPES;
    tickets.STATUSES = ticketReal.STATUSES;
    const sections = makeFakeModel("section", { schema: realSchema("section") });
    const promotion = makeFakeModel("promotion_request", { uniqueFields: ["user_id"], schema: realSchema("Promotion_requests_for_salesperson") });
    const archive = makeFakeModel("order_archive", {});

    // Mongoose casts on assignment (order.user_id is a String path); the fake only
    // casts in the constructor. Imitate set-time casting + schema defaults so
    // documents built with `new Model(); doc.x = ...` behave like the real thing.
    const orderSave = orders.prototype.save;
    orders.prototype.save = async function save() {
        if (this.user_id !== undefined && this.user_id !== null) this.user_id = String(this.user_id);
        if (!this.status) this.status = "new";
        const now = new Date();
        if (!this.createdAt) this.createdAt = now;
        this.updatedAt = now;
        return orderSave.call(this);
    };
    const ticketSave = tickets.prototype.save;
    tickets.prototype.save = async function save() {
        if (!this.status) this.status = "new";
        if (!this.createdAt) this.createdAt = new Date();
        return ticketSave.call(this);
    };

    // Not implemented by the shared fake; trivial and needed by the admin list routes.
    for (const m of [users, store, products, coupons, orders, tickets, sections, promotion, archive]) {
        m.estimatedDocumentCount = async () => m.__docs.length;
    }

    const cache = {
        get: async () => null, set: async () => true, del: async () => {},
        delByPrefix: async () => {}, flushAll: async () => {},
    };

    inject("models/users.js", users);
    inject("models/store.js", store);
    inject("models/products.js", products);
    inject("models/coupon.js", coupons);
    inject("models/order.js", orders);
    inject("models/ticket.js", tickets);
    inject("models/section.js", sections);
    inject("models/Promotion_requests_for_salesperson.js", promotion);
    inject("models/order_archive.js", archive);
    inject("utils/cache.js", cache);

    if (!sanitize) {
        const abs = require.resolve("express-mongo-sanitize", { paths: [PROJECT] });
        require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: () => (req, res, next) => next() };
    }

    // ---- no database connection, capture the HTTP server server.js creates ----
    const mongoose = require("mongoose");
    mongoose.connect = async () => mongoose;

    let captured = null;
    const realCreateServer = http.createServer;
    http.createServer = function createServer(...args) {
        captured = realCreateServer.apply(this, args);
        return captured;
    };
    require(path.join(PROJECT, "server.js"));
    http.createServer = realCreateServer;
    if (!captured) throw new Error("server.js did not create an HTTP server");
    if (!captured.listening) await new Promise((resolve) => captured.once("listening", resolve));
    const base = `http://127.0.0.1:${captured.address().port}`;

    const jwt = require("jsonwebtoken");
    const bcrypt = require("bcrypt");
    const passwordHash = bcrypt.hashSync(PASSWORD, 4);
    const secret = process.env.JWT_SECRET;

    const models = { users, store, products, coupons, orders, tickets, sections, promotion, archive };

    function mkUser(name, role = "user", extra = {}) {
        const u = {
            _id: new ObjectId(),
            name,
            email: `${name.toLowerCase()}@t.test`,
            password: passwordHash,
            role,
            phone_number: "+20 100 123 4567",
            whatsApp_number: "+20 100 123 4567",
            GPS_URL: "https://maps.example.com/place",
            ...extra,
        };
        users.__seed([u]);
        return u;
    }

    const signFor = (user, payload = {}, options = {}) =>
        jwt.sign({ id: String(user._id), ...payload }, secret, { algorithm: "HS256", expiresIn: 3600, ...options });
    const cookieFor = (user, payload, options) => `token=${signFor(user, payload, options)}`;

    // body: object -> JSON. rawBody: string sent as-is. form: object -> urlencoded
    // string (already encoded, so tests can write `email[$ne]=x`).
    async function call(method, url, { as, cookie, body, rawBody, form, headers = {}, ip } = {}) {
        const h = { "X-Forwarded-For": ip || freshIp(), ...headers };
        if (as) h.Cookie = cookieFor(as);
        if (cookie) h.Cookie = cookie;
        let payload;
        if (rawBody !== undefined) {
            payload = rawBody;
            h["Content-Type"] = h["Content-Type"] || "application/json";
        } else if (form !== undefined) {
            payload = form;
            h["Content-Type"] = "application/x-www-form-urlencoded";
        } else if (body !== undefined) {
            payload = JSON.stringify(body);
            h["Content-Type"] = "application/json";
        }
        const response = await fetch(base + url, { method, headers: h, body: payload });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        return {
            status: response.status,
            body: json,
            text,
            headers: response.headers,
            setCookie: response.headers.getSetCookie ? response.headers.getSetCookie() : [],
        };
    }

    const reset = () => { for (const m of Object.values(models)) m.__docs.length = 0; };

    return {
        base, models, mkUser, signFor, cookieFor, call, reset, jwt, secret, PASSWORD,
        SETUP_TOKEN, ObjectId, freshIp,
        findUser: (email) => users.__docs.find((d) => d.email === email),
        stop: () => new Promise((resolve) => captured.close(() => resolve())),
    };
}

// Minimal runner in the same style as tests/phase1/*.test.js.
function createRunner(label) {
    let passed = 0;
    const failures = [];
    const out = (line) => process.stdout.write(line + "\n");
    return {
        out,
        section: (title) => out(`\n=== ${title} ===`),
        async test(name, fn) {
            try { await fn(); out(`  PASS - ${name}`); passed += 1; }
            catch (error) {
                out(`  FAIL - ${name}\n         ${String(error.message).split("\n").join("\n         ")}`);
                failures.push(name);
            }
        },
        finish() {
            out(`\n${label}: ${passed} passed, ${failures.length} failed`);
            if (failures.length) {
                out("Failed:");
                failures.forEach((f) => out(`  - ${f}`));
            }
            return failures.length;
        },
    };
}

module.exports = { bootServer, createRunner, PASSWORD, SETUP_TOKEN, ObjectId };
