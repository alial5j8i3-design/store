const express = require("express");

const router = express.Router();

const get_user_orders = require("../controller/get_user_orders.conroller");

const auth = require("../middleware/auth")

router.get("/api/get_user_orders",auth,get_user_orders)

module.exports = router