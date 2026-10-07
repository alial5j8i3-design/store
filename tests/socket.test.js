"use strict";

const assert = require("assert");
const WebSocket = require("ws");
const socketIo = require("socket.io");
const { bootServer, createRunner } = require("./security_harness");
const events = require("../utils/socket_events");

const { test, section, finish } = createRunner("socket");
const id = (value) => String(value);
let capturedIo;
const RealServer = socketIo.Server;
socketIo.Server = class CapturingServer extends RealServer {
    constructor(...args) { super(...args); capturedIo = this; }
};

function connect(base, { cookie, origin = "http://localhost" } = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(base.replace("http", "ws") + "/socket.io/?EIO=4&transport=websocket", {
            headers: cookie ? { Cookie: cookie } : {}, origin,
        });
        const messages = [];
        const timeout = setTimeout(() => { ws.terminate(); reject(new Error("socket connection timed out")); }, 2000);
        ws.on("message", (raw) => {
            const message = raw.toString();
            messages.push(message);
            if (message.startsWith("0")) ws.send("40");
            if (message.startsWith("40")) {
                clearTimeout(timeout);
                resolve({ ws, messages });
            }
        });
        ws.on("unexpected-response", (_req, response) => {
            clearTimeout(timeout);
            reject(new Error(`unexpected response ${response.statusCode}`));
        });
        ws.on("error", (error) => { clearTimeout(timeout); reject(error); });
    });
}

const waitForSocket = async (matches = () => true) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const socket = [...capturedIo.sockets.sockets.values()].find(matches);
        if (socket) return socket;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Socket.IO did not register the connected socket");
};

(async () => {
    const h = await bootServer();
    const user = h.mkUser("SocketUser", "user");
    const seller = h.mkUser("SocketSeller", "seller");
    const admin = h.mkUser("SocketAdmin", "super_admin");

    section("handshake authentication and origin policy");
    await test("a valid token connects and is associated with its current account", async () => {
        const connection = await connect(h.base, { cookie: h.cookieFor(user) });
        const socket = await waitForSocket((candidate) => id(candidate.data.user?._id) === id(user._id));
        assert.strictEqual(id(socket.data.user._id), id(user._id));
        assert.strictEqual(socket.data.user.role, "user");
        assert.ok(connection.messages.every((frame) => !frame.includes("token") && !frame.includes("CorrectHorse1")));
        connection.ws.close();
    });

    await test("expired and missing tokens connect only as guest catalog sessions", async () => {
        const expired = await connect(h.base, { cookie: h.cookieFor(user, {}, { expiresIn: -1 }) });
        const expiredSocket = await waitForSocket((candidate) => !candidate.data.user);
        assert.strictEqual(expiredSocket.data.user, undefined);
        assert.ok(expiredSocket.rooms.has(events.CATALOG_ROOM));
        expired.ws.close();

        const guest = await connect(h.base);
        const guestSocket = await waitForSocket((candidate) => !candidate.data.user);
        assert.strictEqual(guestSocket.data.user, undefined);
        assert.ok(guestSocket.rooms.has(events.CATALOG_ROOM));
        guest.ws.close();
    });

    await test("an unlisted Origin is rejected before Socket.IO connection", async () => {
        await assert.rejects(connect(h.base, { origin: "https://evil.example" }), /unexpected response 400/);
    });

    section("protected room authorization");
    await test("user and seller sessions receive only their own private rooms, never the admin room", async () => {
        let connection = await connect(h.base, { cookie: h.cookieFor(user) });
        let socket = await waitForSocket((candidate) => id(candidate.data.user?._id) === id(user._id));
        connection.ws.send("42[\"join_admin\"]");
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.ok(socket.rooms.has(events.user_room(user._id)));
        assert.ok(!socket.rooms.has(events.ADMINS_ROOM));
        assert.ok(!socket.rooms.has(events.seller_room(seller._id)));
        connection.ws.close();

        connection = await connect(h.base, { cookie: h.cookieFor(seller) });
        socket = await waitForSocket((candidate) => id(candidate.data.user?._id) === id(seller._id));
        assert.ok(socket.rooms.has(events.user_room(seller._id)));
        assert.ok(socket.rooms.has(events.seller_room(seller._id)));
        assert.ok(!socket.rooms.has(events.ADMINS_ROOM));
        assert.ok(!socket.rooms.has(events.user_room(user._id)));
        connection.ws.close();
    });

    await test("a super admin receives the admin room and role events cannot expose credentials", async () => {
        const connection = await connect(h.base, { cookie: h.cookieFor(admin) });
        const socket = await waitForSocket((candidate) => id(candidate.data.user?._id) === id(admin._id));
        assert.ok(socket.rooms.has(events.ADMINS_ROOM));
        const payload = events.user_role_payload({ _id: admin._id, name: admin.name, role: admin.role, password: "secret", token: "token" });
        assert.deepStrictEqual(payload, { _id: id(admin._id), name: admin.name, role: "super_admin" });
        connection.ws.close();
    });

    section("logout behavior");
    await test("logout disconnects the currently authenticated private socket but does not revoke a copied JWT", async () => {
        const cookie = h.cookieFor(user);
        const connection = await connect(h.base, { cookie });
        const closed = new Promise((resolve) => connection.ws.once("close", resolve));
        const response = await h.call("POST", "/api/auth/log_out", { cookie });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.success, true);
        await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("socket stayed connected after logout")), 1000))]);
        const copiedCookieSession = await connect(h.base, { cookie });
        const copiedSocket = await waitForSocket((candidate) => id(candidate.data.user?._id) === id(user._id));
        assert.strictEqual(id(copiedSocket.data.user._id), id(user._id));
        copiedCookieSession.ws.close();
    });

    await h.stop();
    process.exitCode = finish();
})();
