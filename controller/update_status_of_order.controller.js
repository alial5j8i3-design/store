const orders = require("../models/order");
const {
    ALLOWED_STATUSES,
    previousStatusesFor,
    restoreOrderItemsInSession,
    restoreCancelledOrderStock,
    invalidateProductsCache,
} = require("../utils/order_stock");
const { runInTransaction } = require("../utils/db_transaction");

// `stock_restored` is internal bookkeeping (see utils/order_stock.js); it must
// never appear in the API response.
const clientOrder = (order) => {
    if (!order || order.stock_restored === undefined) return order;
    const plain = typeof order.toObject === "function" ? order.toObject() : { ...order };
    delete plain.stock_restored;
    return plain;
};

const updated_status = async (req, res) => {
    try {

        const user = req.user;

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
                data: []
            });
        }

        const order_id = req.body.order_id;

        const the_new_status = req.body.status_order;

        if (!order_id || !the_new_status) {
            return res.status(400).json({
                success: false,
                message: "order_id and status_order are required",
                data: []
            });
        }

        if (typeof order_id !== "string" || !/^[a-fA-F0-9]{24}$/.test(order_id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid order id",
                data: []
            });
        }

        if (typeof the_new_status !== "string" || !ALLOWED_STATUSES.includes(the_new_status)) {
            return res.status(400).json({
                success: false,
                message: `status_order must be one of: ${ALLOWED_STATUSES.join(", ")}`,
                data: []
            });
        }

        const seller_id = user._id.toString();

        // The legal-transition check is part of the atomic update filter
        // (not a separate read), so two concurrent requests can never both
        // pass it. This guarantees that:
        //  - a cancelled order is cancelled (and its stock restored) ONCE,
        //  - a cancelled order can't be moved back to processing/delivered
        //    (that used to leave phantom stock: restored AND still "sold"),
        //  - a delivered order can't be cancelled afterwards.
        const filter = {
            _id: order_id,
            "products.seller_id": seller_id,
            status: { $in: previousStatusesFor(the_new_status) }
        };

        let update_status;
        // true when the stock went back inside the same transaction that
        // cancelled the order (nothing left to do afterwards).
        let restoredInTransaction = false;

        if (the_new_status === "cancelled") {
            // Preferred: ONE transaction = status change + stock give-back.
            // Either both are committed or neither is, so a crash or a
            // failed write can never leave a cancelled order without its
            // stock (and a retry can never restore it a second time).
            let transaction;
            try {
                transaction = await runInTransaction(async (session) => {
                    const cancelled = await orders.findOneAndUpdate(
                        filter,
                        { $set: { status: "cancelled" } },
                        { new: true, session }
                    );
                    if (cancelled) {
                        await restoreOrderItemsInSession(cancelled.products, session);
                    }
                    return cancelled;
                });
            } catch (transactionError) {
                console.error("Cancel transaction failed:", transactionError.message);
                return res.status(500).json({
                    success: false,
                    message: "Order was not cancelled because restoring the stock failed; nothing was changed, please try again",
                    data: []
                });
            }

            if (transaction.used) {
                update_status = transaction.value;
                restoredInTransaction = true;
                if (update_status) await invalidateProductsCache();
            } else {
                // Fallback (standalone MongoDB, no transactions): the status
                // change and the "stock still has to be restored" marker are
                // ONE single-document write, so they cannot be separated.
                update_status = await orders.findOneAndUpdate(
                    filter,
                    { $set: { status: "cancelled", stock_restored: false } },
                    { new: true }
                );
            }
        } else {
            update_status = await orders.findOneAndUpdate(
                filter,
                { status: the_new_status },
                { new: true }
            );
        }

        if (!update_status) {
            // Distinguish "no such order for this seller" from
            // "order exists but this transition isn't allowed".
            const existing = await orders
                .findOne({ _id: order_id, "products.seller_id": seller_id })
                .select("status stock_restored")
                .lean();

            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: "order not found",
                    data: []
                });
            }

            // Recovery: an earlier cancel (fallback mode) changed the status
            // but never finished giving the stock back (crash / failed write
            // before the claim). The atomic claim inside makes this safe even
            // if another request is restoring the same order right now.
            if (existing.status === "cancelled" && existing.stock_restored === false) {
                try {
                    await restoreCancelledOrderStock(orders, { _id: order_id });
                } catch (recoveryError) {
                    console.error("Stock restore recovery failed:", recoveryError.message);
                }
            }

            return res.status(409).json({
                success: false,
                message: `Cannot change order status from "${existing.status}" to "${the_new_status}"`,
                data: []
            });
        }

        if (the_new_status === "cancelled" && !restoredInTransaction) {
            // The status is ONE value for the whole order, so cancelling it
            // cancels every line item - and every line item's reserved stock
            // must go back (before: only the cancelling seller's items were
            // restored, and the other sellers' stock was lost forever because
            // a second cancel was rejected as "already cancelled").
            // The claim inside restoreCancelledOrderStock guarantees the
            // restoration happens once even if another request races us.
            const { failed } = await restoreCancelledOrderStock(orders, update_status);

            if (failed.length > 0) {
                return res.status(500).json({
                    success: false,
                    message: "Order was cancelled but restoring the stock failed for some products; contact support",
                    data: []
                });
            }
        }
        // "delivered" (and every other status) deliberately touches no stock:
        // it was already deducted when the order was created.

        try {
            if (req.io) {
                req.io.to(`user:${update_status.user_id}`).emit("update_status", {
                    _id: update_status._id,
                    orderNumber: update_status.orderNumber,
                    status: update_status.status,
                });
            }
        } catch (emitError) {
            console.error("Order status socket emit failed:", emitError.message);
        }
        return res.status(200).json({
            success: true,
            message: "updated successfully",
            data: clientOrder(update_status)
        });
    }
    catch (e) {
        console.log(e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = updated_status;