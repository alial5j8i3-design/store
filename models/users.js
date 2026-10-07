const mongoose = require("mongoose");

const schema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    password: {
      type: String,
      required: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },

    role: {
      type: String,
      enum: ["user", "seller", "super_admin"],
      default: "user",
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

// The registration controller performs an early check for usability, but
// only the database can prevent two concurrent first-admin registrations.
schema.index(
  { role: 1 },
  {
    unique: true,
    partialFilterExpression: { role: "super_admin" },
  },
);

module.exports = mongoose.model("user", schema);
