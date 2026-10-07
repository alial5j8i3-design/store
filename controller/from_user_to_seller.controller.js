const users = require("../models/users");
const products = require("../models/products");
const cache = require("../utils/cache");
const promotion_requests = require("../models/Promotion_requests_for_salesperson");
const socket_events = require("../utils/socket_events");

// This route is protected by the auth_super_admin middleware
// (routes/from_user_to_seller.router.js), which verifies the JWT,
// confirms the requester's role is "super_admin", and attaches them
// to req.user - no need to re-verify anything here.

const upgrade_user_to_seller = async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
                data: []
            });
        }

        const user_id = req.body.user_id;

        if (!user_id) {
            return res.status(400).json({
                success: false,
                message: "user_id is required",
                data: []
            });
        }

        // Must be a real 24-hex ObjectId string (isValid() alone also
        // accepts any 12-character string and non-string inputs).
        if (typeof user_id !== "string" || !/^[a-fA-F0-9]{24}$/.test(user_id)) {
            return res.status(400).json({
                success: false,
                message: "invalid user_id",
                data: []
            });
        }

        // Only a regular user can be upgraded. Before, the filter was just
        // the id, so calling this with a super_admin's id silently turned
        // that super_admin (or the requester themselves) into a seller.
        //
        // Only safe fields are read back: the full user document contains
        // the password hash, and it used to be sent both in the HTTP
        // response and in the socket event to every connected user.
        const upgraded_user = await users
            .findOneAndUpdate(
                { _id: user_id, role: "user" },
                { role: "seller" },
                { new: true }
            )
            .select("_id name email role")
            .lean();

        if (!upgraded_user) {
            const existing = await users.findById(user_id).select("role").lean();

            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: "user not found",
                    data: []
                });
            }

            return res.status(409).json({
                success: false,
                message: `Only regular users can be upgraded (this account is already "${existing.role}")`,
                data: []
            });
        }

        await products.updateMany({ seller_id: upgraded_user._id }, { $set: { is_active: true } });
        await cache.delByPrefix("products");

        // The request is fulfilled, so remove it. Before, it stayed in the
        // admin's pending list forever, and because user_id is unique, a
        // user who was later downgraded could never apply again (409).
        try {
            await promotion_requests.deleteOne({ user_id: upgraded_user._id });
        } catch (cleanupError) {
            // The upgrade itself already succeeded; don't turn it into a 500.
            console.error("Promotion request cleanup failed:", cleanupError.message);
        }

        // Audit trail: who upgraded whom.
        console.info(`[admin] user ${upgraded_user._id} upgraded to seller by ${req.user._id}`);

        // Role changes are NOT public: only the affected user's private room
        // and the admins room receive it, with id/name/role only (no email).
        socket_events.emit_to(
            req.io,
            [socket_events.user_room(upgraded_user._id), socket_events.ADMINS_ROOM],
            "upgrade_user",
            { upgrade_user: socket_events.user_role_payload(upgraded_user) }
        );

        // Already-open sockets of the new seller start receiving seller-only
        // events (new_order, new_ticket) without having to reconnect.
        socket_events.grant_seller_room?.(req.io, upgraded_user._id);

        return res.status(200).json({
            success: true,
            message: "upgrade successful",
            data: upgraded_user
        });
    } catch (e) {
        console.error("Upgrade user error:", e.message);
        // Do not leak internal error details to the client
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = upgrade_user_to_seller;