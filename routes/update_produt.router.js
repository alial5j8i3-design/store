const express = require("express");

const router = express.Router();

const update_product = require("../controller/update_product.controller");

const auth_seller_or_admin = require("../middleware/auth_seller_or_admin")

router.put("/api/admin/update_product",auth_seller_or_admin,update_product)

module.exports = router