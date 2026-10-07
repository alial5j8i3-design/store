const express = require("express");

const router = express.Router();

const get_all_sections = require("../controller/get_all_sections.controller");

router.get("/api/get_all_sections",get_all_sections)

module.exports = router