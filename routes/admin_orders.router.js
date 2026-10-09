const express = require("express");

const router = express.Router();

const { list_all_orders } = require("../controller/admin_orders.controller");

const auth_super_admin = require("../middleware/auth_super_admin");

router.get("/api/admin/orders", auth_super_admin, list_all_orders);

module.exports = router;