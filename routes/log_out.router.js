const express = require("express");

const router = express.Router();

const log_out = require("../controller/log_out.controller");

router.post("/api/auth/log_out", log_out);

module.exports = router;
