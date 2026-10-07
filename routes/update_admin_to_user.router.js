const express = require("express");

const router = express.Router();

const update_admin_to_user = require("../controller/update_admin_to_user.controller");

const auth_super_admin = require("../middleware/auth_super_admin")

router.put("/api/admin/update_admin_to_user",auth_super_admin,update_admin_to_user)

module.exports = router