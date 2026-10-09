require("dotenv").config();

const { verifyToken } = require("../utils/jwt");
const { extract_token } = require("../utils/request_token");
const mongoose = require("mongoose");
const users = require("../models/users");

// Authenticates the session JWT (httpOnly cookie, or Authorization: Bearer
// fallback - see utils/request_token.js) and lets through ONLY sellers and
// super_admins. Controllers behind this middleware must still scope
// queries by ownership: a seller is limited to their own records via
// req.user._id, a super_admin (req.user.role === "super_admin") is the
// only role allowed to act globally.
//
// Used for product update/delete so super_admin can moderate any product
// (Phase 1 requirement) without loosening the seller-only routes.
const auth_seller_or_admin = async (req, res, next) => {
    try {
        const token = extract_token(req);

        if (!token) {
            return res.status(401).json({ success: false, message: "Not authenticated" });
        }

        const decoded = verifyToken(token);

        if (!decoded.id || !mongoose.Types.ObjectId.isValid(decoded.id)) {
            return res.status(401).json({ success: false, message: "Invalid token" });
        }

        const user = await users
            .findById(decoded.id)
            .select("_id name email role phone_number GPS_URL whatsApp_number")
            .lean();

        if (!user) {
            return res.status(401).json({ success: false, message: "User not found" });
        }

        if (user.role !== "seller" && user.role !== "super_admin") {
            return res.status(403).json({ success: false, message: "Access restricted to sellers and super admins" });
        }

        req.user = user;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
};

module.exports = auth_seller_or_admin;