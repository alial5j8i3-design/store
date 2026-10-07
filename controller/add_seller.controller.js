const promotion_requests = require("../models/Promotion_requests_for_salesperson");
const { PHONE_REGEX, is_valid_http_url } = require("../utils/validators");

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_URL_LENGTH = 500;

const bad_request = (res, message) =>
    res.status(400).json({
        success: false,
        message: message
    });

const promotion_requests_for_salesperson = async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
                data: []
            });
        }

        // Sellers and the super admin already have the role: a request from
        // them would sit in the admin's list forever (and the admin's
        // "upgrade" action rejects non-user accounts anyway).
        if (req.user.role !== "user") {
            return res.status(403).json({
                success: false,
                message: "Only regular user accounts can request a seller promotion"
            });
        }

        // Every field must be a string (a JSON body can send objects/arrays,
        // which would crash .trim() or be saved in an unexpected shape).
        const fields = [
            req.body.name,
            req.body.description,
            req.body.phone_number,
            req.body.GPS_URL,
            req.body.whatsApp_number
        ];

        if (!fields.every((value) => typeof value === "string")) {
            return bad_request(
                res,
                "Name, description, phone number, whatsApp number and GPS URL are required"
            );
        }

        const user_name = req.body.name.trim();
        const email = typeof req.user.email === "string" ? req.user.email.trim().toLowerCase() : "";
        const description = req.body.description.trim();
        const phone_number = req.body.phone_number.trim();
        const GPS_URL = req.body.GPS_URL.trim();
        const whatsApp_number = req.body.whatsApp_number.trim();

        // ==============================
        // Validate required data
        // ==============================

        if (
            !user_name ||
            !email ||
            !description ||
            !phone_number ||
            !whatsApp_number ||
            !GPS_URL
        ) {
            return bad_request(
                res,
                "Name, description, phone number, whatsApp number and GPS URL are required"
            );
        }

        if (user_name.length > MAX_NAME_LENGTH) {
            return bad_request(res, `Name must be at most ${MAX_NAME_LENGTH} characters`);
        }

        if (!email) return bad_request(res, "Your account email is required");

        if (description.length > MAX_DESCRIPTION_LENGTH) {
            return bad_request(
                res,
                `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`
            );
        }

        if (!PHONE_REGEX.test(phone_number)) {
            return bad_request(res, "Invalid phone number");
        }

        if (!PHONE_REGEX.test(whatsApp_number)) {
            return bad_request(res, "Invalid whatsApp number");
        }

        if (!is_valid_http_url(GPS_URL, MAX_URL_LENGTH)) {
            return bad_request(res, "GPS URL must be a valid http/https link");
        }

        const add_request = new promotion_requests({
            user_id: req.user._id,
            name: user_name,
            email: email,
            description: description,
            phone_number: phone_number,
            GPS_URL: GPS_URL,
            whatsApp_number: whatsApp_number
        });

        try {
            await add_request.save();
        } catch (saveError) {
            // user_id is unique: one promotion request per account.
            if (saveError.code === 11000) {
                return res.status(409).json({
                    success: false,
                    message: "You have already submitted a promotion request"
                });
            }
            throw saveError;
        }

        return res.status(201).json({
            success: true,
            message: "added successful"
        });
    } catch (e) {
        console.error("Promotion request error:", e.message);
        // Do not leak internal error details to the client
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = promotion_requests_for_salesperson;