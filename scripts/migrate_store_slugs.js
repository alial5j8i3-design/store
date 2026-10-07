/* One-time migration for stores created before public slugs existed. */
require("dotenv").config();
const mongoose = require("mongoose");
const Store = require("../models/store");
function baseSlug(name) {
  const ascii = String(name || "store").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (ascii || "store").slice(0, 90).replace(/-+$/g, "") || "store";
}
async function uniqueSlug(name) {
  const base = baseSlug(name);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    if (!await Store.exists({ slug })) return slug;
  }
  throw new Error(`Unable to create slug for ${name}`);
}
(async () => {
  if (!process.env.MONGO_URL) throw new Error("MONGO_URL is required");
  await mongoose.connect(process.env.MONGO_URL);
  const legacyStores = await Store.find({ owner_id: { $exists: true }, $or: [{ slug: { $exists: false } }, { slug: "" }] }).select("_id store_name").lean();
  for (const legacyStore of legacyStores) await Store.updateOne({ _id: legacyStore._id, $or: [{ slug: { $exists: false } }, { slug: "" }] }, { $set: { slug: await uniqueSlug(legacyStore.store_name) } });
  console.log(`Assigned public slugs to ${legacyStores.length} store(s).`);
  await mongoose.disconnect();
})().catch(async (error) => { console.error(error.message); await mongoose.disconnect().catch(() => {}); process.exitCode = 1; });
