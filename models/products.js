const mongoose = require("mongoose");

const schema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },

    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },

    price: {
      type: Number,
      required: true,
      min: 0,
      max: 1000000000,
    },

    discount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    final_price: {
      type: Number,
      default: 0,
      min: 0,
    },

    images: {
      type: [String],
      default:[],
    },
    
    section: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "section",
        required: true
    },
    
    reviews: {
      type: [Object],
      default: [],
    }, 

    quantity: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "quantity must be a whole number",
      },
    }, 

    // Missing on legacy documents is deliberately treated as active.
    is_active: {
      type: Boolean,
      default: true,
    },

    // FIX (Phase 1): was `type: String`. Every write path already stores
    // req.user._id.toString() here (see add_products.controller.js), so
    // the *values* were always valid ObjectId strings - but with a
    // String schema type, Mongo stored them as BSON strings, not BSON
    // ObjectIds. That meant a query like
    // `products.find({ seller_id: someObjectId })` would never match
    // anything (different BSON types don't compare equal), and
    // populate("seller_id") could never work.
    //
    // Existing documents still have seller_id stored as a raw BSON
    // string after this change ships - the schema type alone does not
    // rewrite data already in MongoDB. scripts/migrate_phase1.js
    // converts those in place; see that script and the migration
    // report for details.
    seller_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },

    // NEW (Phase 1): every product now belongs to a specific store, not
    // just a specific seller. This is what public store pages
    // (/store/:id, a later phase) and admin "manage this seller's
    // store" views will query against instead of re-deriving a seller's
    // product set indirectly.
    store_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "store",
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Every seller-scoped product query (get_seller_products, update, delete,
// ownership checks) filters on seller_id; every public store-page query
// (later phase) will filter on store_id. Both are hit on essentially
// every request that touches products, so both earn an index.
schema.index({ seller_id: 1, createdAt: -1 });
schema.index({ store_id: 1, createdAt: -1 });
schema.index({ createdAt: -1 });
schema.index({ section: 1, createdAt: -1 });
schema.index({ is_active: 1, createdAt: -1 });

module.exports = mongoose.model("products", schema);
