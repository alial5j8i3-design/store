const express = require("express");

const router = express.Router();

const { get_my_store, create_my_store, update_my_store } = require("../controller/seller_store.controller");

const auth_seller = require("../middleware/auth_seller");

router.get("/api/seller/store", auth_seller, get_my_store);
router.post("/api/seller/store", auth_seller, create_my_store);
router.put("/api/seller/store", auth_seller, update_my_store);

module.exports = router;
