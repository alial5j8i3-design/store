require("dotenv").config();

const { verifyToken } = require("../utils/jwt");
const { extract_token } = require("../utils/request_token");
const users = require("../models/users");

const auth = async (req, res, next) => {
    try {
        const token = extract_token(req);

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Not authenticated"
            });
        }

        const decoded = verifyToken(token);

        if (!decoded.id) {
            return res.status(401).json({
                success: false,
                message: "Invalid token"
            });
        }

        const user = await users
            .findById(decoded.id)
            .select("_id name email role phone_number GPS_URL whatsApp_number")
            // .lean() -> plain JS object instead of a full Mongoose
            // document. Nothing downstream calls Mongoose document
            // methods on req.user, so this skips the hydration cost on
            // every single authenticated request - this middleware runs
            // on almost every protected route, so the saving adds up
            // under high traffic.
            .lean();


        if (!user) {
            return res.status(401).json({
                success: false,
                message: "User not found"
            });
        }

        req.user = user;

        next();

    } catch (error) {
        console.log(error.message);

        return res.status(401).json({
            success: false,
            message: "Invalid or expired token"
        });
    }
};

module.exports = auth;