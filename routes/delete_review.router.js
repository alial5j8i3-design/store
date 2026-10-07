const express = require("express");
const auth_super_admin = require("../middleware/auth_super_admin");
const delete_review = require("../controller/delete_review.controller");

const router = express.Router();
router.delete("/api/admin/delete_review", auth_super_admin, delete_review);
module.exports = router;
