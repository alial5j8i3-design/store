const mongoose = require("mongoose");

const schema = mongoose.Schema(
  {
    // No field-level `index: true` here: a single-field {user_id: 1} index
    // is a strict prefix of the compound indexes declared at the bottom of
    // this file, so it would only add write cost and storage.
    user_id: {
      type: String,
    },

    idempotency_key: {
      type: String,
      trim: true,
      maxlength: 128,
    },

    orderNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    products: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "products",
        },
        seller_id: {
          type: String,
          required: true,
        },
        name: {
          type: String,
          required: true,
          trim: true,
        },

        price: {
          type: Number,
          required: true,
          min: 0,
        },

        quantity: {
          type: Number,
          required: true,
          min: 1,
        },

        images: {
          type: [String],
          default: [],
        },
      },
    ],

    total_price: {
      type: Number,
      required: true,
      min: 0,
    },

    coupon_code: { type: String, trim: true },
    coupon_discount_percent: { type: Number, min: 0, max: 100 },
    subtotal_before_coupon: { type: Number, min: 0 },

    // Only set for newly cancelled orders when fallback restoration is
    // required. Missing on legacy orders means their historical lifecycle is
    // already complete and must not be restored again.
    stock_restored: { type: Boolean },
  
    user_name: {
      type: String,
      required: true,
    },

    phone_number: {
      type: String,
      required: true,
    },

    GPS_URL: {
      type: String,
      required: true,
    },
    whatsApp_number:{
      type: String,
      required: true,
    },
    // "new" = pending. Allowed transitions are enforced in
    // utils/order_stock.js (ALLOWED_TRANSITIONS).
    status:{
      type: String,
      required: true,
      enum: ["new", "processing", "shipped", "delivered", "cancelled"],
      default: "new",
    },
  },

  {
    timestamps: true,
  }
);

schema.index({ "products.seller_id": 1, createdAt: -1 });
schema.index({ user_id: 1, createdAt: -1 });
schema.index(
  { user_id: 1, idempotency_key: 1 },
  { unique: true, partialFilterExpression: { idempotency_key: { $type: "string" } } },
);

module.exports = mongoose.model("order", schema);