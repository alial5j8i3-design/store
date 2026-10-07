const express = require("express");

const router = express.Router();

const {
  get_my_coupons,
  create_my_coupon,
  update_my_coupon,
  delete_my_coupon,
} = require("../controller/seller_coupon.controller");

const auth_seller = require("../middleware/auth_seller");

// Sellers only (auth_seller rejects every other role, including super_admin).
// Every handler scopes its query by req.user._id - never by a client value.
router.get("/api/seller/coupons", auth_seller, get_my_coupons);
router.post("/api/seller/coupons", auth_seller, create_my_coupon);
router.put("/api/seller/coupons/:id", auth_seller, update_my_coupon);
router.delete("/api/seller/coupons/:id", auth_seller, delete_my_coupon);

module.exports = router;