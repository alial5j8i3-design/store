const mongoose = require("mongoose");
const products = require("../models/products");
const orders = require("../models/order");
const cache = require("../utils/cache");
const socket_events = require("../utils/socket_events");

const MAX_REVIEW_LENGTH = 1000;

const post_review = async (req, res) => {
    try {
        // The route already runs the `auth` middleware, which verified the
        // JWT and loaded the user from the DB. Use that (req.user) instead
        // of re-verifying the cookie here - and it gives the CURRENT name
        // rather than the one frozen inside a token issued up to 30 days ago.
        const user = req.user;

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
                data: []
            });
        }

        const product_id = req.body.product_id;
        const review_text = typeof req.body.review_text === "string"
            ? req.body.review_text.trim()
            : "";

        const ratingInput = Number(req.body.rating);

        if (!Number.isFinite(ratingInput) || ratingInput < 1 || ratingInput > 5) {
            return res.status(400).json({
                success: false,
                message: "rating is required and must be a number between 1 and 5",
                data: []
            });
        }

        const rating = Math.round(ratingInput);

        if (typeof product_id !== "string" || !mongoose.Types.ObjectId.isValid(product_id)) {
            return res.status(400).json({
                success: false,
                message: "A valid product_id is required",
                data: []
            });
        }

        if (!review_text) {
            return res.status(400).json({
                success: false,
                message: "review_text is required",
                data: []
            });
        }

        if (review_text.length > MAX_REVIEW_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `review_text must be at most ${MAX_REVIEW_LENGTH} characters`,
                data: []
            });
        }

        const user_id = user._id.toString();

        const hasDeliveredPurchase = await orders.exists({
            user_id,
            status: "delivered",
            "products.product": product_id,
        });

        if (!hasDeliveredPurchase) {
            return res.status(403).json({
                success: false,
                message: "You can review this product only after a delivered purchase",
                data: []
            });
        }

        const newReview = {
            _id: new mongoose.Types.ObjectId(),
            user_id: user_id,
            user_name: user.name,
            content: review_text,
            rating: rating,
            created_at: new Date()
        };

        // FIX: nothing stopped one account from posting many reviews on the
        // same product (or a seller from rating their own product), which
        // lets anyone inflate/deflate a store's rating. The two conditions
        // below are part of the update filter itself, so the check and the
        // write are a single atomic operation (no race between two
        // simultaneous requests).
        const updateResult = await products.updateOne(
            {
                _id: product_id,
                seller_id: { $ne: user._id },
                "reviews.user_id": { $ne: user_id }
            },
            { $push: { reviews: newReview } }
        );

        if (updateResult.matchedCount === 0) {
            // Work out WHY nothing matched, to return a useful status.
            const product = await products
                .findById(product_id)
                .select("seller_id reviews.user_id")
                .lean();

            if (!product) {
                return res.status(404).json({
                    success: false,
                    message: "not found",
                    data: []
                });
            }

            if (String(product.seller_id) === user_id) {
                return res.status(403).json({
                    success: false,
                    message: "You cannot review your own product",
                    data: []
                });
            }

            return res.status(409).json({
                success: false,
                message: "You have already reviewed this product",
                data: []
            });
        }

        // The review is already saved; socket/cache problems must not turn
        // it into a 500.
        try {
            // Only ids + rating: no reviewer id/name or text is broadcast.
            socket_events.emit_to(
                req.io,
                socket_events.CATALOG_ROOM,
                "new_review",
                socket_events.review_payload(product_id, newReview)
            );

            await cache.delByPrefix("products");
        } catch (sideEffectError) {
            console.log(sideEffectError.message);
        }

        return res.status(201).json({
            success: true,
            message: "review added successfully",
            data: [newReview]
        });
    }
    catch (e) {
        console.log(e.message)
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}
module.exports = post_review
