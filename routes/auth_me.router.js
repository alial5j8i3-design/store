const express = require("express");

const router = express.Router();

const auth_me_controller = require("../controller/auth_me.controller");

router.get(
    "/api/auth/me",
    auth_me_controller
);

module.exports = router;