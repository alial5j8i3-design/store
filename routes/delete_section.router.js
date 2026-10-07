const express = require("express");

const router = express.Router();

const delete_section = require("../controller/delete_section.controller");

const auth_super_admin = require("../middleware/auth_super_admin")

router.delete("/api/admin/delete_section",auth_super_admin,delete_section)

module.exports = router