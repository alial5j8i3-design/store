const sections = require("../models/section");
const cache = require("../utils/cache");
const { MAX_SECTION_ROWS } = require("../utils/pagination");

// Public endpoint (no auth): everything returned here is visible to anyone.
const get_all_sections = async (req, res) => {
    try {
        // Check Cache
        const cachedSections = await cache.get("sections");

        if (cachedSections) {
            return res.status(200).json({
                success: true,
                message: "successfully",
                data: cachedSections
            });
        }

        // Only the fields the site needs. The full document also contains
        // `created_by` (the id of the seller account that created the
        // category) and internal fields (`normalized_name`, timestamps),
        // which were exposed to the public.
        // Bounded (MAX_SECTION_ROWS) so a runaway number of seller-created
        // categories can never turn this public endpoint into a full scan.
        const all_sections = await sections.find().select("_id name").sort({ _id: 1 }).limit(MAX_SECTION_ROWS).lean();

        if (all_sections.length === 0) {
            return res.status(200).json({
                success: true,
                message: "no sections found",
                data: []
            });
        }

        // Save sections in Cache
        await cache.set("sections", all_sections);

        return res.status(200).json({
            success: true,
            message: "successfully",
            data: all_sections
        });
    } catch (e) {
        console.error("Get all sections error:", e.message);
        // Do not leak internal error details to the client
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = get_all_sections;