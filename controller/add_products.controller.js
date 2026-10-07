const products = require("../models/products");
const store = require("../models/store");
const sections = require("../models/section");
const mongoose = require("mongoose");
const cache = require("../utils/cache");
const socket_events = require("../utils/socket_events");
// One shared image-URL validator (https/http only, no unsafe characters, no
// credentials/ports/internal hosts/SVG, optional ALLOWED_IMAGE_HOSTS allowlist).
const { is_valid_image_url } = require("../utils/validators");

// Limits - adjust to your needs
const MAX_NAME_LENGTH = 150;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_PRICE = 1000000000;
// Smallest price (and smallest price after discount) that is allowed. Anything
// lower rounds to 0.00 and would be listed as a free product.
const MIN_PRICE = 0.01;
const MAX_QUANTITY = 1000000;
const MAX_IMAGES = 10;
const MAX_IMAGE_URL_LENGTH = 500;

// Converts a value to a number only if it is a real number or a
// non-empty numeric string. Prevents "" / null / [] from becoming 0.
const to_number = (value, default_value) => {
    if (value === undefined || value === null) {
        return default_value;
    }
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
        return Number(value);
    }
    return NaN;
};

const bad_request = (res, message) =>
    res.status(400).json({
        success: false,
        message: message,
        data: []
    });

const add_product = async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "Not authenticated",
                data: []
            });
        }

        // ---------- 1) Read and validate input (no DB access yet) ----------

        const product_name =
            typeof req.body.product_name === "string" ? req.body.product_name.trim() : "";
        const product_description =
            typeof req.body.product_description === "string"
                ? req.body.product_description.trim()
                : "";
        const product_price = to_number(req.body.product_price, NaN);
        const product_discount = to_number(req.body.product_discount, 0);
        const quantity = to_number(req.body.quantity, NaN);
        const section_id = req.body.section;

        if (!product_name || product_name.length > MAX_NAME_LENGTH) {
            return bad_request(
                res,
                `Product name is required (max ${MAX_NAME_LENGTH} characters)`
            );
        }

        if (!product_description || product_description.length > MAX_DESCRIPTION_LENGTH) {
            return bad_request(
                res,
                `Product description is required (max ${MAX_DESCRIPTION_LENGTH} characters)`
            );
        }

        if (
            !Number.isFinite(product_price) ||
            product_price < MIN_PRICE ||
            product_price > MAX_PRICE
        ) {
            return bad_request(res, `Price must be a number between ${MIN_PRICE} and ${MAX_PRICE}`);
        }

        if (
            !Number.isFinite(product_discount) ||
            product_discount < 0 ||
            product_discount > 100
        ) {
            return bad_request(res, "Discount must be a number between 0 and 100");
        }

        // Rounded to 2 decimals to avoid floating point artifacts. Computed
        // during validation (before any DB access) so a discount that drives
        // the price to zero is rejected up front.
        const final_price =
            Math.round(product_price * (1 - product_discount / 100) * 100) / 100;

        if (final_price < MIN_PRICE) {
            return bad_request(
                res,
                `Discount is too high: the price after discount must be at least ${MIN_PRICE}`
            );
        }

        if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
            return bad_request(res, "Quantity must be a whole number, 0 or more");
        }

        if (typeof section_id !== "string" || !mongoose.Types.ObjectId.isValid(section_id)) {
            return bad_request(res, "Invalid section id");
        }

        let images = [];
        if (Array.isArray(req.body.images)) {
            images = req.body.images;
        } else if (typeof req.body.images === "string") {
            images = [req.body.images];
        } else if (typeof req.body.image === "string") {
            images = [req.body.image];
        }

        images = images
            .filter((img) => typeof img === "string")
            .map((img) => img.trim())
            .filter((img) => img !== "");

        if (images.length === 0 || images.length > MAX_IMAGES) {
            return bad_request(res, `Between 1 and ${MAX_IMAGES} images are required`);
        }

        if (!images.every((img) => is_valid_image_url(img, MAX_IMAGE_URL_LENGTH))) {
            return bad_request(res, "Each image must be a valid http/https URL");
        }

        // ---------- 2) Seller / store (DB access only after input is valid) ----------

        // Seller identity comes from the authenticated user, never from the client.
        const seller_id = req.user._id;

        // The store is derived from the seller's own store, never from req.body.
        const my_store = await store.findOne({ owner_id: seller_id }).select("_id").lean();

        if (!my_store) {
            return bad_request(res, "Create your store before adding products.");
        }

        const store_id = my_store._id;

        // The referenced section must exist (same check update_product does);
        // otherwise a product could be created pointing at nothing.
        const section_exists = await sections.exists({ _id: section_id });

        if (!section_exists) {
            return bad_request(res, "Section not found");
        }

        // ---------- 3) Create the product ----------

        const new_product = new products({
            name: product_name,
            description: product_description,
            price: product_price,
            discount: product_discount,
            final_price: final_price,
            images: images,
            quantity: quantity,
            section: section_id,
            seller_id: seller_id,
            store_id: store_id,
            reviews: []
        });

        await new_product.save();

        await cache.delByPrefix("products");

        // Public catalog notification: ids + name only, never the full document.
        socket_events.emit_to(
            req.io,
            socket_events.CATALOG_ROOM,
            "new_product",
            socket_events.product_payload(new_product)
        );

        return res.status(201).json({
            success: true,
            message: "add successfully",
            data: new_product
        });
    } catch (e) {
        console.error("Add product error:", e.message);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = add_product;