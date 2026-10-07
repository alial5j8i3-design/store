const express = require("express");

const router = express.Router();

const update_section = require("../controller/update_section.controller");

const auth_super_admin = require("../middleware/auth_super_admin")

router.put("/api/admin/update_section",auth_super_admin,update_section)

module.exports = router