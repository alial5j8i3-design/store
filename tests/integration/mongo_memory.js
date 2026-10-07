// Starts a real mongod via mongodb-memory-server and connects Mongoose to it.
// If the mongod binary cannot be obtained/started (offline CI, blocked download, unsupported OS)
// it throws an error with code "MONGOD_UNAVAILABLE" so callers can SKIP LOUDLY instead of faking a pass.
const mongoose = require("mongoose");

async function startMemoryMongo() {
    let MongoMemoryServer;
    try {
        ({ MongoMemoryServer } = require("mongodb-memory-server"));
    } catch (e) {
        const err = new Error(`mongodb-memory-server is not installed: ${e.message}`);
        err.code = "MONGOD_UNAVAILABLE";
        throw err;
    }
    let server;
    try {
        server = await MongoMemoryServer.create();
    } catch (e) {
        const err = new Error(`could not start mongod: ${String(e.message).split("\n")[0]}`);
        err.code = "MONGOD_UNAVAILABLE";
        throw err;
    }
    await mongoose.connect(server.getUri("phase1_integration"));
    return {
        mongoose,
        async clear() {
            const { collections } = mongoose.connection;
            await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
        },
        async stop() {
            await mongoose.disconnect();
            await server.stop();
        },
    };
}

module.exports = { startMemoryMongo };