const section = require("../models/section");
const products = require("../models/products");
const cache = require("../utils/cache");
const socket_events = require("../utils/socket_events");

// Route is protected by auth_super_admin (routes/delete_section.router.js).

const DEL_section = async (req, res) => {
    try {
        const section_id = req.body.section_id;

        if (!section_id) {
            return res.status(400).json({
                success: false,
                message: "section id is required",
                data: []
            });
        }

        // Must be a real 24-hex ObjectId string (isValid() alone also
        // accepts any 12-character string and non-string inputs).
        if (typeof section_id !== "string" || !/^[a-fA-F0-9]{24}$/.test(section_id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid section id",
                data: []
            });
        }

        // products.section is a required reference to this collection and
        // the product lists populate it. Deleting a section that still has
        // products would leave those products pointing at nothing (section
        // shown as null on the store pages and product lists), so it is
        // refused until the products are moved to another section or removed.
        const products_count = await products.countDocuments({ section: section_id });

        if (products_count > 0) {
            return res.status(409).json({
                success: false,
                message: `Cannot delete this section because ${products_count} product(s) still use it`,
                data: { products_count }
            });
        }

        const deleted_section = await section.findByIdAndDelete(section_id);

        if (!deleted_section) {
            return res.status(404).json({
                success: false,
                message: "Section not found",
                data: []
            });
        }

        // The count above and the delete are two separate operations, so a
        // product could (rarely) be created on this section in between.
        // Check once more after the delete: if such a product exists, it now
        // points at a missing section, so log a warning for follow-up. This
        // never changes the response or turns a successful delete into a 500.
        try {
            const orphaned_count = await products.countDocuments({ section: section_id });

            if (orphaned_count > 0) {
                console.warn(
                    `[admin] WARNING: section ${deleted_section._id} ("${deleted_section.name}") was deleted but ${orphaned_count} product(s) now reference it. Move them to another section or re-create the section.`
                );
            }
        } catch (check_error) {
            console.warn("Delete section post-check failed:", check_error.message);
        }

        await cache.del("sections");

        // Audit trail: who deleted which section.
        console.info(
            `[admin] section ${deleted_section._id} ("${deleted_section.name}") deleted by ${req.user?._id}`
        );

        // req.io may be missing (e.g. in tests); emit_to ignores it and
        // never lets a socket problem turn a successful delete into a 500.
        socket_events.emit_to(
            req.io,
            socket_events.CATALOG_ROOM,
            "deleted_section",
            socket_events.section_payload(deleted_section)
        );

        return res.status(200).json({
            success: true,
            message: "Section deleted successfully",
            data: []
        });
    } catch (e) {
        console.error("Delete section error:", e.message);
        // Do not leak internal error details to the client
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = DEL_section;