const express = require("express");

const router = express.Router();

const get_seller_products = require("../controller/get_seller_products.controller");

const auth_seller = require("../middleware/auth_seller")

router.get("/api/get_seller_products",auth_seller,get_seller_products)

module.exports = router