require("dotenv").config();

const mongoose = require("mongoose");
const coupons = require("../models/coupon");

// Coupon code: 3-30 chars, letters / digits / "-" / "_" only. Stored
// uppercase, so "used20" and "USED20" are the same code.
const CODE_REGEX = /^[A-Z0-9_-]{3,30}$/;

const MAX_COUPONS_PER_SELLER_LIST = 200;

function normalize_code(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

// Validates + normalizes the writable coupon fields. Only these three
// fields can ever be written from a request body: seller_id is NEVER read
// from the client. When `partial` is true (update), missing fields are
// skipped instead of rejected.
//
// Returns { data } or { error } (a client-safe message).
function pick_coupon_fields(body, { partial = false } = {}) {
  const src = body && typeof body === "object" ? body : {};
  const data = {};

  if (src.coupon_name !== undefined || !partial) {
    const code = normalize_code(src.coupon_name);

    if (!code) {
      return { error: "coupon_name is required" };
    }

    if (!CODE_REGEX.test(code)) {
      return {
        error:
          "coupon_name must be 3-30 characters: English letters, digits, '-' or '_' only",
      };
    }

    data.name = code;
  }

  if (src.discount !== undefined || !partial) {
    // Reject "", null, booleans, arrays...: Number("") is 0 and
    // Number(null) is 0, which would silently pass a finite check.
    const isNumeric =
      (typeof src.discount === "number" ||
        (typeof src.discount === "string" && src.discount.trim() !== ""));
    const discount = isNumeric ? Number(src.discount) : NaN;

    if (!Number.isFinite(discount) || discount <= 0 || discount > 100) {
      return { error: "Discount must be a number greater than 0 and at most 100" };
    }

    data.discount = Math.round(discount * 100) / 100;
  }

  if (src.end_time !== undefined || !partial) {
    if (typeof src.end_time !== "string" || src.end_time.trim() === "") {
      return { error: "end_time is required" };
    }

    const end = new Date(src.end_time.trim());

    if (Number.isNaN(end.getTime())) {
      return { error: "Invalid end_time" };
    }

    if (end.getTime() <= Date.now()) {
      return { error: "Coupon expiration date must be in the future" };
    }

    data.end_time = end;
  }

  return { data };
}

function is_valid_id(id) {
  return typeof id === "string" && mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id;
}

const DUPLICATE_MESSAGE = "This coupon code is already in use, please choose another one";

// GET /api/seller/coupons
// Lists ONLY the authenticated seller's coupons (filter is seller_id from
// req.user, set by auth_seller).
const get_my_coupons = async (req, res) => {
  try {
    const list = await coupons
      .find({ seller_id: req.user._id })
      .sort({ createdAt: -1 })
      .limit(MAX_COUPONS_PER_SELLER_LIST)
      .lean();

    return res.status(200).json({
      success: true,
      message: "coupons fetched successfully",
      data: list,
    });
  } catch (e) {
    console.error("get_my_coupons error:", e.message);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
      data: [],
    });
  }
};

// POST /api/seller/coupons
const create_my_coupon = async (req, res) => {
  try {
    const { data, error } = pick_coupon_fields(req.body);

    if (error) {
      return res.status(400).json({ success: false, message: error, data: null });
    }

    const existing = await coupons.findOne({ name: data.name }).select("_id").lean();

    if (existing) {
      return res.status(409).json({ success: false, message: DUPLICATE_MESSAGE, data: null });
    }

    const new_coupon = new coupons({
      ...data,
      seller_id: req.user._id,
    });

    try {
      await new_coupon.save();
    } catch (saveError) {
      // Race between two concurrent creates of the same code: the unique
      // index is the real guard, this turns it into a clean 409.
      if (saveError && saveError.code === 11000) {
        return res.status(409).json({ success: false, message: DUPLICATE_MESSAGE, data: null });
      }

      throw saveError;
    }

    return res.status(201).json({
      success: true,
      message: "Coupon added successfully",
      data: new_coupon,
    });
  } catch (e) {
    console.error("create_my_coupon error:", e.message);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
      data: null,
    });
  }
};

// PUT /api/seller/coupons/:id
// The filter is { _id, seller_id: req.user._id }: a seller can never match
// (and therefore never modify) another seller's coupon. A coupon that
// belongs to someone else is indistinguishable from a missing one (404).
const update_my_coupon = async (req, res) => {
  try {
    const id = req.params.id;

    if (!is_valid_id(id)) {
      return res.status(400).json({ success: false, message: "Invalid coupon id", data: null });
    }

    const { data, error } = pick_coupon_fields(req.body, { partial: true });

    if (error) {
      return res.status(400).json({ success: false, message: error, data: null });
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one updatable field is required",
        data: null,
      });
    }

    if (data.name !== undefined) {
      const clash = await coupons
        .findOne({ name: data.name, _id: { $ne: id } })
        .select("_id")
        .lean();

      if (clash) {
        return res.status(409).json({ success: false, message: DUPLICATE_MESSAGE, data: null });
      }
    }

    let updated;

    try {
      updated = await coupons.findOneAndUpdate(
        { _id: id, seller_id: req.user._id },
        data,
        { new: true, runValidators: true }
      );
    } catch (updateError) {
      if (updateError && updateError.code === 11000) {
        return res.status(409).json({ success: false, message: DUPLICATE_MESSAGE, data: null });
      }

      throw updateError;
    }

    if (!updated) {
      return res.status(404).json({ success: false, message: "Coupon not found", data: null });
    }

    return res.status(200).json({
      success: true,
      message: "Coupon updated successfully",
      data: updated,
    });
  } catch (e) {
    console.error("update_my_coupon error:", e.message);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
      data: null,
    });
  }
};

// DELETE /api/seller/coupons/:id  (own coupons only - same ownership filter)
const delete_my_coupon = async (req, res) => {
  try {
    const id = req.params.id;

    if (!is_valid_id(id)) {
      return res.status(400).json({ success: false, message: "Invalid coupon id", data: null });
    }

    const deleted = await coupons.findOneAndDelete({
      _id: id,
      seller_id: req.user._id,
    });

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Coupon not found", data: null });
    }

    return res.status(200).json({
      success: true,
      message: "Coupon deleted successfully",
      data: { _id: deleted._id },
    });
  } catch (e) {
    console.error("delete_my_coupon error:", e.message);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
      data: null,
    });
  }
};

module.exports = {
  get_my_coupons,
  create_my_coupon,
  update_my_coupon,
  delete_my_coupon,
};