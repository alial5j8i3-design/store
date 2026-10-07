require("dotenv").config();

const mongoose = require("mongoose");
const users = require("../models/users");
const stores = require("../models/store");
const { is_valid_http_url } = require("../utils/validators");

async function reportInvalidUrls() {
    await mongoose.connect(process.env.MONGO_URL);
    const [userRows, storeRows] = await Promise.all([
        users.find({}).select("GPS_URL").lean(),
        stores.find({}).select("store_GPS").lean(),
    ]);

    const invalidUserGpsUrls = userRows.filter((user) => !is_valid_http_url(user.GPS_URL, 500)).length;
    const invalidStoreGpsUrls = storeRows.filter((store) => store.store_GPS && !is_valid_http_url(store.store_GPS, 500)).length;
    console.log(`invalid user GPS URLs: ${invalidUserGpsUrls}`);
    console.log(`invalid store GPS URLs: ${invalidStoreGpsUrls}`);
}

reportInvalidUrls()
    .catch((error) => {
        console.error("Failed to report invalid URLs:", error.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
