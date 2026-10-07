/*
 * Graceful shutdown (LOGIC-09), extracted from server.js so it is testable
 * without booting the whole application.
 *
 * Order (kept from the previous implementation, plus the missing steps):
 *   1. stop accepting new connections / requests   (io.close() also closes the
 *      HTTP server, and disconnects WebSocket clients which would otherwise
 *      keep server.close() waiting forever)
 *   2. wait for in-flight HTTP requests to drain (idle keep-alive sockets are
 *      dropped immediately)
 *   3. Socket.IO Redis adapter pub/sub clients   (were never closed before)
 *   4. MongoDB
 *   5. shared Redis client (cache / rate limit)
 *   6. exit
 *
 * Safety properties:
 *   - idempotent: a second signal (PM2 can send SIGINT then SIGTERM) never
 *     starts a second shutdown. A later FATAL trigger (uncaughtException /
 *     unhandledRejection arriving while a clean SIGTERM shutdown is already
 *     running) only upgrades the final exit code to non-zero;
 *   - keep-alive connections cannot stall the drain: responses written during
 *     shutdown carry `Connection: close` and idle sockets are swept every
 *     IDLE_SWEEP_INTERVAL_MS (server.close() alone waits for them to time out
 *     on Node 18);
 *   - bounded: a hard timer forces exit(1) if a step hangs;
 *   - one failing step never prevents the following steps.
 */

const DEFAULT_TIMEOUT_MS = 10000;
const IDLE_SWEEP_INTERVAL_MS = 250;
// WebSocket (upgraded) sockets are detached from the HTTP server, so neither
// closeIdleConnections() nor server.close() touches them. Socket.IO asks them to
// close politely; a client that never answers the close frame is destroyed
// after this grace so it cannot hold the drain until the hard timer.
const UPGRADED_SOCKET_GRACE_MS = 2000;

function create_graceful_shutdown({
    server,
    io,
    mongoose,
    close_redis,
    extra_closers = [],
    before_close,
    timeout_ms = DEFAULT_TIMEOUT_MS,
    exit = (code) => process.exit(code),
    log = console,
}) {
    let in_progress = null;
    let final_exit_code = 0;

    const upgraded_sockets = new Set();
    if (server && typeof server.on === "function") {
        server.on("upgrade", (_req, socket) => {
            upgraded_sockets.add(socket);
            socket.once("close", () => upgraded_sockets.delete(socket));
        });
    }

    function wait_for_http_close() {
        return new Promise((resolve) => {
            if (!server || !server.listening) return resolve();
            server.once("close", resolve);
        });
    }

    async function step(name, fn) {
        try {
            await fn();
            log.log(`${name} closed`);
        } catch (err) {
            log.error(`Error closing ${name}:`, err && err.message ? err.message : err);
        }
    }

    async function run(signal) {
        log.log(`${signal} received: closing server gracefully...`);

        const force_timer = setTimeout(() => {
            log.error(`Graceful shutdown exceeded ${timeout_ms}ms - forcing exit`);
            exit(1);
        }, timeout_ms);
        if (typeof force_timer.unref === "function") force_timer.unref();

        let idle_sweeper = null;
        let upgraded_timer = null;
        try {
            try {
                if (before_close) before_close();
            } catch (err) {
                log.error("before_close failed:", err && err.message ? err.message : err);
            }

            // Requests that are still being answered must not keep their
            // connection open afterwards.
            if (server && typeof server.on === "function") {
                server.on("request", (_req, res) => { res.shouldKeepAlive = false; });
            }

            const http_closed = wait_for_http_close();

            // Stops accepting + disconnects WebSocket clients + closes the HTTP server.
            try {
                if (io && typeof io.close === "function") {
                    const result = io.close(() => {});
                    if (result && typeof result.catch === "function") result.catch(() => {});
                } else if (server && server.listening) {
                    server.close();
                }
            } catch (err) {
                log.error("Error closing Socket.IO:", err && err.message ? err.message : err);
            }

            if (server && typeof server.closeIdleConnections === "function") {
                server.closeIdleConnections();
                idle_sweeper = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_INTERVAL_MS);
                if (typeof idle_sweeper.unref === "function") idle_sweeper.unref();
            }

            upgraded_timer = setTimeout(() => {
                for (const socket of upgraded_sockets) socket.destroy();
            }, UPGRADED_SOCKET_GRACE_MS);
            if (typeof upgraded_timer.unref === "function") upgraded_timer.unref();

            await http_closed; // in-flight requests finish; the force timer bounds the wait
            if (idle_sweeper) clearInterval(idle_sweeper);
            if (upgraded_timer) clearTimeout(upgraded_timer);
            log.log("HTTP server closed");

            for (const closer of extra_closers) {
                await step(closer.name, closer.close);
            }
            if (mongoose && mongoose.connection) {
                await step("MongoDB connection", () => mongoose.connection.close(true));
            }
            if (close_redis) await step("Redis connection", close_redis);
        } catch (err) {
            // Never leave the process hanging because a cleanup step threw.
            log.error("Unexpected shutdown error:", err && err.message ? err.message : err);
            final_exit_code = final_exit_code || 1;
        } finally {
            if (idle_sweeper) clearInterval(idle_sweeper);
            clearTimeout(force_timer);
            exit(final_exit_code);
        }
    }

    return function shutdown(signal, exit_code = 0) {
        if (exit_code) final_exit_code = exit_code;
        if (in_progress) {
            log.log(`${signal} received while shutdown is already in progress - ignored`);
            return in_progress;
        }
        in_progress = run(signal);
        return in_progress;
    };
}

module.exports = { create_graceful_shutdown, DEFAULT_TIMEOUT_MS };