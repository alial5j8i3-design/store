require("dotenv").config();

const { verifyToken } = require("../utils/jwt");
const { extract_token } = require("../utils/request_token");
const mongoose = require("mongoose");
const users = require("../models/users");

const auth_me = async (req, res) => {
    try {

        // Cookie first, then Authorization: Bearer (see request_token.js).
        const token = extract_token(req);

        if (!token) {
            return res.status(401).json({
                authenticated: false,
                message: "Not authenticated"
            });
        }

        let decoded;

        try {
            decoded = verifyToken(token);
        } catch (error) {
            return res.status(401).json({
                authenticated: false,
                message: "Invalid or expired token"
            });
        }

        if (!decoded.id || !mongoose.Types.ObjectId.isValid(decoded.id)) {
            return res.status(401).json({
                authenticated: false,
                message: "Invalid token"
            });
        }

        const user = await users.findById(decoded.id).select(
            "_id name email role phone_number GPS_URL whatsApp_number"
        ).lean();

        if (!user) {
            return res.status(401).json({
                authenticated: false,
                message: "User not found"
            });
        }

        return res.status(200).json({
            authenticated: true,
            message: "User is authenticated",
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                phone_number: user.phone_number,
                GPS_URL: user.GPS_URL,
                whatsApp_number: user.whatsApp_number,
            }
        });

    } catch (error) {

        console.log(error.message);

        return res.status(500).json({
            authenticated: false,
            message: "Internal server error"
        });
    }
};

module.exports = auth_me;
