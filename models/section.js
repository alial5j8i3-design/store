const mongoose = require("mongoose");

const schema = mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
    },

    // Lower-cased / diacritic-free form of `name`, used to detect a new
    // category that duplicates an existing one.
    normalized_name: {
      type: String,
      trim: true,
    },

    // The seller who added the category (categories are now created by
    // sellers). Old categories created by the super admin have no value.
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
    },
  },
  {
    timestamps: true,
  },
);

// Hard guarantee against exact duplicates even under concurrent requests.
// Partial so that old sections (without normalized_name) don't collide.
schema.index(
  { normalized_name: 1 },
  { unique: true, partialFilterExpression: { normalized_name: { $type: "string" } } },
);

module.exports = mongoose.model("section", schema);