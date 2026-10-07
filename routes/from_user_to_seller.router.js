const express = require("express");

const router = express.Router();

const from_user_to_seller = require("../controller/from_user_to_seller.controller");

const auth_super_admin = require("../middleware/auth_super_admin");

router.put("/api/admin/from_user_to_seller",auth_super_admin,from_user_to_seller);

module.exports = router