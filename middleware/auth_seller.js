require("dotenv").config();

const { verifyToken } = require("../utils/jwt");
const { extract_token } = require("../utils/request_token");
const users = require("../models/users");

const auth_seller = async(req,res,next)=>{
    try{
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
            .lean();

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "seller not found in database"
            });
        }
        if(user.role!=="seller"){
            return res.status(403).json({
                success: false,
                message: "Access restricted to sellers"
            }); 
        }
        req.user = user;

        next();
    }
    catch(e){
        console.log(e.message);

        return res.status(401).json({
            success: false,
            message: "Invalid or expired token"
        });
    }
}
module.exports = auth_seller