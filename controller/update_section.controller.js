const section = require("../models/section");
const mongoose = require("mongoose");
const cache = require("../utils/cache");
const socket_events = require("../utils/socket_events");
const { normalize_name, find_conflicting_section } = require("../utils/section_similarity");

const MIN_LEN = 2;
const MAX_LEN = 50;

// Same rule add_section.controller.js uses.
const FORBIDDEN_CHARS = /[<>{}\\`]/;

// PUT /api/admin/update_section   (auth_super_admin)
// Authentication/authorization is done by the auth_super_admin middleware
// in the route, so this controller no longer re-verifies the JWT by hand
// (an expired token used to throw here and come back as a 500).
const updated_section = async (req, res) => {
    try {
        const raw = typeof req.body.section_name === "string" ? req.body.section_name : "";
        const section_name = raw.replace(/\s+/g, " ").trim();
        const section_id = req.body.section_id;

        if (!section_name || !section_id) {
            return res.status(400).json({
                success: false,
                message: "section_name and section_id are required",
                data: []
            });
        }

        // FIX: an invalid id made findOneAndUpdate throw a CastError -> 500.
        if (typeof section_id !== "string" || !mongoose.Types.ObjectId.isValid(section_id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid section id",
                data: []
            });
        }

        if (section_name.length < MIN_LEN || section_name.length > MAX_LEN) {
            return res.status(400).json({
                success: false,
                message: `section name must be between ${MIN_LEN} and ${MAX_LEN} characters`,
                data: []
            });
        }

        if (FORBIDDEN_CHARS.test(section_name)) {
            return res.status(400).json({
                success: false,
                message: "section name contains forbidden characters",
                data: []
            });
        }

        // FIX: the section schema keeps a `normalized_name` (with a unique
        // partial index) that add_section uses to reject duplicates. The
        // old update only changed `name`, so normalized_name went stale:
        // renaming "Laptops" to "Phones" left normalized_name as "laptops",
        // and the duplicate check kept comparing against the OLD name.
        // It could also rename a section to a name that already exists.
        const normalized_name = normalize_name(section_name);

        if (!normalized_name) {
            return res.status(400).json({
                success: false,
                message: "section name is not valid",
                data: []
            });
        }

        // Same check as add_section: direct findOne + complete keyset scan,
        // excluding the section being renamed. Never limited to "first N".
        const similar = await find_conflicting_section(section, section_name, { exclude_id: section_id });

        if (similar) {
            return res.status(409).json({
                success: false,
                message: `Cannot rename: the name is the same as / very similar to the existing section "${similar.name}"`,
                data: { existing_section: { _id: similar._id, name: similar.name } }
            });
        }

        let update_section;

        try {
            update_section = await section.findOneAndUpdate(
                { _id: section_id },
                { name: section_name, normalized_name: normalized_name },
                { new: true }
            );
        } catch (updateError) {
            // Race with another request: the unique index is the real guard.
            if (updateError && updateError.code === 11000) {
                return res.status(409).json({
                    success: false,
                    message: "A section with this name already exists",
                    data: []
                });
            }
            throw updateError;
        }

        if (!update_section) {
            return res.status(404).json({
                success: false,
                message: "section not found",
                data: []
            });
        }

        await cache.del("sections");

        // Products populate the section name, so cached product lists show
        // the old name until they are cleared.
        await cache.delByPrefix("products");

        try {
            socket_events.emit_to(
                req.io,
                socket_events.CATALOG_ROOM,
                "update_section",
                socket_events.section_payload(update_section)
            );
        } catch (emitError) {
            console.log(emitError.message);
        }

        return res.status(200).json({
            success: true,
            message: "updated successfully",
            data: update_section
        });
    }
    catch (e) {
        console.log(e.message)
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

module.exports = updated_section