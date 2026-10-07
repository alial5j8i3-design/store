const express = require("express");

const router = express.Router();

const delete_order = require("../controller/delete_order.controller");

const auth_seller = require("../middleware/auth_seller")

router.delete("/api/seller/delete_order",auth_seller,delete_order)

module.exports = router