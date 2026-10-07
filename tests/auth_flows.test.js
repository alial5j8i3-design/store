// Authentication flow tests (Task 5).
//
//   node tests/auth_flows.test.js
//
// Boots the REAL server.js (all middleware, routers, controllers) over HTTP with
// in-memory fake Mongoose models - see tests/support/security_harness.js for
// exactly what is real and what is faked. Nothing here proves real-MongoDB
// behaviour. Security expectations are NOT relaxed to match current behaviour:
// a FAIL is a reported defect.

"use strict";

const assert = require("assert");
const crypto = require("crypto");
const { bootServer, createRunner, PASSWORD, SETUP_TOKEN } = require("./support/security_harness");

const { test, section, finish, out } = createRunner("auth_flows");

const eq = (actual, expected, message) => assert.strictEqual(actual, expected, message);
const b64u = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

// Hand-built JWT so tests can use algorithms jsonwebtoken's sign() refuses or
// that an attacker would try (alg none, HS384/HS512, RS256 confusion ...).
function forgeJwt(alg, payload, hmacSecret, { signature } = {}) {
    const data = `${b64u({ alg, typ: "JWT" })}.${b64u(payload)}`;
    let sig = signature;
    if (sig === undefined) {
        sig = /^HS(256|384|512)$/.test(alg)
            ? crypto.createHmac(`sha${alg.slice(2)}`, hmacSecret).update(data).digest("base64url")
            : "";
    }
    return `${data}.${sig}`;
}

