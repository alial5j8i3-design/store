require("dotenv").config();

const mongoose = require("mongoose");
const orders = require("../models/order");

async function reportMultiSellerOrders() {
    await mongoose.connect(process.env.MONGO_URL);
    const results = await orders.aggregate([
        {
            $project: {
                sellerIds: {
                    $setUnion: [
                        {
                            $filter: {
                                input: "$products.seller_id",
                                as: "sellerId",
                                cond: { $and: [{ $ne: ["$$sellerId", null] }, { $ne: ["$$sellerId", ""] }] },
                            },
                        },
                        [],
                    ],
                },
            },
        },
        { $match: { $expr: { $gt: [{ $size: "$sellerIds" }, 1] } } },
        { $project: { _id: 1 } },
    ]);

    console.log(results.length);
    for (const order of results) console.log(String(order._id));
}

reportMultiSellerOrders()
    .catch((error) => {
        console.error("Failed to report multi-seller orders:", error.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
