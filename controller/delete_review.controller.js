const mongoose = require("mongoose");
const products = require("../models/products");
const cache = require("../utils/cache");

const delete_review = async (req, res) => {
    try {
        const { product_id, review_id } = req.body || {};
        if (typeof product_id !== "string" || typeof review_id !== "string" ||
            !mongoose.Types.ObjectId.isValid(product_id) || !mongoose.Types.ObjectId.isValid(review_id)) {
            return res.status(400).json({ success: false, message: "Valid product_id and review_id are required", data: [] });
        }
        // `reviews` is an array of Mixed objects, so Mongoose does not cast
        // `reviews._id` for this query. Review ids are stored as ObjectIds by
        // post_review, therefore both match and pull need the BSON ObjectId.
        const reviewObjectId = new mongoose.Types.ObjectId(review_id);
        const updated = await products.findOneAndUpdate(
            { _id: product_id, "reviews._id": reviewObjectId },
            { $pull: { reviews: { _id: reviewObjectId } } },
            { new: true },
        );
        if (!updated) return res.status(404).json({ success: false, message: "Review not found", data: [] });
        console.info(`[admin] review ${review_id} deleted from product ${product_id} by ${req.user._id}`);
        await cache.delByPrefix("products");
        return res.status(200).json({ success: true, message: "Review deleted successfully", data: [] });
    } catch (error) {
        console.error("Delete review error:", error.message);
        return res.status(500).json({ success: false, message: "Internal server error", data: [] });
    }
};

module.exports = delete_review;
