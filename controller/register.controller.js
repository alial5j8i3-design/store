const bcrypt = require("bcrypt");
const { signToken } = require("../utils/jwt");
require("dotenv").config();

const users = require("../models/users");
const { COOKIE_OPTIONS, COOKIE_MAX_AGE_MS } = require("../config/cookie");
const { PHONE_REGEX, is_valid_http_url } = require("../utils/validators");


const BCRYPT_COST = 10;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

const register = async (req, res) => {
    try {

        // 1. Get data from request

        const user_name = typeof req.body?.name === "string" ? req.body.name.trim() : "";

        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

        const password = req.body?.password;

        const phone_number = typeof req.body?.phone_number === "string" ? req.body.phone_number.trim() : "";

        const GPS_URL = typeof req.body?.GPS_URL === "string" ? req.body.GPS_URL.trim() : "";

        const whatsApp_number = typeof req.body?.whatsApp_number === "string" ? req.body.whatsApp_number.trim() : "";


        // 2. Validate required data

        if (
            !user_name ||
            !email ||
            typeof password !== "string" ||
            password.length < MIN_PASSWORD_LENGTH ||
            password.length > MAX_PASSWORD_LENGTH ||
            !phone_number ||
            !whatsApp_number ||
            !GPS_URL
        ) {
            return res.status(400).json({
                success: false,
                message: `Name, email , phone number , whatsApp number , GPS URL are required and password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`
            });
        }

        if (!EMAIL_REGEX.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Please provide a valid email address"
            });
        }

        if (user_name.length > 100) {
            return res.status(400).json({ success: false, message: "Name must be at most 100 characters" });
        }

        if (email.length > 254) {
            return res.status(400).json({ success: false, message: "Email must be at most 254 characters" });
        }

        if (!PHONE_REGEX.test(phone_number)) {
            return res.status(400).json({ success: false, message: "Invalid phone number" });
        }

        if (!PHONE_REGEX.test(whatsApp_number)) {
            return res.status(400).json({ success: false, message: "Invalid whatsApp number" });
        }

        if (!is_valid_http_url(GPS_URL, 500)) {
            return res.status(400).json({ success: false, message: "GPS URL must be a valid http/https link" });
        }


        // 3. Check email + hash password


        const [find_user, passwordHash] = await Promise.all([
            users.findOne({ email: email }).select("_id").lean(),
            bcrypt.hash(password, BCRYPT_COST)
        ]);

        if (find_user) {
            return res.status(400).json({
                success: false,
                message: "This email address is already in use."
            });
        }


        // 4. Create user

        const new_user = new users({
            name: user_name,

            email: email,

            password: passwordHash,

            role: "user",

            phone_number: phone_number,

            GPS_URL: GPS_URL,

            whatsApp_number: whatsApp_number,

        });


        // 5. Save user

        try {
            await new_user.save();
        } catch (saveError) {

            if (saveError.code === 11000) {
                return res.status(400).json({
                    success: false,
                    message: "This email address is already in use."
                });
            }

            throw saveError;
        }


        // 6. Create JWT

        const token = signToken({ id: new_user._id });


        // 7. Save token in cookie


        res.cookie("token", token, {
            ...COOKIE_OPTIONS,
            maxAge: COOKIE_MAX_AGE_MS
        });

        // 8. Response
        // `token` is also returned in the body so the frontend can keep a
        // Bearer fallback and stay signed in if it fails over to another server.

        return res.status(201).json({
            success: true,
            message: "Registration successful",
            token
        });

    } catch (e) {

        console.log(e.message);

        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = register;
