const bcrypt = require("bcrypt");
const { signToken } = require("../utils/jwt");
require("dotenv").config();
const users = require("../models/users")
const { COOKIE_OPTIONS, COOKIE_MAX_AGE_MS } = require("../config/cookie");

// Used to keep the response time roughly the same whether the email
// exists or not, so timing alone can't be used to enumerate registered
// emails. It's a fixed, precomputed bcrypt hash of a dummy password -
// bcrypt.compare() against it takes about as long as a real compare.
const DUMMY_HASH = "$2b$10$.KDsRgm.5Jay6B2dneRu5.eOjNGv.PbzLD4bxOe565GDa9Yl/Fd8i";

// No upper bound on password length let someone send a multi-MB
// "password" and still pay for a full bcrypt.compare() against it
// before being rejected - capping it here rejects that up front. Kept
// as the same generic "Invalid email or password" message (not "too
// long") so this can't be used to distinguish a bad password from an
// oversized one.
const MAX_PASSWORD_LENGTH = 128;

const log_in = async (req, res) => {
    try {
        const email = typeof req.body?.email === "string"
            ? req.body.email.trim().toLowerCase()
            : "";

        const password = req.body?.password;

        if (!email || typeof password !== "string") {
            return res.status(400).json({
                success: false,
                message: "Email and password are required"
            })
        }

        if (password.length < 8 || password.length > MAX_PASSWORD_LENGTH) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        // super_admin is not rejected here. That would mean a super
        // admin could log in exactly once at registration time, and
        // then have NO way back into the system once their session
        // cookie expired or was cleared - there is no other login
        // route for that role. Super admin authenticates through this
        // same endpoint like every other role.

        // .lean() + a narrow .select(): this is a hot path under load,
        // and nothing here needs a full Mongoose document - just the
        // few fields used below.
        const find_log_in_user = await users
            .findOne({ email: email })
            .select("_id name role password")
            .lean();

        if (!find_log_in_user) {
            // Do a dummy compare so a missing-user response takes about
            // as long as a wrong-password one below - otherwise an
            // attacker could tell which emails are registered just by
            // timing responses.
            await bcrypt.compare(password, DUMMY_HASH);

            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        const passwordMatch = await bcrypt.compare(
            password,
            find_log_in_user.password
        );

        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        const token = signToken({ id: find_log_in_user._id });

        // FIX: was setting secure:false unconditionally here, while
        // other places setting/clearing this same cookie used (or
        // should use) an environment-aware value. Using the shared
        // COOKIE_OPTIONS guarantees every controller that touches the
        // "token" cookie agrees on the same options, so log_out's
        // clearCookie() actually matches and removes it.
        res.cookie("token", token, {
            ...COOKIE_OPTIONS,
            maxAge: COOKIE_MAX_AGE_MS
        });

        return res.status(200).json({
            success: true,
            message: "Log in successful"
        })
    }
    catch (e) {
        console.log(e.message)
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        })
    }
}

module.exports = log_in