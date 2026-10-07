const users = require("../models/users");
const products = require("../models/products");
const cache = require("../utils/cache");
const mongoose = require("mongoose");
const socket_events = require("../utils/socket_events");

// The users schema has no `select: false` on password, so every query
// that returns a user document also returns the bcrypt hash. This
// controller used to send that whole document both in the HTTP response
// AND in a socket event broadcast to the whole "users" room (every
// connected client). The hash is now excluded from every read here, and
// the socket event goes only to the affected user's private room and the
// admins room, carrying only the fields the UI needs (id, name, role).
const SAFE_FIELDS = "_id name email role phone_number GPS_URL whatsApp_number createdAt updatedAt";

const update_admin_to_user = async (req, res) => {
    try {
        const user_id = req.body.user_id;

        if (!user_id) {
            return res.status(400).json({
                success: false,
                message: "user_id is required",
                data: []
            });
        }

        if (typeof user_id !== "string" || !mongoose.Types.ObjectId.isValid(user_id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid user_id",
                data: []
            });
        }

        const target_user = await users.findById(user_id).select(SAFE_FIELDS).lean();

        if (!target_user) {
            return res.status(404).json({
                success: false,
                message: "user not found",
                data: []
            });
        }

        if (target_user.role === "super_admin") {
            return res.status(403).json({
                success: false,
                message: "cannot downgrade a super_admin through this endpoint",
                data: []
            });
        }

        if (target_user.role === "user") {
            return res.status(200).json({
                success: true,
                message: "user already has role 'user'",
                data: target_user
            });
        }

        const update_user = await users
            .findOneAndUpdate(
                { _id: user_id },
                { role: "user" },
                { new: true }
            )
            .select(SAFE_FIELDS)
            .lean();

        if (!update_user) {
            return res.status(404).json({
                success: false,
                message: "user not found",
                data: []
            });
        }

        await products.updateMany({ seller_id: user_id }, { $set: { is_active: false } });
        await cache.delByPrefix("products");

        // The role change is already saved; a socket problem must not
        // turn it into a 500.
        // Only the affected user's private room and the admins room get the
        // change, with id/name/role only (never e-mail, phone, GPS, ...).
        socket_events.emit_to(
            req.io,
            [socket_events.user_room(update_user._id), socket_events.ADMINS_ROOM],
            "update_user",
            { update_user: socket_events.user_role_payload(update_user) }
        );

        // A demoted seller must stop receiving seller-only events
        // (new_order, new_ticket) on sockets that are still connected.
        socket_events.revoke_seller_room?.(req.io, update_user._id);

        return res.status(200).json({
            success: true,
            message: "downgrade successful",
            data: update_user
        });
    }
    catch (e) {
        console.log(e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
}
module.exports = update_admin_to_user