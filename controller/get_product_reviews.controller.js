const products = require("../models/products");

// Only these review fields are returned. A stored review also contains
// `user_id` (the reviewer's account id), which every logged-in user could
// read from this endpoint. The product page only needs the fields below.
const to_public_review = (review) => ({
    _id: review._id,
    user_name: review.user_name,
    content: review.content,
    rating: review.rating,
    created_at: review.created_at
});

const get_product_reviews = async (req, res) => {
    try {
        // GET requests should not rely on a request body (many clients
        // and proxies strip it). Read product_id from the query string
        // primarily, falling back to the body for backward compatibility.
        const product_id = req.query.product_id || req.body?.product_id;

        if (!product_id) {
            return res.status(400).json({
                success: false,
                message: "product_id is required",
                data: []
            });
        }

        // Must be a real 24-hex ObjectId string. This also rejects arrays
        // and objects (e.g. ?product_id[$ne]=x), which would otherwise end
        // up inside the database query, and 12-character strings, which
        // mongoose's isValid() accepts.
        if (typeof product_id !== "string" || !/^[a-fA-F0-9]{24}$/.test(product_id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid product_id",
                data: []
            });
        }

        const product = await products
            .findOne({ _id: product_id })
            .select({ reviews: { $slice: -100 } })
            .lean();

        if (!product) {
            return res.status(404).json({
                success: false,
                message: "product not found",
                data: []
            });
        }

        // Older products may have no `reviews` field at all.
        const reviews = (Array.isArray(product.reviews) ? product.reviews : []).slice(-100);

        return res.status(200).json({
            success: true,
            message: "reviews retrieved successfully",
            data: reviews.map(to_public_review)
        });
    } catch (e) {
        console.error("Get product reviews error:", e.message);
        // Do not leak internal error details to the client
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = get_product_reviews;
