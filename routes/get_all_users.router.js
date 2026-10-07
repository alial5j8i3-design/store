const express = require("express");

const router = express.Router();

const get_all_users = require("../controller/get_all_users.controller");

const auth_super_admin = require("../middleware/auth_super_admin")

router.get("/api/admin/get_all_users",auth_super_admin,get_all_users)

module.exports = router