(async () => {
    const h = await bootServer();
    const { call, models } = h;

    let counter = 0;
    const uniqueEmail = () => `new.user.${Date.now()}.${++counter}@t.test`;
    const validRegistration = (overrides = {}) => ({
        name: "Valid User",
        email: uniqueEmail(),
        password: "Passw0rd!!",
        phone_number: "+20 100 123 4567",
        whatsApp_number: "+20 100 123 4567",
        GPS_URL: "https://maps.example.com/place",
        ...overrides,
    });
    const userCount = () => models.users.__docs.length;
    const isClientError = (r) => r.status >= 400 && r.status < 500;
    const rejected = (r, label) => {
        assert.ok(isClientError(r), `${label}: expected 4xx, got ${r.status} ${r.text.slice(0, 120)}`);
        assert.notStrictEqual(r.status, 429, `${label}: got rate-limited (429), the validation was never reached`);
        assert.ok(!r.setCookie.some((c) => /^token=[^;]+/.test(c)), `${label}: a session cookie was issued`);
    };

    // =====================================================================
    section("Registration: missing required fields");
    // =====================================================================
    for (const field of ["name", "email", "password", "phone_number", "whatsApp_number", "GPS_URL"]) {
        await test(`missing ${field} -> 400, nothing stored`, async () => {
            const before = userCount();
            const body = validRegistration();
            delete body[field];
            const r = await call("POST", "/api/auth/register", { body });
            eq(r.status, 400, r.text);
            rejected(r, field);
            eq(userCount(), before, "a user was created");
        });
    }
    await test("empty JSON object / empty string fields / whitespace-only name -> 400", async () => {
        const before = userCount();
        rejected(await call("POST", "/api/auth/register", { body: {} }), "empty");
        eq((await call("POST", "/api/auth/register", { body: {} })).status, 400);
        eq((await call("POST", "/api/auth/register", { body: validRegistration({ name: "   " }) })).status, 400);
        eq((await call("POST", "/api/auth/register", { body: validRegistration({ GPS_URL: "" }) })).status, 400);
        eq(userCount(), before);
    });
    await test("no body at all / wrong content type -> 400", async () => {
        const before = userCount();
        eq((await call("POST", "/api/auth/register")).status, 400);
        const r = await call("POST", "/api/auth/register", { rawBody: "name=x", headers: { "Content-Type": "text/plain" } });
        eq(r.status, 400);
        eq(userCount(), before);
    });
    await test("malformed JSON -> 400 with a generic message (no stack / parser internals)", async () => {
        const r = await call("POST", "/api/auth/register", { rawBody: '{"name": "x", ' });
        eq(r.status, 400);
        assert.ok(!/SyntaxError|node_modules|at .*\(.*:\d+:\d+\)/.test(r.text), `leaks internals: ${r.text}`);
    });

    // =====================================================================
    section("Registration: javascript: / non-http GPS_URL");
    // =====================================================================
    const badUrls = [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(document.cookie)",
        "  javascript:alert(1)  ",
        "\tjavascript:alert(1)",
        "java\nscript:alert(1)",
        "javascript://%0Aalert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "ftp://files.example.com/x",
        "//evil.example.com/x",
        "not a url at all",
    ];
    for (const url of badUrls) {
        await test(`GPS_URL ${JSON.stringify(url)} -> 400`, async () => {
            const before = userCount();
            const r = await call("POST", "/api/auth/register", { body: validRegistration({ GPS_URL: url }) });
            eq(r.status, 400, r.text);
            rejected(r, "GPS_URL");
            eq(userCount(), before, "user with unsafe GPS_URL was stored");
        });
    }
    await test("GPS_URL longer than 500 characters -> 400", async () => {
        const r = await call("POST", "/api/auth/register", { body: validRegistration({ GPS_URL: "https://maps.example.com/" + "a".repeat(600) }) });
        eq(r.status, 400, r.text);
    });
    await test("GPS_URL non-string (object / array / number) -> 400", async () => {
        for (const GPS_URL of [{ $ne: 1 }, ["https://a.test"], 12345, true]) {
            const r = await call("POST", "/api/auth/register", { body: validRegistration({ GPS_URL }) });
            eq(r.status, 400, `${JSON.stringify(GPS_URL)} -> ${r.status} ${r.text}`);
        }
    });

    // =====================================================================
    section("Registration: excessively long / malformed fields");
    // =====================================================================
    await test("name of 101 characters -> 400", async () => {
        const before = userCount();
        const r = await call("POST", "/api/auth/register", { body: validRegistration({ name: "a".repeat(101) }) });
        eq(r.status, 400, r.text);
        eq(userCount(), before);
    });
    await test("name of 10,000 characters -> 400", async () => {
        const r = await call("POST", "/api/auth/register", { body: validRegistration({ name: "a".repeat(10000) }) });
        eq(r.status, 400, r.text);
    });
    await test("name of ~300 KB (over the JSON body limit) -> 413, not 500", async () => {
        const r = await call("POST", "/api/auth/register", { body: validRegistration({ name: "a".repeat(300 * 1024) }) });
        eq(r.status, 413, `${r.status} ${r.text.slice(0, 100)}`);
    });
    await test("boundary: name of exactly 100 characters is accepted (validator is not over-strict)", async () => {
        const r = await call("POST", "/api/auth/register", { body: validRegistration({ name: "a".repeat(100) }) });
        eq(r.status, 201, r.text);
    });
    await test("email longer than 254 characters -> 400", async () => {
        const r = await call("POST", "/api/auth/register", { body: validRegistration({ email: `${"a".repeat(245)}@example.com` }) });
        eq(r.status, 400, r.text);
    });
    await test("password shorter than 8 / longer than 128 characters -> 400", async () => {
        eq((await call("POST", "/api/auth/register", { body: validRegistration({ password: "short1!" }) })).status, 400);
        eq((await call("POST", "/api/auth/register", { body: validRegistration({ password: "p".repeat(129) }) })).status, 400);
    });
    await test("non-string name / email / password / phone (object, array, number) -> 400", async () => {
        const before = userCount();
        const values = [{ $ne: 1 }, ["x"], 12345, true, null];
        for (const field of ["name", "email", "password", "phone_number", "whatsApp_number"]) {
            for (const value of values) {
                const r = await call("POST", "/api/auth/register", { body: validRegistration({ [field]: value }) });
                eq(r.status, 400, `${field}=${JSON.stringify(value)} -> ${r.status} ${r.text.slice(0, 100)}`);
            }
        }
        eq(userCount(), before);
    });
    await test("invalid email formats -> 400", async () => {
        for (const email of ["plainaddress", "a@b", "a b@c.de", "@example.com", "a@@example.com", "user@", "user@.com "]) {
            const r = await call("POST", "/api/auth/register", { body: validRegistration({ email }) });
            eq(r.status, 400, `${JSON.stringify(email)} -> ${r.status}`);
        }
    });
    await test("invalid phone / whatsApp numbers -> 400", async () => {
        for (const phone of ["abc", "123", "+++++++++", "1".repeat(21), "12345 <script>"]) {
            eq((await call("POST", "/api/auth/register", { body: validRegistration({ phone_number: phone }) })).status, 400, `phone ${phone}`);
            eq((await call("POST", "/api/auth/register", { body: validRegistration({ whatsApp_number: phone }) })).status, 400, `whatsApp ${phone}`);
        }
    });

    // =====================================================================
    section("Registration: success path and duplicate handling");
    // =====================================================================
    await test("valid registration -> 201, HttpOnly cookie, role=user, password stored hashed, no secrets in response", async () => {
        const body = validRegistration();
        const r = await call("POST", "/api/auth/register", { body });
        eq(r.status, 201, r.text);
        const cookie = r.setCookie.find((c) => c.startsWith("token="));
        assert.ok(cookie, "no token cookie");
        assert.ok(/HttpOnly/i.test(cookie), `cookie is not HttpOnly: ${cookie}`);
        assert.ok(/SameSite=Lax/i.test(cookie), `cookie SameSite is not Lax: ${cookie}`);
        const stored = h.findUser(body.email);
        eq(stored.role, "user");
        assert.notStrictEqual(stored.password, body.password, "password stored in clear text");
        assert.ok(/^\$2[aby]\$/.test(stored.password), "password is not a bcrypt hash");
        assert.ok(!r.text.includes(body.password) && !r.text.includes(stored.password), "response leaks password/hash");
    });
    await test("duplicate e-mail (also with different case / spaces) -> 400 and no second account", async () => {
        const body = validRegistration({ email: "dup.user@t.test" });
        eq((await call("POST", "/api/auth/register", { body })).status, 201);
        const before = userCount();
        const again = await call("POST", "/api/auth/register", { body: { ...body, email: "  DUP.User@T.TEST " } });
        eq(again.status, 400, again.text);
        eq(userCount(), before);
    });
    await test("registration is rate limited per IP (default 4 / 30 min) and the 5th attempt returns 429", async () => {
        const ip = "203.0.113.77";
        let last;
        for (let i = 0; i < 5; i += 1) last = await call("POST", "/api/auth/register", { body: {}, ip });
        eq(last.status, 429, `got ${last.status}`);
    });

    // =====================================================================
    section("Login: public failure behaviour does not reveal account existence");
    // =====================================================================
    h.reset();
    const alice = h.mkUser("Alice", "user");
    const sally = h.mkUser("Sally", "seller");
    const root = h.mkUser("Root", "super_admin");
    const login = (body, extra = {}) => call("POST", "/api/auth/log_in", { body, ...extra });
    const strip = (r) => ({ status: r.status, body: r.body });

    await test("wrong password for an EXISTING account == unknown account (identical status and body)", async () => {
        const known = await login({ email: alice.email, password: "WrongPassword9" });
        const unknown = await login({ email: "nobody.here@t.test", password: "WrongPassword9" });
        eq(known.status, 401);
        assert.deepStrictEqual(strip(known), strip(unknown), "responses differ -> account enumeration oracle");
        rejected(known, "known");
        rejected(unknown, "unknown");
    });
    await test("identical failure for user / seller / super_admin accounts (role is not revealed)", async () => {
        const results = [];
        for (const u of [alice, sally, root]) results.push(strip(await login({ email: u.email, password: "WrongPassword9" })));
        results.push(strip(await login({ email: "ghost@t.test", password: "WrongPassword9" })));
        for (const r of results) assert.deepStrictEqual(r, results[0]);
    });
    await test("out-of-policy password length (<8, >128) gives the same generic 401 for existing and unknown accounts", async () => {
        for (const password of ["short", "x".repeat(129), "x".repeat(5000)]) {
            const known = await login({ email: alice.email, password });
            const unknown = await login({ email: "ghost@t.test", password });
            eq(known.status, 401, `known ${password.length}: ${known.text}`);
            assert.deepStrictEqual(strip(known), strip(unknown));
        }
    });
    await test("missing password / missing email: same 400 whether the e-mail exists or not", async () => {
        const known = await login({ email: alice.email });
        const unknown = await login({ email: "ghost@t.test" });
        eq(known.status, 400);
        assert.deepStrictEqual(strip(known), strip(unknown));
        eq((await login({ password: PASSWORD })).status, 400);
        eq((await login({})).status, 400);
    });
    await test("e-mail casing / surrounding spaces do not change the failure response", async () => {
        const a = await login({ email: alice.email, password: "WrongPassword9" });
        const b = await login({ email: `  ${alice.email.toUpperCase()}  `, password: "WrongPassword9" });
        assert.deepStrictEqual(strip(a), strip(b));
    });
    await test("no timing oracle by early return: unknown e-mail still performs a bcrypt compare", async () => {
        const bcrypt = require("bcrypt");
        const original = bcrypt.compare;
        let calls = 0;
        bcrypt.compare = function patched(...args) { calls += 1; return original.apply(this, args); };
        try {
            await login({ email: "ghost.timing@t.test", password: "WrongPassword9" });
            const unknownCalls = calls;
            calls = 0;
            await login({ email: alice.email, password: "WrongPassword9" });
            eq(unknownCalls, 1, "unknown account must pay for exactly one compare");
            eq(calls, unknownCalls, "known-account path performs a different number of compares");
        } finally { bcrypt.compare = original; }
    });
    await test("failed login sets no cookie and the body carries no user data / hash / stack", async () => {
        const r = await login({ email: alice.email, password: "WrongPassword9" });
        eq(r.setCookie.length, 0);
        assert.ok(!/\$2[aby]\$|password"\s*:|stack|role|_id/.test(r.text), `unexpected content: ${r.text}`);
    });
    await test("successful login: 200, HttpOnly cookie, JWT carries only the id, no hash in body", async () => {
        const r = await login({ email: alice.email, password: PASSWORD });
        eq(r.status, 200, r.text);
        const cookie = r.setCookie.find((c) => c.startsWith("token="));
        assert.ok(cookie && /HttpOnly/i.test(cookie), `cookie: ${cookie}`);
        const payload = h.jwt.verify(cookie.split(";")[0].slice(6), h.secret, { algorithms: ["HS256"] });
        assert.deepStrictEqual(Object.keys(payload).sort(), ["exp", "iat", "id"], "JWT payload carries extra claims");
        assert.ok(payload.exp - payload.iat > 0);
        assert.ok(!/\$2[aby]\$/.test(r.text));
    });
    await test("brute force: 5 failures from one IP lock that IP out (429) even for the correct password", async () => {
        const ip = "198.51.100.23";
        for (let i = 0; i < 5; i += 1) eq((await login({ email: alice.email, password: "WrongPassword9" }, { ip })).status, 401);
        const locked = await login({ email: alice.email, password: PASSWORD }, { ip });
        eq(locked.status, 429, `got ${locked.status}`);
        eq(locked.setCookie.length, 0, "a locked-out IP must not receive a session");
        eq((await login({ email: alice.email, password: PASSWORD })).status, 200, "other IPs must be unaffected");
    });
    await test("logout clears the session cookie", async () => {
        const r = await call("POST", "/api/auth/log_out", { as: alice });
        assert.ok(r.setCookie.some((c) => /^token=;/.test(c) && /(Expires=Thu, 01 Jan 1970|Max-Age=0)/i.test(c)), `set-cookie: ${r.setCookie}`);
    });

    // =====================================================================
    section("Super admin registration (setup token)");
    // =====================================================================
    const SA = "/api/auth/admin/register_super_admin";
    const adminBody = (o = {}) => ({ name: "Root Admin", email: `root.${Date.now()}.${++counter}@t.test`, password: "Sup3rSecret!!", ...o });
    const superAdmins = () => models.users.__docs.filter((u) => u.role === "super_admin").length;

    await test("valid setup token (header) -> 201, role super_admin, HttpOnly cookie that authenticates as super_admin", async () => {
        h.reset();
        const body = adminBody();
        const r = await call("POST", SA, { body, headers: { "X-Super-Admin-Setup-Token": SETUP_TOKEN } });
        eq(r.status, 201, r.text);
        const cookie = r.setCookie.find((c) => c.startsWith("token="));
        assert.ok(cookie && /HttpOnly/i.test(cookie));
        eq(h.findUser(body.email).role, "super_admin");
        const me = await call("GET", "/api/auth/me", { cookie: cookie.split(";")[0] });
        eq(me.status, 200);
        eq(me.body.user.role, "super_admin");
        assert.ok(!r.text.includes(SETUP_TOKEN), "setup token echoed in response");
    });
    await test("valid setup token (body.setup_token) -> 201", async () => {
        h.reset();
        const r = await call("POST", SA, { body: { ...adminBody(), setup_token: SETUP_TOKEN } });
        eq(r.status, 201, r.text);
        eq(superAdmins(), 1);
    });
    await test("a second super admin is refused even with the valid token (400)", async () => {
        const r = await call("POST", SA, { body: adminBody(), headers: { "X-Super-Admin-Setup-Token": SETUP_TOKEN } });
        eq(r.status, 400, r.text);
        eq(superAdmins(), 1);
    });
    h.reset();
    const wrongTokens = {
        "completely wrong": "not-the-token",
        "same length, one character different": SETUP_TOKEN.slice(0, -1) + (SETUP_TOKEN.endsWith("a") ? "b" : "a"),
        "prefix of the real token": SETUP_TOKEN.slice(0, 10),
        "real token + extra character": SETUP_TOKEN + "x",
        "real token with trailing space": SETUP_TOKEN + " ",
        "real token upper-cased": SETUP_TOKEN.toUpperCase(),
    };
    for (const [label, token] of Object.entries(wrongTokens)) {
        await test(`invalid setup token (${label}) -> 403, nothing created, no cookie`, async () => {
            h.reset();
            // HTTP strips leading/trailing whitespace from header values, so a
            // trailing-space token can only be tested through the JSON body.
            const modes = label.includes("trailing space") ? ["body"] : ["header", "body"];
            for (const mode of modes) {
                const r = await call("POST", SA, mode === "header"
                    ? { body: adminBody(), headers: { "X-Super-Admin-Setup-Token": token } }
                    : { body: { ...adminBody(), setup_token: token } });
                eq(r.status, 403, `${mode}: ${r.status} ${r.text}`);
                eq(r.setCookie.length, 0);
                eq(superAdmins(), 0, "a super admin was created with a wrong token");
            }
        });
    }
    await test("missing setup token (no header, no body field) -> 403, nothing created", async () => {
        h.reset();
        const r = await call("POST", SA, { body: adminBody() });
        eq(r.status, 403, r.text);
        eq(r.setCookie.length, 0);
        eq(superAdmins(), 0);
    });
    await test("empty setup token (header '' / body '') -> 403", async () => {
        h.reset();
        eq((await call("POST", SA, { body: adminBody(), headers: { "X-Super-Admin-Setup-Token": "" } })).status, 403);
        eq((await call("POST", SA, { body: { ...adminBody(), setup_token: "" } })).status, 403);
        eq(superAdmins(), 0);
    });
    await test("non-string setup_token (object / array / number / boolean / operator) -> 403", async () => {
        h.reset();
        for (const setup_token of [{ $ne: 1 }, { $gt: "" }, [SETUP_TOKEN], 1, true, null]) {
            const r = await call("POST", SA, { body: { ...adminBody(), setup_token } });
            eq(r.status, 403, `${JSON.stringify(setup_token)} -> ${r.status} ${r.text}`);
        }
        eq(superAdmins(), 0);
    });
    await test("the setup token in the URL query string is NOT accepted (it would leak into logs)", async () => {
        h.reset();
        const r = await call("POST", `${SA}?setup_token=${encodeURIComponent(SETUP_TOKEN)}`, { body: adminBody() });
        eq(r.status, 403, r.text);
        eq(superAdmins(), 0);
    });
    await test("valid token but invalid payload (missing fields, bad e-mail, short password) -> 400, nothing created", async () => {
        h.reset();
        const headers = { "X-Super-Admin-Setup-Token": SETUP_TOKEN };
        const bad = [{}, adminBody({ name: "" }), adminBody({ email: "" }), adminBody({ email: "not-an-email" }),
            adminBody({ password: "short" }), adminBody({ password: "x".repeat(129) }),
            adminBody({ name: { $ne: 1 } }), adminBody({ email: { $ne: 1 } }), adminBody({ password: { $ne: 1 } })];
        for (const body of bad) {
            const r = await call("POST", SA, { body, headers });
            eq(r.status, 400, `${JSON.stringify(body).slice(0, 80)} -> ${r.status} ${r.text}`);
        }
        eq(superAdmins(), 0);
    });
    await test("when SUPER_ADMIN_SETUP_TOKEN is not configured, no token (incl. '' / 'undefined') works (403)", async () => {
        h.reset();
        const saved = process.env.SUPER_ADMIN_SETUP_TOKEN;
        delete process.env.SUPER_ADMIN_SETUP_TOKEN;
        try {
            for (const token of ["", "undefined", "null", "true"]) {
                const r = await call("POST", SA, { body: { ...adminBody(), setup_token: token }, headers: { "X-Super-Admin-Setup-Token": token } });
                eq(r.status, 403, `token ${JSON.stringify(token)} -> ${r.status} ${r.text}`);
            }
            eq((await call("POST", SA, { body: adminBody() })).status, 403);
            eq(superAdmins(), 0);
        } finally { process.env.SUPER_ADMIN_SETUP_TOKEN = saved; }
    });
    await test("production without a configured setup token hides the endpoint (404)", async () => {
        h.reset();
        const savedToken = process.env.SUPER_ADMIN_SETUP_TOKEN;
        const savedEnv = process.env.NODE_ENV;
        delete process.env.SUPER_ADMIN_SETUP_TOKEN;
        process.env.NODE_ENV = "production";
        try {
            const r = await call("POST", SA, { body: adminBody() });
            eq(r.status, 404, r.text);
            eq(superAdmins(), 0);
        } finally { process.env.SUPER_ADMIN_SETUP_TOKEN = savedToken; process.env.NODE_ENV = savedEnv; }
    });
    await test("setup-token guessing is rate limited: 5 attempts per IP, the 6th is 429", async () => {
        h.reset();
        const ip = "192.0.2.99";
        let last;
        for (let i = 0; i < 6; i += 1) last = await call("POST", SA, { body: adminBody(), headers: { "X-Super-Admin-Setup-Token": `guess-${i}` }, ip });
        eq(last.status, 429, `got ${last.status}`);
        eq(superAdmins(), 0);
    });

    // =====================================================================
    section("JWT: only HS256 is accepted");
    // =====================================================================
    h.reset();
    const victim = h.mkUser("Victim", "user");
    const sellerU = h.mkUser("SellerU", "seller");
    const adminU = h.mkUser("AdminU", "super_admin");
    const mallory = h.mkUser("Mallory", "user");
    const now = Math.floor(Date.now() / 1000);
    const claims = (user) => ({ id: String(user._id), iat: now, exp: now + 3600 });

    // One protected route per middleware (auth_me controller, auth, auth_seller,
    // auth_super_admin, auth_seller_or_admin).
    const gates = [
        ["GET", "/api/auth/me", victim],
        ["GET", "/api/get_user_orders", victim],
        ["GET", "/api/seller/coupons", sellerU],
        ["GET", "/api/admin/get_all_users", adminU],
        ["DELETE", "/api/seller/delete_product", sellerU, { product_id: String(new h.ObjectId()) }],
    ];

    await test("control: a correctly signed HS256 token is accepted by every gate", async () => {
        for (const [method, url, user, body] of gates) {
            const r = await call(method, url, { as: user, body });
            assert.ok(r.status !== 401 && r.status !== 403, `${method} ${url} -> ${r.status} ${r.text}`);
        }
    });

    const forged = {
        "HS384 signed with the real secret": (u) => forgeJwt("HS384", claims(u), h.secret),
        "HS512 signed with the real secret": (u) => forgeJwt("HS512", claims(u), h.secret),
        "alg none (empty signature)": (u) => forgeJwt("none", claims(u), h.secret, { signature: "" }),
        "alg None / NONE (case variants)": (u) => forgeJwt("None", claims(u), h.secret, { signature: "" }),
        "alg 'none' but with a (valid HS256) signature attached": (u) => {
            const data = `${b64u({ alg: "none", typ: "JWT" })}.${b64u(claims(u))}`;
            return `${data}.${crypto.createHmac("sha256", h.secret).update(data).digest("base64url")}`;
        },
        "RS256 header + HMAC signature made with the secret (key confusion)": (u) => forgeJwt("RS256", claims(u), h.secret, {
            signature: crypto.createHmac("sha256", h.secret).update(`${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(claims(u))}`).digest("base64url"),
        }),
        "ES256 header with garbage signature": (u) => forgeJwt("ES256", claims(u), h.secret, { signature: b64u("x".repeat(64)) }),
        "lower-case alg 'hs256'": (u) => forgeJwt("hs256", claims(u), h.secret, {
            signature: crypto.createHmac("sha256", h.secret).update(`${b64u({ alg: "hs256", typ: "JWT" })}.${b64u(claims(u))}`).digest("base64url"),
        }),
        "HS256 header, payload swapped for another user's id (signature mismatch)": (u) => {
            const good = h.signFor(mallory).split(".");   // genuine token of a DIFFERENT account
            return `${good[0]}.${b64u(claims(u))}.${good[2]}`;
        },
        "HS256 signed with a different secret": (u) => h.jwt.sign(claims(u), "some-other-secret-value-that-is-long-enough", { algorithm: "HS256" }),
        "HS256 but already expired": (u) => h.jwt.sign({ id: String(u._id) }, h.secret, { algorithm: "HS256", expiresIn: -60 }),
        "HS256 but not-before in the future": (u) => h.jwt.sign({ id: String(u._id) }, h.secret, { algorithm: "HS256", notBefore: 3600 }),
    };
    for (const [label, make] of Object.entries(forged)) {
        await test(`rejected on every gate: ${label}`, async () => {
            for (const [method, url, user, body] of gates) {
                // forge the identity of the user the gate actually needs (admin for admin routes ...)
                const r = await call(method, url, { cookie: `token=${make(user)}`, body });
                eq(r.status, 401, `${method} ${url} -> ${r.status} ${r.text}`);
                assert.ok(!/"data":\[\{|"user":\{/.test(r.text), `protected data in a 401 response: ${r.text.slice(0, 120)}`);
            }
        });
    }
    await test("garbage / truncated / empty tokens -> 401", async () => {
        for (const token of ["", "abc", "a.b", "a.b.c", "....", h.signFor(victim).slice(0, -5), `${h.signFor(victim)}.extra`, "Bearer " + h.signFor(victim)]) {
            const r = await call("GET", "/api/auth/me", { cookie: `token=${token}` });
            eq(r.status, 401, `${token.slice(0, 30)} -> ${r.status}`);
        }
    });
    await test("token cookie that cookie-parser decodes to an OBJECT (j:{...}) -> 401, not 500", async () => {
        for (const url of ["/api/auth/me", "/api/get_user_orders", "/api/seller/coupons", "/api/admin/get_all_users"]) {
            const r = await call("GET", url, { cookie: `token=${encodeURIComponent('j:{"$ne":null}')}` });
            eq(r.status, 401, `${url} -> ${r.status} ${r.text}`);
        }
    });
    await test("a token is only accepted from the cookie: Authorization header / query string are ignored", async () => {
        const token = h.signFor(victim);
        eq((await call("GET", "/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
        eq((await call("GET", `/api/auth/me?token=${token}`)).status, 401);
    });
    await test("token without an id claim, or with a non-ObjectId id -> 401", async () => {
        for (const payload of [{}, { sub: String(victim._id) }, { id: "" }, { id: "not-an-object-id" }, { id: {} }, { id: [] }]) {
            const r = await call("GET", "/api/auth/me", { cookie: `token=${h.jwt.sign(payload, h.secret, { algorithm: "HS256", expiresIn: 60 })}` });
            eq(r.status, 401, `${JSON.stringify(payload)} -> ${r.status} ${r.text}`);
        }
    });
    await test("valid token for a user that was deleted -> 401 on every gate", async () => {
        const ghost = { _id: new h.ObjectId() };
        for (const [method, url, , body] of gates) {
            const r = await call(method, url, { as: ghost, body });
            eq(r.status, 401, `${method} ${url} -> ${r.status}`);
        }
    });
    await test("a role claim inside a validly signed token is ignored (role comes from the database)", async () => {
        const escalated = `token=${h.signFor(victim, { role: "super_admin", isAdmin: true })}`;
        const r = await call("GET", "/api/admin/get_all_users", { cookie: escalated });
        eq(r.status, 403, r.text);
        assert.ok(!r.text.includes(adminU.email), "admin data leaked");
    });

    process.exitCode = finish() ? 1 : 0;
    out("(auth_flows ran against fake in-memory models; see tests/support/security_harness.js)");
    process.exit(process.exitCode);
})().catch((error) => {
    process.stdout.write(`auth_flows crashed: ${error.stack}\n`);
    process.exit(1);
});