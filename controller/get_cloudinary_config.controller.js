// GET /api/get_cloudinary_config   (requires login, see the router)
// Returns the Cloudinary settings the frontend needs to upload images
// directly from the browser. This reads ONLY from process.env - there is
// no hardcoded fallback here on purpose, so changing the .env is the one
// and only way to change which Cloudinary account/preset the site uses.
const get_cloudinary_config = (req, res) => {
    try {
        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;

        const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

        if (!cloudName || !uploadPreset) {
            // The details go to the server log only. Before, the response
            // told every visitor the names of the server's environment
            // variables.
            console.error(
                "Cloudinary is not configured: missing CLOUDINARY_CLOUD_NAME / CLOUDINARY_UPLOAD_PRESET in .env"
            );

            return res.status(503).json({
                success: false,
                message: "Image upload is not available right now",
                data: null
            });
        }

        return res.status(200).json({
            success: true,
            message: "Cloudinary config",
            data: {
                cloudName,
                uploadPreset,
                uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`
            }
        });
    } catch (error) {
        console.error("Cloudinary config error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Internal server error",
            data: null
        });
    }
};

module.exports = get_cloudinary_config;