const mongoose = require("mongoose");

const ISSUE_TYPES = ["damaged", "delayed", "payment", "return", "incomplete", "other"];
const STATUSES = ["new", "in_progress", "resolved"];

const schema = mongoose.Schema(
  {
    // The store the ticket was opened for, and its owner. Both are derived
    // on the server from the store slug - never trusted from the client -
    // so a ticket can only ever reach that one seller.
    store_id: { type: mongoose.Schema.Types.ObjectId, ref: "store", required: true },
    seller_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },

    customer_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
    customer_name: { type: String, trim: true },

    issue_type: { type: String, enum: ISSUE_TYPES, required: true },
    order_number: { type: String, trim: true, maxlength: 40 },
    phone_number: { type: String, required: true, trim: true, maxlength: 25 },
    whatsApp_number: { type: String, trim: true, maxlength: 25 },
    location_url: { type: String, trim: true, maxlength: 500 },
    details: { type: String, required: true, trim: true, maxlength: 2000 },
    photo_url: { type: String, trim: true, maxlength: 600 },

    status: { type: String, enum: STATUSES, default: "new" },
  },
  { timestamps: true },
);

schema.index({ seller_id: 1, createdAt: -1 });
schema.index({ customer_id: 1, store_id: 1, createdAt: -1 });

const model = mongoose.model("ticket", schema);
model.ISSUE_TYPES = ISSUE_TYPES;
model.STATUSES = STATUSES;
module.exports = model;
