const express = require("express");

const router = express.Router();

const get_all_orders = require("../controller/get_all_orders.controller");

const auth_seller = require("../middleware/auth_seller")

router.get("/api/seller/get_all_orders",auth_seller,get_all_orders)

module.exports = router