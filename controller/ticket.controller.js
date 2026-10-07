const mongoose = require("mongoose");
const store = require("../models/store");
const ticket = require("../models/ticket");
const orders = require("../models/order");
const { seller_room } = require("../utils/socket_events");
const { check_optional_http_url, is_valid_image_url } = require("../utils/validators");
const { read_pagination } = require("../utils/pagination");

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PHONE_PATTERN = /^[0-9+\s-]{7,20}$/;

// Issue types that require a photo (same as the "Photo Required" badges on
// the help-center page).
const PHOTO_REQUIRED = new Set(["damaged", "return", "incomplete"]);

function clean(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isAllowedImageUrl(value) {
    try {
        // Shared safety rules (no credentials/ports/internal hosts/SVG/unsafe
        // characters), then a strict host allowlist: ALLOWED_IMAGE_HOSTS plus
        // Cloudinary, which is where help-center.html uploads the photo.
        // Without the Cloudinary entry no uploaded photo was ever accepted,
        // so the "photo required" issue types could not be filed.
        if (!is_valid_image_url(value, 600)) return false;
        const url = new URL(value);
        const allowedHosts = String(process.env.ALLOWED_IMAGE_HOSTS || "")
            .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
        allowedHosts.push("res.cloudinary.com");
        return url.protocol === "https:" && allowedHosts.includes(url.hostname.toLowerCase());
    } catch (_) {
        return false;
    }
}

// POST /api/stores/:slug/tickets   (auth - any logged-in user)
// Opens a ticket that is delivered ONLY to the owner of that store.
const create_ticket = async (req, res) => {
    try {
        const slug = typeof req.params.slug === "string" ? req.params.slug.toLowerCase() : "";
        if (!SLUG_PATTERN.test(slug) || slug.length > 120) {
            return res.status(400).json({ success: false, message: "رابط المتجر غير صحيح", data: null });
        }

        const found = await store.findOne({ slug }).select("_id owner_id").lean();
        if (!found) {
            return res.status(404).json({ success: false, message: "المتجر غير موجود", data: null });
        }

        if (String(found.owner_id) === String(req.user._id)) {
            return res.status(400).json({
                success: false,
                message: "لا يمكنك فتح تذكرة على متجرك الخاص",
                data: null,
            });
        }

        const issue_type = clean(req.body.issue_type, 30);
        if (!ticket.ISSUE_TYPES.includes(issue_type)) {
            return res.status(400).json({ success: false, message: "يرجى اختيار نوع المشكلة", data: null });
        }

        const phone_number = clean(req.body.phone_number, 25);
        if (!PHONE_PATTERN.test(phone_number)) {
            return res.status(400).json({ success: false, message: "يرجى إدخال رقم هاتف صحيح", data: null });
        }

        const whatsApp_number = clean(req.body.whatsApp_number, 25);
        if (whatsApp_number && !PHONE_PATTERN.test(whatsApp_number)) {
            return res.status(400).json({ success: false, message: "رقم الواتساب غير صحيح", data: null });
        }

        const details = typeof req.body.details === "string" ? req.body.details.trim() : "";
        if (details.length > 2000) {
            return res.status(400).json({ success: false, message: "تفاصيل المشكلة طويلة جداً", data: null });
        }
        if (details.length < 10) {
            return res.status(400).json({
                success: false,
                message: "يرجى شرح المشكلة بالتفصيل (10 أحرف على الأقل)",
                data: null,
            });
        }

        const location_check = check_optional_http_url(req.body.location_url, 500);
        if (!location_check.ok) {
            return res.status(400).json({ success: false, message: "رابط الموقع غير صحيح", data: null });
        }
        const location_url = location_check.value;

        // Reject (do not silently truncate) an oversized photo url.
        if (typeof req.body.photo_url === "string" && req.body.photo_url.trim().length > 600) {
            return res.status(400).json({ success: false, message: "رابط الصورة غير صحيح", data: null });
        }
        const photo_url = clean(req.body.photo_url, 600);
        if (photo_url && !isAllowedImageUrl(photo_url)) {
            return res.status(400).json({ success: false, message: "رابط الصورة غير صحيح", data: null });
        }

        const order_number = clean(req.body.order_number, 40);
        if (order_number) {
            const belongsToCustomer = await orders.exists({
                orderNumber: order_number,
                user_id: String(req.user._id),
                "products.seller_id": String(found.owner_id),
            });
            if (!belongsToCustomer) {
                return res.status(400).json({ success: false, message: "رقم الطلب لا يخص هذا المتجر أو حسابك", data: null });
            }
        }

        const ticketCount = await ticket.countDocuments({
            customer_id: req.user._id,
            store_id: found._id,
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        });
        if (ticketCount >= 5) {
            return res.status(429).json({ success: false, message: "لقد أرسلت عدداً كبيراً من التذاكر. حاول لاحقاً.", data: null });
        }
        if (PHOTO_REQUIRED.has(issue_type) && !photo_url) {
            return res.status(400).json({
                success: false,
                message: "هذا النوع من المشاكل يتطلب إرفاق صورة توضح المشكلة",
                data: null,
            });
        }

        const created = await ticket.create({
            store_id: found._id,
            seller_id: found.owner_id,
            customer_id: req.user._id,
            customer_name: req.user.name,
            issue_type,
            order_number,
            phone_number,
            whatsApp_number,
            location_url,
            details,
            photo_url,
        });

        try {
            req.io?.to(seller_room(found.owner_id)).emit("new_ticket", { _id: created._id });
        } catch (error) {
            console.error("Ticket socket emit failed:", error.message);
        }

        return res.status(201).json({
            success: true,
            message: "تم إرسال مشكلتك إلى البائع بنجاح",
            data: { _id: created._id, status: created.status },
        });
    } catch (e) {
        console.error("create_ticket error:", e.message);
        return res.status(500).json({ success: false, message: "Internal server error", data: null });
    }
};

// GET /api/seller/tickets   (auth_seller)
// Only the logged-in seller's own tickets: the filter uses req.user._id.
const get_my_tickets = async (req, res) => {
    try {
        const pg = read_pagination(req, res, { defaultLimit: 50, maxLimit: 100 });
        if (!pg) return;
        const { page, limit, skip } = pg;

        const filter = { seller_id: req.user._id };
        if (ticket.STATUSES.includes(req.query.status)) filter.status = req.query.status;

        const [items, total] = await Promise.all([
            ticket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            ticket.countDocuments(filter),
        ]);

        return res.status(200).json({
            success: true,
            message: "tickets fetched successfully",
            data: items,
            pagination: { page, limit, total },
        });
    } catch (e) {
        console.error("get_my_tickets error:", e.message);
        return res.status(500).json({ success: false, message: "Internal server error", data: [] });
    }
};

// PATCH /api/seller/tickets/:id/status   (auth_seller)
const update_ticket_status = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid ticket id", data: null });
        }
        const status = clean(req.body.status, 20);
        if (!ticket.STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status", data: null });
        }

        // seller_id in the filter => a seller can never touch another store's ticket
        const updated = await ticket.findOneAndUpdate(
            { _id: id, seller_id: req.user._id },
            { status },
            { new: true },
        );
        if (!updated) {
            return res.status(404).json({ success: false, message: "Ticket not found", data: null });
        }

        return res.status(200).json({ success: true, message: "updated successfully", data: updated });
    } catch (e) {
        console.error("update_ticket_status error:", e.message);
        return res.status(500).json({ success: false, message: "Internal server error", data: null });
    }
};

module.exports = { create_ticket, get_my_tickets, update_ticket_status, isAllowedImageUrl };