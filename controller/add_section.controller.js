const section = require("../models/section");
const cache = require("../utils/cache");
const socket_events = require("../utils/socket_events");
const { normalize_name, find_conflicting_section } = require("../utils/section_similarity");

const MIN_LEN = 2;
const MAX_LEN = 50;

// Blocks characters used to inject HTML/scripts into a category name
const FORBIDDEN_CHARS = /[<>{}\\`]/;

// POST /api/seller/add_section   (auth_seller)
// Any seller may ADD a category. Sellers (and admins) can no longer edit or
// delete categories. A category that is the same as / very similar to an
// existing one is rejected with an explanatory message.
const add_section = async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ success: false, message: "Not authenticated", data: [] });
        }

        const raw = typeof req.body.section_name === "string" ? req.body.section_name : "";
        const section_name = raw.replace(/\s+/g, " ").trim();

        if (!section_name) {
            return res.status(400).json({ success: false, message: "اسم القسم مطلوب", data: [] });
        }
        if (section_name.length < MIN_LEN || section_name.length > MAX_LEN) {
            return res.status(400).json({
                success: false,
                message: `اسم القسم يجب أن يكون بين ${MIN_LEN} و ${MAX_LEN} حرفاً`,
                data: [],
            });
        }
        if (FORBIDDEN_CHARS.test(section_name)) {
            return res.status(400).json({
                success: false,
                message: "اسم القسم يحتوي على رموز غير مسموحة",
                data: [],
            });
        }

        const normalized_name = normalize_name(section_name);
        if (!normalized_name) {
            return res.status(400).json({ success: false, message: "اسم القسم غير صالح", data: [] });
        }

        // Direct findOne for the exact duplicate + a COMPLETE keyset scan for
        // near duplicates (never "first N rows"). The unique index on
        // normalized_name remains the hard guarantee under concurrency (see
        // the 11000 handler below).
        const similar = await find_conflicting_section(section, section_name);

        if (similar) {
            return res.status(409).json({
                success: false,
                message: `لا يمكن إضافة القسم "${section_name}" لأنه مشابه لقسم موجود بالفعل في الموقع وهو "${similar.name}". يرجى اختيار القسم الموجود بدلاً من إنشاء قسم جديد.`,
                data: { existing_section: { _id: similar._id, name: similar.name } },
            });
        }

        const new_section = new section({
            name: section_name,
            normalized_name,
            created_by: req.user._id,
        });

        try {
            await new_section.save();
        } catch (saveError) {
            if (saveError.code === 11000) {
                return res.status(409).json({
                    success: false,
                    message: `القسم "${section_name}" موجود بالفعل في الموقع.`,
                    data: [],
                });
            }
            throw saveError;
        }

        await cache.del("sections");

        // Public notification: id + name only (the full document also
        // contains `created_by`, the creating seller's id).
        socket_events.emit_to(
            req.io,
            socket_events.CATALOG_ROOM,
            "new_section",
            socket_events.section_payload(new_section)
        );

        return res.status(201).json({
            success: true,
            message: "add successfully",
            data: new_section,
        });
    } catch (e) {
        console.error("Add section error:", e.message);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

module.exports = add_section;