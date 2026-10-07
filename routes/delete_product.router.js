const express = require("express");

const router = express.Router();

const delete_product = require("../controller/delete_product.controller");

const auth_seller_or_admin = require("../middleware/auth_seller_or_admin")

router.delete("/api/seller/delete_product",auth_seller_or_admin,delete_product)

module.exports = router