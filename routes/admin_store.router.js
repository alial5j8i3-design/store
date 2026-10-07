const express = require("express");

const router = express.Router();

const { list_stores, get_store, update_store } = require("../controller/admin_store.controller");

const auth_super_admin = require("../middleware/auth_super_admin");

router.get("/api/admin/stores", auth_super_admin, list_stores);
router.get("/api/admin/store/:store_id", auth_super_admin, get_store);
router.put("/api/admin/store/:store_id", auth_super_admin, update_store);

module.exports = router;
