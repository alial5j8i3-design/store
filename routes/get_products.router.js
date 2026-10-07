const express = require("express");

const router = express.Router();

const get_products = require("../controller/get_products.controller");

router.get("/api/get_products",get_products)

module.exports = router