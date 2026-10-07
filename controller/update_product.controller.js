const products = require("../models/products");
const sections = require("../models/section");
const mongoose = require("mongoose");
const cache = require("../utils/cache");
// Same integer-cents discount math as order pricing (utils/money).
const { toCents, fromCents, applyPercentOffCents } = require("../utils/money");
const socket_events = require("../utils/socket_events");
// Same shared image-URL validator as add_products (SEC-06).
const { is_valid_image_url } = require("../utils/validators");

const MAX_NAME_LENGTH = 150;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_PRICE = 1000000000;
// Smallest price (and smallest price after discount) that is allowed. Anything
// lower rounds to 0.00 and would be listed as a free product.
const MIN_PRICE = 0.01;
const MAX_QUANTITY = 1000000;
const MAX_IMAGES = 10;
const MAX_IMAGE_URL_LENGTH = 500;

// Legacy (no expected_quantity) stock raises are ignored when the product was
// modified within this window: any checkout deduction bumps updatedAt, so a
// raise in that window is most likely a stale form value (LOGIC-02).
const LEGACY_STOCK_RAISE_QUIET_MS = 5 * 60 * 1000;

function changed_recently(updated_at) {
    const time = updated_at ? new Date(updated_at).getTime() : NaN;
    return Number.isFinite(time) && Date.now() - time < LEGACY_STOCK_RAISE_QUIET_MS;
}

function toNumber(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === "number") return value;
    return typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
}

