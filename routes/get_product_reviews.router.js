const express = require("express");

const router = express.Router();

const get_product_reviews = require("../controller/get_product_reviews.controller");

const auth = require("../middleware/auth")

router.get("/api/get_product_reviews",auth,get_product_reviews)

module.exports = router