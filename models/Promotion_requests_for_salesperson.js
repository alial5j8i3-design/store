const mongoose = require("mongoose");

const schema = mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    name: {
      type: String,
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
    },
    phone_number: {
      type: String,
      trim: true,
    },

    GPS_URL: {
      type: String,
      trim: true,
    },

    whatsApp_number: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

schema.index({ user_id: 1 }, { unique: true });

module.exports = mongoose.model(
  "promotion_request",
  schema,
  "Promotion requests for a salesperson"
);