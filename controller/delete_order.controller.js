const orders = require("../models/order");
const orderArchive = require("../models/order_archive");
const {
    ACTIVE_STATUSES,
    restoreOrderItems,
    restoreOrderItemsInSession,
    invalidateProductsCache,
} = require("../utils/order_stock");
const { runInTransaction } = require("../utils/db_transaction");
const { user_room } = require("../utils/socket_events");

// This route is protected by the auth_seller middleware
// (routes/delete_order.router.js), which verifies the JWT, confirms
// the requester's role is "seller", and attaches them to req.user -
// so seller identity is read from req.user, never from req.body.

const MAX_ATTEMPTS = 3;

const round2 = (n) => Math.round(n * 100) / 100;

const items_subtotal = (items) =>
    items.reduce((sum, p) => sum + Number(p.price) * Number(p.quantity), 0);

function buildArchiveEntry(order, seller_id, removedItems) {
    return {
        order_id: order._id,
        order_updated_at: order.updatedAt,
        order: typeof order.toObject === "function" ? order.toObject() : order,
        removed_by: seller_id,
        reason: "seller_delete",
        removed_items: removedItems,
    };
}

// Returns { duplicate }. `duplicate` is true when this exact order version was
// already archived (a retry, or another seller's concurrent request).
async function archiveBeforeRemoval(entry) {
    try {
        await orderArchive.create(entry);
        return { duplicate: false };
    } catch (error) {
        // The version is already archived, so a snapshot exists and the
        // destructive write may proceed. Any other archive error must stop it.
        if (error?.code === 11000) return { duplicate: true };
        throw error;
    }
}

// When the version row already existed it may name a different remover, so the
// removal that really happened is recorded in a second row keyed by the version
// it produced. Best effort: the order is already changed and the pre-change
// snapshot exists, so a failure here must not turn a success into an error.
async function recordRemovalAfterConflict(outcome) {
    if (!outcome.archiveDuplicate || !outcome.archiveEntry) return;

    const entry = outcome.archiveEntry;
    const newVersion = outcome.order && outcome.order.updatedAt;
    if (!newVersion || +new Date(newVersion) === +new Date(entry.order_updated_at)) return;

    try {
        await orderArchive.create({
            ...entry,
            order_updated_at: newVersion,
            source_order_updated_at: entry.order_updated_at,
        });
    } catch (error) {
        if (error?.code !== 11000) {
            console.error("Order archive removal record failed:", error.message);
        }
    }
}

