const mongoose = require("mongoose");

// A coupon belongs to exactly ONE seller and is only valid for that
// seller's products (enforced in controller/order.controller.js).
//
// - `seller_id` is always taken from the authenticated seller
//   (req.user._id) on the server - never from the request body.
// - `name` is the coupon code. It is stored trimmed + UPPERCASE so codes
//   are case-insensitive, and it stays globally unique so a code typed at
//   checkout can only ever resolve to a single seller's coupon.
const schema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },

    discount: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },

    end_time: {
      type: Date,
      required: true,
    },

    seller_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Every seller-facing query (list / update / delete) filters on seller_id.
schema.index({ seller_id: 1, createdAt: -1 });

module.exports = mongoose.model("coupon", schema);