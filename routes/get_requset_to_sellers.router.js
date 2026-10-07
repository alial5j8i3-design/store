const express = require("express");

const router = express.Router();

const get_requset_to_sellers = require("../controller/get_requset_to_sellers.controller");

const auth_super_admin = require("../middleware/auth_super_admin")

router.get("/api/admin/get_requset_to_sellers",auth_super_admin,get_requset_to_sellers)

module.exports = router