const DEL_order = async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "Not authenticated",
                data: []
            });
        }

        const order_id = req.body.order_id;

        if (!order_id) {
            return res.status(400).json({
                success: false,
                message: "order_id is required",
                data: []
            });
        }

        // Must be a real 24-hex ObjectId string. (mongoose's isValid()
        // also accepts any 12-character string and other odd inputs, and
        // a non-string here could end up inside the query object.)
        if (typeof order_id !== "string" || !/^[a-fA-F0-9]{24}$/.test(order_id)) {
            return res.status(400).json({
                success: false,
                message: "invalid order id",
                data: []
            });
        }

        // Seller identity comes from the authenticated user, never
        // from the request body.
        const seller_id = req.user._id.toString();

        // Orders can contain products from several sellers (see
        // models/order.js), so a seller only removes THEIR OWN line items.
        // The whole order document is deleted only when no products from
        // other sellers are left.
        //
        // The order is read, the new state is computed, and the write is
        // conditioned on `updatedAt` being unchanged (optimistic locking).
        // That makes the "pull my items, then maybe delete the order" logic
        // safe when two sellers act on the same order at the same time.
        let outcome = null;

        for (let attempt = 0; attempt < MAX_ATTEMPTS && !outcome; attempt++) {
            const order = await orders.findOne({
                _id: order_id,
                "products.seller_id": seller_id
            });

            if (!order) {
                return res.status(404).json({
                    success: false,
                    message: "order not found",
                    data: []
                });
            }

            const removedItems = order.products.filter((p) => String(p.seller_id) === seller_id);
            const remaining = order.products.filter((p) => String(p.seller_id) !== seller_id);

            // Archive the full pre-change order before either delete or $pull.
            // If this fails, no destructive write below is attempted.
            const archiveEntry = buildArchiveEntry(order, seller_id, removedItems);
            const { duplicate: archiveDuplicate } = await archiveBeforeRemoval(archiveEntry);

            // The destructive write and (when the order still owns its stock)
            // the stock give-back are ONE unit:
            //  - with transactions they commit together or not at all;
            //  - without transactions (session undefined) only the write runs
            //    here and the give-back follows below, exactly as before.
            const applyRemoval = async (session) => {
                const sessionOptions = session ? { session } : {};
                let result = null;

                if (remaining.length === 0) {
                    const deleted_order = await orders.findOneAndDelete(
                        { _id: order_id, updatedAt: order.updatedAt },
                        sessionOptions
                    );

                    if (deleted_order) {
                        result = {
                            deleted: true,
                            order: deleted_order,
                            removedItems: deleted_order.products,
                            statusAtRemoval: deleted_order.status,
                        };
                    }
                } else {
                    // total_price used to stay unchanged after removing this
                    // seller's items, so the customer and the other sellers kept
                    // seeing a total that still included the removed products.
                    // The stored total may include a coupon discount, so it is
                    // scaled by the share of the items that remain instead of
                    // being recomputed from scratch.
                    const old_subtotal = items_subtotal(order.products);
                    const new_subtotal = items_subtotal(remaining);
                    const new_total =
                        old_subtotal > 0
                            ? round2((order.total_price * new_subtotal) / old_subtotal)
                            : order.total_price;

                    const updated_order = await orders.findOneAndUpdate(
                        {
                            _id: order_id,
                            updatedAt: order.updatedAt
                        },
                        {
                            $pull: { products: { seller_id: seller_id } },
                            $set: { total_price: new_total }
                        },
                        { new: true, ...sessionOptions }
                    );

                    if (updated_order) {
                        result = {
                            deleted: false,
                            order: updated_order,
                            removedItems,
                            // The write above was conditioned on updatedAt, so this
                            // status is guaranteed to be the one that was current.
                            statusAtRemoval: order.status,
                        };
                    }
                }

                if (result && session && ACTIVE_STATUSES.includes(result.statusAtRemoval)) {
                    await restoreOrderItemsInSession(
                        result.removedItems.filter((item) => String(item.seller_id) === seller_id),
                        session
                    );
                    result.stockRestored = true;
                }

                return result;
            };

            const transaction = await runInTransaction(applyRemoval);
            const result = transaction.used ? transaction.value : await applyRemoval(undefined);

            if (result) {
                result.archiveDuplicate = archiveDuplicate;
                result.archiveEntry = archiveEntry;
                outcome = result;
            }
        }

        if (!outcome) {
            // Someone else kept changing the order at the same time.
            return res.status(409).json({
                success: false,
                message: "The order was modified at the same time, please try again",
                data: []
            });
        }

        await recordRemovalAfterConflict(outcome);

        // Restore the removed line items ONLY while the order still owns its
        // reserved stock (new / processing / shipped). Before this check:
        //  - deleting a CANCELLED order restored the stock a second time
        //    (cancel already gave it back) -> inflated inventory,
        //  - deleting a DELIVERED order restored stock for goods that were
        //    already sold and handed over.
        // This runs after the optimistic write succeeded, so retries and
        // concurrent deletes cannot restore the same stock twice.
        // (When the removal ran inside a transaction the stock already went
        // back in that same transaction - outcome.stockRestored - so only the
        // cache needs refreshing.)
        if (outcome.stockRestored) {
            await invalidateProductsCache();
        } else if (ACTIVE_STATUSES.includes(outcome.statusAtRemoval)) {
            const removedItems = outcome.removedItems.filter((item) => item.seller_id === seller_id);
            const { failed } = await restoreOrderItems(removedItems);

            if (failed.length > 0) {
                return res.status(500).json({
                    success: false,
                    message: "Order was removed but restoring the stock failed for some products; contact support",
                    data: []
                });
            }
        }

        // The order is already removed: a socket problem must not turn that
        // success into a 500.
        try {
            if (req.io) {
                if (outcome.deleted) {
                    req.io.to("admins").emit("deleted_order", {
                        deleted_order: outcome.order
                    });
                } else {
                    // The order still exists (other sellers' items remain), so
                    // it must not be announced as deleted.
                    req.io.to("admins").emit("updated_order", {
                        updated_order: outcome.order
                    });
                }
                // A super_admin who also owns the order sits in BOTH "admins"
                // and the owner's room; the owner copy excludes the admins
                // room so that socket gets the admin copy only, once.
                const ownerTarget = req.io.to(user_room(outcome.order.user_id));
                (typeof ownerTarget.except === "function" ? ownerTarget.except("admins") : ownerTarget).emit(
                    outcome.deleted ? "deleted_order" : "updated_order",
                    { _id: outcome.order._id, orderNumber: outcome.order.orderNumber }
                );
            }
        } catch (emitError) {
            console.error("Order socket emit failed:", emitError.message);
        }

        return res.status(200).json({
            success: true,
            message: "Order deleted successfully",
            data: []
        });
    } catch (e) {
        console.error("Delete order error:", e.message);
        // Do not leak internal error details to the client
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = DEL_order;