const update_product = async (req, res) => {
    try {
        // FIX: use the auth middleware's req.user (set by auth_seller),
        // never trust a client-supplied id and never re-verify the JWT
        // here manually. This matches add_products.controller.js and
        // get_seller_products.controller.js, and it's what lets us
        // scope the update to "this seller's own products only" below.
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
                data: []
            });
        }

        // Trusted identity comes from req.user only. A seller is scoped
        // to their own products; only a super_admin may act on any
        // product (Phase 1: "super admin can manage globally").
        const is_super_admin = req.user.role === "super_admin";
        const seller_id = req.user._id;

        const product_id = req.body.product_id;
        const product_name = req.body.product_name;
        const product_description = req.body.product_description;
        const product_discount = toNumber(req.body.product_discount, 0);
        const product_price = toNumber(req.body.product_price, NaN);
        const quantity = toNumber(req.body.quantity, NaN);
        const expected_quantity = req.body.expected_quantity;
        const product_section = req.body.section;

        let images = [];
        if (Array.isArray(req.body.images)) {
            images = req.body.images.filter((img) => typeof img === "string").map((img) => img.trim()).filter(Boolean);
        } else if (typeof req.body.images === "string" && req.body.images.trim()) {
            images = [req.body.images.trim()];
        } else if (typeof req.body.image === "string" && req.body.image.trim()) {
            images = [req.body.image.trim()];
        }

        if (
            !product_id ||
            !product_name ||
            !product_description ||
            !Number.isFinite(product_price) ||
            images.length === 0 ||
            !product_section ||
            !Number.isFinite(quantity)
        ) {
            return res.status(400).json({
                success: false,
                message: "quantity, product id, product name, product description, product price, at least one image and section are required (product discount is optional and defaults to 0)",
                data: []
            });
        }

        if (typeof product_id !== "string" || !mongoose.Types.ObjectId.isValid(product_id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid product id",
                data: []
            });
        }

        if (typeof product_section !== "string" || !mongoose.Types.ObjectId.isValid(product_section)) {
            return res.status(400).json({
                success: false,
                message: "Invalid section id",
                data: []
            });
        }

        // FIX: only isNaN was checked, so a seller could save a negative
        // price, a discount above 100 (=> negative final_price), or a
        // fractional/huge quantity. NOTE: order.controller.js does NOT
        // block free products at checkout - it only rejects a negative
        // price or a discount outside 0-100 - so a price (or a price after
        // discount) that rounds to 0.00 must be rejected here, otherwise the
        // product is listed and sold for free.
        // A missing discount is treated as 0 (it is optional); a discount
        // that is present but invalid is rejected.
        if (
            !Number.isFinite(product_discount) ||
            product_discount < 0 ||
            product_discount > 100
        ) {
            return res.status(400).json({
                success: false,
                message: "Discount must be a number between 0 and 100",
                data: []
            });
        }

        if (product_price < MIN_PRICE || product_price > MAX_PRICE) {
            return res.status(400).json({
                success: false,
                message: `Price must be a number between ${MIN_PRICE} and ${MAX_PRICE}`,
                data: []
            });
        }

        const final_price = fromCents(applyPercentOffCents(toCents(product_price), product_discount));

        if (final_price < MIN_PRICE) {
            return res.status(400).json({
                success: false,
                message: `Discount is too high: the price after discount must be at least ${MIN_PRICE}`,
                data: []
            });
        }

        if (
            typeof product_name !== "string" ||
            typeof product_description !== "string" ||
            !Number.isFinite(product_price) ||
            product_name.trim().length > MAX_NAME_LENGTH ||
            product_description.trim().length > MAX_DESCRIPTION_LENGTH ||
            !Number.isInteger(quantity) ||
            quantity < 0 ||
            quantity > MAX_QUANTITY ||
            images.length > MAX_IMAGES ||
            !images.every((img) => is_valid_image_url(img, MAX_IMAGE_URL_LENGTH))
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid product data",
                data: []
            });
        }

        const sectionExists = await sections.exists({ _id: product_section });
        if (!sectionExists) {
            return res.status(400).json({ success: false, message: "Section not found", data: [] });
        }

        // Ownership is part of the query filter itself, so a seller can
        // never match (and therefore never modify or even read back)
        // another seller's product. super_admin skips the seller filter.
        // owner/store fields (seller_id, store_id) are deliberately NOT
        // in the update - ownership can't be reassigned through here.
        const ownership_filter = is_super_admin
            ? { _id: product_id }
            : { _id: product_id, seller_id: seller_id };

        const has_expected_quantity = expected_quantity !== undefined && expected_quantity !== null && expected_quantity !== "";
        const parsed_expected_quantity = has_expected_quantity
            ? toNumber(expected_quantity, NaN)
            : null;

        if (has_expected_quantity && (!Number.isInteger(parsed_expected_quantity) || parsed_expected_quantity < 0)) {
            return res.status(400).json({
                success: false,
                message: "expected_quantity must be a non-negative whole number",
                data: []
            });
        }

        // One read gives us the quantity and the last-modified time of the
        // same snapshot. The final write below is still a single atomic
        // findOneAndUpdate, so an order deduction that lands between this
        // read and that write is never overwritten.
        const current_product = await products
            .findOne(ownership_filter)
            .select("quantity updatedAt")
            .lean();

        if (!current_product) {
            return res.status(404).json({
                success: false,
                message: "product not found",
                data: []
            });
        }

        const current_quantity = Number(current_product.quantity);
        if (!Number.isInteger(current_quantity) || current_quantity < 0) {
            return res.status(409).json({
                success: false,
                message: "Stock changed, reload the product",
                data: []
            });
        }

        // LOGIC-02: decide whether this request intends to change stock at
        // all, and if so how to apply it without overwriting a concurrent
        // order. The stock is never written as an absolute value: it is
        // either left untouched or moved with a relative $inc.
        const update_filter = { ...ownership_filter };
        let quantity_delta = 0;
        let legacy_note = "";

        if (has_expected_quantity) {
            // The client states which stock it was looking at.
            //  - quantity === expected_quantity: the stock field was not
            //    edited (name/price/... edit). Stock is left untouched, so
            //    an order placed while the form was open stays reserved and
            //    the edit does not need to be rejected.
            //  - otherwise the seller really changed stock: compare-and-set.
            //    The write only matches while stock is still exactly what
            //    the seller saw; any concurrent movement -> 409 (reload).
            if (parsed_expected_quantity !== quantity) {
                quantity_delta = quantity - parsed_expected_quantity;
                update_filter.quantity = parsed_expected_quantity;
            }
        } else {
            // Legacy clients (seller-dashboard.html before this fix) send no
            // baseline, so a stale form value cannot be told apart from an
            // intentional change by the value alone.
            const delta = quantity - current_quantity;
            if (delta < 0) {
                // A lower value can only reduce stock, never oversell. The
                // guard keeps stock from going negative if an order lands
                // between the read and the write.
                quantity_delta = delta;
                update_filter.quantity = { $gte: -delta };
            } else if (delta > 0) {
                if (changed_recently(current_product.updatedAt)) {
                    // Buyers only ever lower stock, so a form value ABOVE the
                    // current stock right after the product changed is most
                    // likely the stale value the form was loaded with. Raising
                    // stock from it would re-sell units that were just
                    // reserved, so the stock field is ignored for this
                    // request (the rest of the edit still applies).
                    legacy_note = " (stock raise ignored: product changed recently, send expected_quantity to change stock)";
                } else {
                    quantity_delta = delta;
                }
            }
            console.warn(`[stock] legacy product update without expected_quantity: ${product_id}${legacy_note}`);
        }

        const update = {
            $set: {
                name: product_name,
                description: product_description,
                price: product_price,
                discount: product_discount,
                final_price: final_price,
                images: images,
                section: product_section
            },
        };
        // No stock change: omit quantity entirely. Otherwise apply the
        // difference with $inc so concurrent checkout deductions survive.
        if (quantity_delta !== 0) update.$inc = { quantity: quantity_delta };

        const updated_product = await products.findOneAndUpdate(
            update_filter,
            update,
            { new: true, runValidators: true }
        );

        if (!updated_product) {
            // It existed during the read above, so a conditional update miss
            // means concurrent stock movement (or deletion), not permission
            // disclosure. The client must reload before retrying.
            return res.status(409).json({
                success: false,
                message: "Stock changed, reload the product",
                data: []
            });
        }

        await cache.delByPrefix("products");

        socket_events.emit_to(
            req.io,
            socket_events.CATALOG_ROOM,
            "update_product",
            socket_events.product_payload(updated_product)
        );

        return res.status(200).json({
            success: true,
            message: "updated successfully",
            data: updated_product
        });

    } catch (e) {
        console.error("Update product error:", e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};
module.exports = update_product