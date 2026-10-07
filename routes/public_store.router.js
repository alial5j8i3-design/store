const express = require("express");
const { get_public_store } = require("../controller/public_store.controller");

const router = express.Router();

router.get("/api/stores/:slug", get_public_store);

module.exports = router;
