const express = require("express");
const { createRateLimiter } = require("../utils/rate_limit_store");

const router = express.Router();

const { create_ticket, get_my_tickets, update_ticket_status } = require("../controller/ticket.controller");
const auth = require("../middleware/auth");
const auth_seller = require("../middleware/auth_seller");

// stop ticket spam: 8 tickets / 15 min / IP
const ticketLimiter = createRateLimiter({
    prefix: "ticket-user",
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user._id),
    message: { success: false, message: "لقد أرسلت عدداً كبيراً من التذاكر. حاول لاحقاً.", data: null },
});

// customer -> store owner
router.post("/api/stores/:slug/tickets", auth, ticketLimiter, create_ticket);

// store owner inbox
router.get("/api/seller/tickets", auth_seller, get_my_tickets);
router.patch("/api/seller/tickets/:id/status", auth_seller, update_ticket_status);

module.exports = router;
