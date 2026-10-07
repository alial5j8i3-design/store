const mongoose = require("mongoose");

/*
 * MongoDB multi-document transactions need a replica set (or a sharded
 * cluster). A standalone mongod - the usual local/dev setup - rejects them.
 *
 * runInTransaction() therefore never assumes they exist:
 *
 *   - it uses a transaction ONLY when the current connection's topology is
 *     known to support one;
 *   - if the server still answers "transactions are not supported", it reports
 *     { used: false } so the caller runs its own fallback path (the
 *     `stock_restored` marker flow in utils/order_stock.js). That error is
 *     raised by the very first operation of the transaction, before anything
 *     was written, so falling back cannot apply anything twice;
 *   - every other error is re-thrown and the transaction is rolled back.
 */

const TRANSACTION_TOPOLOGIES = new Set(["ReplicaSetWithPrimary", "Sharded", "LoadBalanced"]);

function transactionsAvailable(connection = mongoose.connection) {
  try {
    if (!connection || connection.readyState !== 1) return false;
    const client = typeof connection.getClient === "function" ? connection.getClient() : connection.client;
    const type = client?.topology?.description?.type;
    // Unknown topology -> do not risk it, the fallback is always safe.
    return typeof type === "string" && TRANSACTION_TOPOLOGIES.has(type);
  } catch (_) {
    return false;
  }
}

function isTransactionUnsupportedError(error) {
  const message = String(error?.message || "");
  if (/Transaction numbers are only allowed|does not support transactions|transactions? (is|are) not supported/i.test(message)) {
    return true;
  }
  return (error?.code === 20 || error?.codeName === "IllegalOperation") && /transaction/i.test(message);
}

/*
 * work(session) must perform ALL its writes with { session } and must not have
 * side effects outside the database (the callback can be re-run by the driver
 * on a transient transaction error; the aborted attempt is rolled back).
 *
 * Returns { used: true, value } when the transaction committed, or
 * { used: false } when the caller has to use its fallback.
 */
async function runInTransaction(work) {
  if (!transactionsAvailable()) return { used: false };

  let session;
  try {
    session = await mongoose.startSession();
    let value;
    await session.withTransaction(
      async () => {
        value = await work(session);
      },
      { writeConcern: { w: "majority" } },
    );
    return { used: true, value };
  } catch (error) {
    if (isTransactionUnsupportedError(error)) return { used: false, unsupported: true };
    throw error;
  } finally {
    if (session) {
      try {
        await session.endSession();
      } catch (_) {
        /* nothing to do: the session is gone either way */
      }
    }
  }
}

module.exports = { runInTransaction, transactionsAvailable, isTransactionUnsupportedError };