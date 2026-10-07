const express = require("express");

const router = express.Router();

const get_cloudinary_config = require("../controller/get_cloudinary_config.controller");

const auth = require("../middleware/auth");

router.get(
    "/api/get_cloudinary_config",
    auth,
    get_cloudinary_config
);

module.exports = router;