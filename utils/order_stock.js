const products = require("../models/products");
const cache = require("./cache");

/*
 * Order lifecycle (single source of truth)
 *
 *   new (pending) -> processing -> shipped -> delivered
 *        \              |            |
 *         +-------------+------------+----> cancelled
 *
 * - Stock is reserved (deducted) once, when the order is created
 *   (controller/order.controller.js).
 * - cancelled  -> stock is given back, exactly once:
 *     * transactions available (replica set): the status change and the
 *       stock give-back commit together or not at all;
 *     * otherwise (standalone mongod): the status change also sets
 *       `stock_restored: false` in the same single-document write, the
 *       restoration is then CLAIMED atomically (false -> true) before any
 *       stock is touched, and the marker is removed once it is complete.
 *       A missing marker means nothing is pending (new orders, legacy
 *       orders and fully restored orders all look the same).
 * - delivered  -> NO stock change (it was already deducted at creation).
 * - delivered and cancelled are final states: no further transitions,
 *   so a cancelled order can never be "revived" without re-reserving
 *   stock, and a delivered order can never be cancelled afterwards.
 */

const ALLOWED_STATUSES = ["new", "processing", "shipped", "delivered", "cancelled"];

// Statuses in which the order still "owns" the stock it reserved.
const ACTIVE_STATUSES = ["new", "processing", "shipped"];

const ALLOWED_TRANSITIONS = {
  new: ["processing", "shipped", "delivered", "cancelled"],
  processing: ["shipped", "delivered", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

// All current statuses from which `nextStatus` is a legal move.
// Used inside the atomic DB filter so the check and the update
// can't be separated by a concurrent request.
function previousStatusesFor(nextStatus) {
  return Object.keys(ALLOWED_TRANSITIONS).filter((from) =>
    ALLOWED_TRANSITIONS[from].includes(nextStatus),
  );
}

async function invalidateProductsCache() {
  try {
    await cache.delByPrefix("products");
  } catch (err) {
    console.log(err.message);
  }
}

/*
 * Gives the reserved quantity of every order line back to its product.
 * Lines without a product reference (very old orders) are skipped.
 * A failed write is retried once; anything still failing is returned
 * so the caller can report it instead of silently losing stock.
 */
async function restoreOrderItems(items) {
  let pending = (Array.isArray(items) ? items : []).filter(
    (item) =>
      item &&
      item.product &&
      Number.isInteger(Number(item.quantity)) &&
      Number(item.quantity) > 0,
  );

  for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt++) {
    const results = await Promise.allSettled(
      pending.map((item) =>
        products.updateOne(
          { _id: item.product },
          { $inc: { quantity: Number(item.quantity) } },
        ),
      ),
    );

    pending = pending.filter((_, index) => results[index].status === "rejected");
  }

  if (pending.length > 0) {
    console.error(
      "Stock restore failed for:",
      pending.map((item) => `${item.product} x${item.quantity}`).join(", "),
    );
  }

  // Quantities changed, so cached product lists are stale.
  await invalidateProductsCache();

  return { failed: pending };
}

function restorableItems(items) {
  return (Array.isArray(items) ? items : []).filter(
    (item) =>
      item &&
      item.product &&
      Number.isInteger(Number(item.quantity)) &&
      Number(item.quantity) > 0,
  );
}

/*
 * Transaction flavour of restoreOrderItems(): strict and sequential.
 * Any failure throws, which aborts the surrounding transaction, so the caller
 * never ends up with "status changed but stock not restored".
 */
async function restoreOrderItemsInSession(items, session) {
  const lines = restorableItems(items).sort((a, b) => String(a.product).localeCompare(String(b.product)));
  for (const item of lines) {
    await products.updateOne(
      { _id: item.product },
      { $inc: { quantity: Number(item.quantity) } },
      { session },
    );
  }
}

/*
 * Fallback restoration for a cancelled order when transactions are not
 * available. `orders` is the order model (passed in by the controller).
 *
 *  1. CLAIM: one atomic write flips stock_restored false -> true. Only one
 *     caller can ever win it, so concurrent cancels / retries / the recovery
 *     path can never restore the same order twice.
 *  2. Restore every line (restoreOrderItems retries a failed write once).
 *  3. Success       -> remove the marker (nothing pending any more).
 *     Nothing restored at all -> release the claim (back to false) so a later
 *     retry can do the whole job.
 *     Partly restored -> keep the claim: re-running would add the lines that
 *     already succeeded a second time. The failed lines are logged and
 *     returned; the marker stays `true` so such orders can be found.
 *
 * Returns { claimed, failed }.
 */
async function restoreCancelledOrderStock(orders, order) {
  const claimed = await orders.findOneAndUpdate(
    { _id: order._id, status: "cancelled", stock_restored: false },
    { $set: { stock_restored: true } },
    { new: true },
  );

  if (!claimed) return { claimed: false, failed: [] };

  const lines = restorableItems(claimed.products);
  const { failed } = await restoreOrderItems(lines);

  try {
    if (failed.length === 0) {
      await orders.updateOne({ _id: claimed._id, stock_restored: true }, { $unset: { stock_restored: "" } });
    } else if (failed.length === lines.length) {
      await orders.updateOne({ _id: claimed._id, stock_restored: true }, { $set: { stock_restored: false } });
    }
  } catch (error) {
    // Stock state is already correct for the success case; for the other
    // cases the marker simply stays `true`, which can never double-restore.
    console.error("Could not update stock_restored marker:", error.message);
  }

  return { claimed: true, failed };
}

module.exports = {
  ALLOWED_STATUSES,
  ACTIVE_STATUSES,
  ALLOWED_TRANSITIONS,
  previousStatusesFor,
  restoreOrderItems,
  restoreOrderItemsInSession,
  restoreCancelledOrderStock,
  invalidateProductsCache,
};