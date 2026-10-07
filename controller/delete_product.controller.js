const products = require("../models/products");
const cache = require("../utils/cache");
const socket_events = require("../utils/socket_events");

// This route is protected by the auth_seller_or_admin middleware
// (routes/delete_product.router.js), which verifies the JWT, confirms
// the requester's role is "seller" or "super_admin", and attaches them
// to req.user - so identity is read from req.user, never from req.body.

const DEL_product = async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "Not authenticated",
                data: []
            });
        }

        const product_id = req.body.product_id;

        if (!product_id) {
            return res.status(400).json({
                success: false,
                message: "product id is required",
                data: []
            })
        }

        // Must be a real 24-hex ObjectId string (isValid() alone also accepts
        // any 12-character string).
        if (typeof product_id !== "string" || !/^[a-fA-F0-9]{24}$/.test(product_id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid product id",
                data: []
            })
        }

        // Ownership is part of the delete filter: a seller can only
        // delete their own product; only super_admin deletes globally.
        const is_super_admin = req.user.role === "super_admin";
        const ownership_filter = is_super_admin
            ? { _id: product_id }
            : { _id: product_id, seller_id: req.user._id };

        const deleted_product = await products.findOneAndDelete(ownership_filter);

        if (!deleted_product) {
            return res.status(404).json({
                success: false,
                message: "Product not found",
                data: []
            });
        }
        await cache.delByPrefix("products");

        // Audit trail: a super_admin can delete any seller's product, so
        // record who deleted what.
        if (is_super_admin) {
            console.info(
                `[admin] product ${deleted_product._id} (seller ${deleted_product.seller_id}) deleted by ${req.user._id}`
            );
        }

        socket_events.emit_to(
            req.io,
            socket_events.CATALOG_ROOM,
            "deleted_product",
            socket_events.product_payload(deleted_product)
        );
        return res.status(200).json({
            success: true,
            message: "Product deleted successfully",
            data: []
        });
    }
    catch (e) {
        console.error("Delete product error:", e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

module.exports = DEL_product