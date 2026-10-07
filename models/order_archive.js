const mongoose = require("mongoose");

const schema = mongoose.Schema({
    order_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    order_updated_at: { type: Date, required: true },
    order: { type: mongoose.Schema.Types.Mixed, required: true },
    removed_by: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
    reason: { type: String, enum: ["seller_delete"], required: true },
    removed_items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // Set only on a "removal record": when another request had already archived the
    // same order version, the removal that actually succeeded is attributed in a second
    // row keyed by the version it produced; this field points back to the version whose
    // snapshot it was applied to.
    source_order_updated_at: { type: Date },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One snapshot per order version prevents retry/concurrency duplicates.
schema.index({ order_id: 1, order_updated_at: 1 }, { unique: true });

const ttlDays = Number(process.env.ORDER_ARCHIVE_TTL_DAYS || 0);
if (Number.isFinite(ttlDays) && ttlDays > 0) {
    schema.index({ createdAt: 1 }, { expireAfterSeconds: Math.floor(ttlDays * 24 * 60 * 60) });
}

module.exports = mongoose.model("order_archive", schema);