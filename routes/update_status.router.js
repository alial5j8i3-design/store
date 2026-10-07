const express = require("express");

const router = express.Router();

const update_status_of_order = require("../controller/update_status_of_order.controller");

const auth_seller = require("../middleware/auth_seller")

router.put("/api/seller/update_status_of_order",auth_seller,update_status_of_order)

module.exports = router