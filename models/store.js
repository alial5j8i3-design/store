const mongoose = require("mongoose");

const schema = mongoose.Schema(
  {

    owner_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },

    store_name: {
      type: String,
      required: true,
      trim: true,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    },

    store_description: {
      type: String,
      trim: true,
    },

    store_phone: {
      type: String,
      trim: true,
    },

    store_whatsApp_number: {
      type: String,
      trim: true,
    },

    store_GPS: {
      type: String,
      trim: true,
    },

    store_design: {
      type: Object,
    },
  },
  {
    timestamps: true,
  },
);


schema.index(
  { owner_id: 1 },
  { unique: true, partialFilterExpression: { owner_id: { $exists: true } } },
);

module.exports = mongoose.model("store", schema);
