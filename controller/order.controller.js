const coupons = require("../models/coupon");
const orders = require("../models/order");
const products = require("../models/products");
const users = require("../models/users");
const socket_events = require("../utils/socket_events");
const mongoose = require("mongoose");
const crypto = require("crypto");
const cache = require("../utils/cache");
const { toCents, fromCents, applyPercentOffCents } = require("../utils/money");

// Defensive cap on how many distinct line items a single order can
// contain. Nothing legitimate needs more than this, and without a cap
// a single request could force the server to run an unbounded number
// of DB round trips (see the stock-reduction step below).
const MAX_ORDER_ITEMS = 50;
const MAX_ITEM_QUANTITY = 1000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function buyerOrderView(order) {
  const plain = order?.toObject ? order.toObject() : { ...order };
  return {
    ...plain,
    products: (plain.products || []).map(({ seller_id, ...item }) => item),
  };
}

/*
 * =========================================
 * Helper: restore stock
 *
 * Used whenever we already reduced the
 * quantity of some products but the order
 * could not be completed in the end
 * (another product ran out of stock, or an
 * error happened while saving the order).
 * We give the quantity back to every
 * product we already touched.
 *
 * Runs the restores concurrently (Promise.all)
 * instead of one at a time - they're independent
 * writes to different products, so there's no
 * reason to make a request wait for them
 * sequentially.
 * =========================================
 */

async function restoreStock(reducedStock) {
  await Promise.all(
    reducedStock.map(async (item) => {
      try {
        await products.updateOne(
          { _id: item.id },
          { $inc: { quantity: item.quantity } },
        );
      } catch (error) {
        console.log(error);
      }
    }),
  );
}

const order = async (req, res) => {
  /*
   * Keeps track of every product whose
   * stock we already reduced, so we can
   * roll it back if the order fails later.
   */

  let reducedStock = [];

  // Once the order document is saved, stock must NEVER be restored:
  // the order exists and owns that stock. (Before this flag, a failure
  // in the socket emit after save() sent us to the catch block, which
  // gave the stock back even though the order had been created.)
  let orderSaved = false;

  try {
    /*
     * =========================================
     * 1. Check authentication
     * =========================================
     */
    // Reads the user the `auth` middleware already verified and
    // fetched (routes/order.router.js) instead of re-verifying the JWT
    // and re-hitting the database here - this is one of the most
    // latency-sensitive endpoints in the app, and the one under the
    // most load pressure at checkout time.
    const user = req.user;

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
        data: [],
      });
    }

    const idempotencyKey = req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"];
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))) {
      return res.status(400).json({ success: false, message: "Invalid Idempotency-Key", data: [] });
    }
    if (idempotencyKey) {
      const existingOrder = await orders.findOne({ user_id: String(user._id), idempotency_key: idempotencyKey }).lean();
      if (existingOrder) {
        return res.status(200).json({ success: true, message: "Order already created", data: buyerOrderView(existingOrder) });
      }
    }

    if (
      typeof user.phone_number !== "string" || !user.phone_number.trim() ||
      typeof user.GPS_URL !== "string" || !user.GPS_URL.trim() ||
      typeof user.whatsApp_number !== "string" || !user.whatsApp_number.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Your account must include phone number, GPS URL, and WhatsApp number before ordering",
        data: [],
      });
    }

    /*
     * =========================================
     * 2. Get products from request
     *
     * Expected:
     *
     * products: [
     *   {
     *     id: "PRODUCT_ID",
     *     quantity: 2
     *   },
     *   {
     *     id: "PRODUCT_ID",
     *     quantity: 1
     *   }
     * ]
     * =========================================
     */

    const rawRequestedProducts = req.body.products;
    const coupon = req.body.coupon;

    if (
      !Array.isArray(rawRequestedProducts) ||
      rawRequestedProducts.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Products are required",
        data: [],
      });
    }

    if (rawRequestedProducts.length > MAX_ORDER_ITEMS) {
      return res.status(400).json({
        success: false,
        message: `An order can contain at most ${MAX_ORDER_ITEMS} distinct products`,
        data: [],
      });
    }

    /*
     * =========================================
     * 3. Validate products
     * =========================================
     */

    for (const item of rawRequestedProducts) {
      // FIX: a malformed id used to reach products.find({ _id: { $in } })
      // and throw a CastError -> generic 500. Now it is a clean 400.
      if (
        !item ||
        typeof item.id !== "string" ||
        !mongoose.Types.ObjectId.isValid(item.id)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid product data",
          data: [],
        });
      }

      const quantity = Number(item.quantity);

      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_ITEM_QUANTITY) {
        return res.status(400).json({
          success: false,
          message: "Invalid product quantity",
          data: [],
        });
      }
    }

    // FIX: if the same product id appeared more than once in the
    // request, `$in` below returns that product only ONCE, so
    // dbProducts.length ended up smaller than productIds.length and
    // the whole order was wrongly rejected as "product not found" even
    // though every product actually existed. Merging duplicate line
    // items into a single entry (summing their quantities) before any
    // further processing fixes that and also means a duplicate entry
    // is treated as one combined quantity instead of being priced and
    // stock-checked twice independently.
    const mergedQuantities = new Map();

    for (const item of rawRequestedProducts) {
      // Normalize to the canonical lowercase 24-hex form so the same product
      // sent as "ABC..." and "abc..." is merged into ONE line instead of
      // being counted as two ids (which made `$in` return fewer documents
      // than ids and wrongly rejected the order as "product not found").
      const key = new mongoose.Types.ObjectId(item.id).toString();
      const quantity = Number(item.quantity);
      mergedQuantities.set(key, (mergedQuantities.get(key) || 0) + quantity);
    }

    const requestedProducts = Array.from(
      mergedQuantities,
      ([id, quantity]) => ({ id, quantity }),
    );

    if (requestedProducts.length > MAX_ORDER_ITEMS) {
      return res.status(400).json({
        success: false,
        message: `An order can contain at most ${MAX_ORDER_ITEMS} distinct products`,
        data: [],
      });
    }

    /*
     * =========================================
     * 4. Get real products from MongoDB
     * =========================================
     */

    const productIds = requestedProducts.map((item) => item.id);

    // .lean() - nothing here calls any Mongoose document method on
    // these, only reads plain fields (price/discount/quantity/name/
    // seller_id), so there's no reason to pay for full document
    // hydration.
    const dbProducts = await products
      .find({ _id: { $in: productIds } })
      .select("_id name price discount quantity seller_id images is_active")
      .lean();

    /*
     * Make sure every product exists
     */

    if (dbProducts.length !== productIds.length) {
      return res.status(404).json({
        success: false,
        message: "One or more products were not found",
        data: [],
      });
    }

    // Build a lookup map once instead of calling dbProducts.find(...)
    // (an O(n) scan) for every requested product below - that would
    // turn into an O(n * m) scan for orders with many distinct line
    // items. A Map makes every lookup O(1).
    const dbProductsById = new Map(
      dbProducts.map((product) => [product._id.toString(), product]),
    );

    /*
     * =========================================
     * 4b. Ownership / availability / single-seller guards
     *
     * Everything here is READ-ONLY and runs before prices, coupons and
     * (above all) before any stock reservation. Order of checks:
     *   1. product exists (already verified above)
     *   2. product is active
     *   3. seller ownership is determinable (seller_id comes from the DB
     *      record only, never from req.body)
     *   4. the buyer is not the owner of the product
     *   5. every product belongs to ONE seller
     * A failure at any step returns 4xx without touching stock.
     * =========================================
     */

    const cartSellerIds = new Set();

    for (const requestedProduct of requestedProducts) {
      const product = dbProductsById.get(requestedProduct.id.toString());

      if (!product) {
        return res.status(404).json({
          success: false,
          message: "Product not found",
          data: [],
        });
      }

      if (product.is_active === false) {
        return res.status(400).json({ success: false, message: `Product is no longer available: ${product.name}`, data: [] });
      }

      const guardSellerId = product.seller_id ? String(product.seller_id) : null;

      if (!guardSellerId || guardSellerId.trim() === "") {
        return res.status(400).json({
          success: false,
          message: `Missing seller information for product: ${product.name}`,
          data: [],
        });
      }

      if (guardSellerId === String(user._id)) {
        return res.status(400).json({ success: false, message: "You cannot order your own product", data: [] });
      }

      cartSellerIds.add(guardSellerId);
    }

    // An order has one shared lifecycle status. Allowing multiple sellers in
    // it would let either seller cancel or deliver every seller's items.
    if (cartSellerIds.size > 1) {
      return res.status(400).json({
        success: false,
        message: "Your cart contains products from more than one seller. Please order each seller's products separately.",
        data: [],
      });
    }

    /*
     * =========================================
     * 5. Calculate prices
     * =========================================
     */

    // All money below is integer cents (utils/money.js); converted back to a
    // whole-cent amount only when stored.
    let total_cents = 0;

    const orderProducts = [];

    // Running subtotal (after product discounts, before any coupon) per
    // seller. A coupon only ever applies to the subtotal of ITS OWN
    // seller's products (see step 7).
    const subtotalBySeller = new Map();

    for (const requestedProduct of requestedProducts) {
      const product = dbProductsById.get(requestedProduct.id.toString());

      if (!product) {
        return res.status(404).json({
          success: false,
          message: "Product not found",
          data: [],
        });
      }

      if (product.is_active === false) {
        return res.status(400).json({ success: false, message: `Product is no longer available: ${product.name}`, data: [] });
      }

      /*
       * =========================================
       * Check available stock
       *
       * We check this here (before creating
       * the order) so the customer gets a
       * clear message immediately.
       * =========================================
       */

      const requestedQuantityForStock = Number(requestedProduct.quantity);

      const availableQuantity = Number(product.quantity);

      if (
        !Number.isFinite(availableQuantity) ||
        availableQuantity < requestedQuantityForStock
      ) {
        return res.status(400).json({
          success: false,
          message: `The quantity for the product "${product.name}" is currently unavailable; please try again later.`,
          data: [],
        });
      }

      /*
       * Real price from database
       */

      const productPrice = Number(product.price);

      if (!Number.isFinite(productPrice) || productPrice < 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid price for product: ${product.name}`,
          data: [],
        });
      }

      /*
       * Quantity
       */

      const quantity = Number(requestedProduct.quantity);

      /*
       * Product discount
       */

      const productDiscount = Number(product.discount || 0);

      if (
        !Number.isFinite(productDiscount) ||
        productDiscount < 0 ||
        productDiscount > 100
      ) {
        return res.status(400).json({
          success: false,
          message: `Invalid discount for product: ${product.name}`,
          data: [],
        });
      }

      /*
       * =========================================
       * Product seller
       *
       * FIX: sourced from the DB product record,
       * never from req.body - trusting a
       * client-supplied seller_id would let a
       * request claim a product belongs to a
       * different seller than it actually does,
       * which would break per-seller filtering
       * and per-seller order management later.
       * =========================================
       */

      // FIX (Phase 1 compat): products.seller_id is now a real ObjectId
      // (models/products.js), not a String - a .lean() product document
      // returns it as an actual ObjectId instance, so the old
      // `typeof sellerId !== "string"` check would now reject every
      // product unconditionally. order.js's own seller_id field is
      // still a String snapshot, so we normalize with String(...) here,
      // same as before the schema change.
      const sellerId = product.seller_id ? String(product.seller_id) : null;

      if (!sellerId || sellerId.trim() === "") {
        return res.status(400).json({
          success: false,
          message: `Missing seller information for product: ${product.name}`,
          data: [],
        });
      }

      if (sellerId === String(user._id)) {
        return res.status(400).json({ success: false, message: "You cannot order your own product", data: [] });
      }

      /*
       * Calculate discounted price
       */

      const finalUnitCents = applyPercentOffCents(toCents(productPrice), productDiscount);

      const finalProductPrice = fromCents(finalUnitCents);

      /*
       * Calculate product total
       */

      const productTotalCents = finalUnitCents * quantity;

      total_cents += productTotalCents;

      subtotalBySeller.set(
        sellerId,
        (subtotalBySeller.get(sellerId) || 0) + productTotalCents,
      );

      /*
       * =========================================
       * Save product information
       *
       * IMPORTANT:
       * We save the quantity here.
       * =========================================
       */

      orderProducts.push({
        // Permanent link back to the actual Product document (see
        // order.js) - needed so the admin dashboard can reliably
        // resolve the real product image for this order later,
        // instead of only having a name snapshot to guess from.
        product: product._id,

        // Snapshot of the owning seller at order time, same idea as
        // name/price/images below - so a seller's own orders can be
        // filtered reliably even if the product is later reassigned,
        // edited, or removed.
        seller_id: sellerId,

        name: product.name,

        price: finalProductPrice,

        quantity: quantity,

        images: Array.isArray(product.images) ? product.images : [],
      });
    }

    // An order has one shared lifecycle status. Allowing multiple sellers in
    // it would let either seller cancel or deliver every seller's items, so
    // reject the cart before coupon processing or any stock mutation.
    if (subtotalBySeller.size > 1) {
      return res.status(400).json({
        success: false,
        message: "Your cart contains products from more than one seller. Please order each seller's products separately.",
        data: [],
      });
    }

    const subtotalBeforeCoupon = fromCents(total_cents);
    let validatedCoupon = null;

    // Validate a supplied coupon before stock is changed. The complete
    // seller-specific discount calculation below intentionally reuses the
    // fetched data only after stock is reserved.
    if (typeof coupon === "string" && coupon.trim() !== "") {
      const candidateCoupon = await coupons.findOne({ name: coupon.trim().toUpperCase() }).lean();
      const couponEnd = candidateCoupon && new Date(candidateCoupon.end_time);
      const couponSellerId = candidateCoupon?.seller_id ? String(candidateCoupon.seller_id) : null;
      if (!candidateCoupon) {
        return res.status(400).json({ success: false, message: "Coupon is not valid for this order", data: [] });
      }
      if (!Number.isFinite(Number(candidateCoupon.discount)) || Number(candidateCoupon.discount) < 0 || Number(candidateCoupon.discount) > 100 || Number.isNaN(couponEnd.getTime()) || couponEnd.getTime() <= Date.now() || !couponSellerId || !subtotalBySeller.has(couponSellerId)) {
        return res.status(400).json({ success: false, message: "Coupon is not valid for this order", data: [] });
      }
      validatedCoupon = candidateCoupon;
      const couponSeller = await users.findById(candidateCoupon.seller_id).select("role").lean();
      if (!couponSeller || couponSeller.role !== "seller") {
        return res.status(400).json({ success: false, message: "Coupon is not valid for this order", data: [] });
      }
    }

    /*
     * =========================================
     * 6. Reduce stock
     *
     * Each reduction is still an atomic update
     * that only succeeds if enough stock is still
     * available at this exact moment
     * (quantity: { $gte: ... }), protecting us if
     * two customers order the last item(s) at the
     * same time.
     *
     * These run concurrently with Promise.all since
     * they're writes to independent documents - no
     * correctness reason to serialize them, and doing
     * so cuts this step's latency down to roughly one
     * round trip regardless of how many products are
     * in the order.
     *
     * If any product turns out to be out of stock,
     * we restore whatever we already reduced and
     * stop the order, exactly as before.
     * =========================================
     */

    // FIX: Promise.all rejects on the first error and throws away the
    // results of the updates that already succeeded, so their stock was
    // never recorded in reducedStock and never restored (stock leak).
    // allSettled lets us see every result and roll back correctly.
    const stockUpdateResults = await Promise.allSettled(
      requestedProducts.map(async (requestedProduct) => {
        const requestedQuantity = Number(requestedProduct.quantity);

        const updatedProduct = await products.findOneAndUpdate(
          {
            _id: requestedProduct.id,
            quantity: { $gte: requestedQuantity },
          },
          {
            $inc: { quantity: -requestedQuantity },
          },
        );

        return {
          requestedProduct,
          requestedQuantity,
          updatedProduct,
        };
      }),
    );

    let outOfStockProduct = null;
    let stockError = null;

    for (const settled of stockUpdateResults) {
      if (settled.status === "rejected") {
        stockError = stockError || settled.reason;
        continue;
      }

      const result = settled.value;

      if (result.updatedProduct) {
        reducedStock.push({
          id: result.requestedProduct.id,
          quantity: result.requestedQuantity,
        });
      } else if (!outOfStockProduct) {
        outOfStockProduct = result.requestedProduct;
      }
    }

    if (stockError) {
      await restoreStock(reducedStock);
      reducedStock = [];
      throw stockError;
    }

    if (outOfStockProduct) {
      await restoreStock(reducedStock);
      reducedStock = [];

      const product = dbProductsById.get(outOfStockProduct.id.toString());

      return res.status(400).json({
        success: false,
        message: `The product "${
          product ? product.name : ""
        }" is out of stock; please try again later.`,
        data: [],
      });
    }

    /*
     * =========================================
     * 7. Apply coupon
     * =========================================
     */

    let couponDiscount = 0;

    if (typeof coupon === "string" && coupon.trim() !== "") {
      /*
       * Find coupon
       *
       * Codes are stored trimmed + UPPERCASE (models/coupon.js), so the
       * lookup is case-insensitive.
       */

      const find_coupon = await coupons
        .findOne({
          name: coupon.trim().toUpperCase(),
        })
        .lean();

      if (!find_coupon) {
        await restoreStock(reducedStock);
        reducedStock = [];

        return res.status(404).json({
          success: false,
          message: "Coupon not found",
          data: [],
        });
      }

      /*
       * =========================================
       * Check coupon expiration
       *
       * end_time must contain a valid date/time
       * such as:
       *
       * 2026-09-10T15:30:00.000Z
       * =========================================
       */

      // end_time is a Date in models/coupon.js (a .lean() query returns a
      // real Date object). A string is still accepted so any coupon stored
      // in the old String format keeps being read correctly.
      const rawEndTime = find_coupon.end_time;

      const hasEndTime =
        rawEndTime instanceof Date ||
        (typeof rawEndTime === "string" && rawEndTime.trim() !== "");

      if (!hasEndTime) {
        await restoreStock(reducedStock);
        reducedStock = [];

        return res.status(400).json({
          success: false,
          message: "Coupon expiration time is missing",
          data: [],
        });
      }

      const couponEndTime = new Date(rawEndTime);

      /*
       * Check if the date is valid
       */

      if (Number.isNaN(couponEndTime.getTime())) {
        await restoreStock(reducedStock);
        reducedStock = [];

        return res.status(400).json({
          success: false,
          message: "Invalid coupon expiration time",
          data: [],
        });
      }

      /*
       * Check if coupon has expired
       */

      if (Date.now() >= couponEndTime.getTime()) {
        await restoreStock(reducedStock);
        reducedStock = [];

        return res.status(400).json({
          success: false,
          message: "Coupon has expired",
          data: [],
        });
      }

      /*
       * =========================================
       * Get coupon discount
       * =========================================
       */

      couponDiscount = Number(find_coupon.discount || 0);

      /*
       * Validate coupon discount
       */

      if (
        !Number.isFinite(couponDiscount) ||
        couponDiscount < 0 ||
        couponDiscount > 100
      ) {
        await restoreStock(reducedStock);
        reducedStock = [];

        return res.status(400).json({
          success: false,
          message: "Invalid coupon discount",
          data: [],
        });
      }

      /*
       * =========================================
       * Coupon ownership
       *
       * A coupon belongs to ONE seller and is valid ONLY for that
       * seller's products. The seller is read from the coupon document
       * and compared against the seller_id of each product as stored in
       * the DB (never anything sent by the client).
       *
       * - Coupon without a seller (old admin-created coupons): invalid.
       * - Cart has no product from the coupon's seller: rejected, so a
       *   coupon can never discount another seller's products.
       * - Mixed cart: the discount applies to the coupon seller's
       *   products only; other sellers' products keep their price.
       * =========================================
       */

      const couponSellerId = find_coupon.seller_id
        ? String(find_coupon.seller_id)
        : null;

      const cartHasCouponSellerProducts =
        !!couponSellerId && subtotalBySeller.has(couponSellerId);

      const eligibleSubtotal = cartHasCouponSellerProducts
        ? subtotalBySeller.get(couponSellerId)
        : 0;

      if (!cartHasCouponSellerProducts) {
        await restoreStock(reducedStock);
        reducedStock = [];

        return res.status(400).json({
          success: false,
          message:
            "This coupon is not valid for the products in your cart. It only works with products from the store that issued it.",
          data: [],
        });
      }

      /*
       * =========================================
       * Apply coupon (to the coupon seller's subtotal only)
       * =========================================
       */

      total_cents =
        total_cents -
        eligibleSubtotal +
        applyPercentOffCents(eligibleSubtotal, couponDiscount);

      total_cents = Math.max(0, total_cents);
    }

    /*
     * =========================================
     * 8. Round total price
     * =========================================
     */

    const total_price = fromCents(total_cents);

    /*
     * =========================================
     * 9. Generate order number
     * =========================================
     */

    // A 9-digit random space (~900 million values) pushes the 50%
    // birthday-paradox collision point out to roughly 35,000 orders,
    // versus ~1,100 with a 6-digit number. Combined with the bounded
    // retry loop below (same idiom register.controller.js uses for its
    // email unique index: catch duplicate-key error 11000, try again
    // with a fresh value), this only works if `orderNumber` has a
    // `unique: true` index in the order schema - add one if it
    // doesn't already, otherwise a collision can't be detected at all
    // and this retry will never trigger.
    function generateOrderNumber() {
      return "ORD-" + Math.floor(100000000 + Math.random() * 900000000);
    }

    const MAX_ORDER_NUMBER_ATTEMPTS = 5;

    /*
     * =========================================
     * 10. Create order
     * =========================================
     */

    let newOrder;

    for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
      newOrder = new orders();

      newOrder.orderNumber = "ORD-" + crypto.randomInt(100000000, 1000000000);
      if (idempotencyKey) newOrder.idempotency_key = idempotencyKey;

      newOrder.products = orderProducts;

      newOrder.total_price = total_price;
      if (validatedCoupon) {
        newOrder.coupon_code = validatedCoupon.name;
        newOrder.coupon_discount_percent = Number(validatedCoupon.discount);
        newOrder.subtotal_before_coupon = subtotalBeforeCoupon;
      }

      newOrder.user_id = user._id;

      newOrder.user_name = user.name;

      newOrder.phone_number = user.phone_number;

      newOrder.GPS_URL = user.GPS_URL;

      newOrder.whatsApp_number = user.whatsApp_number;

      newOrder.status = "new";

      /*
       * createdAt and updatedAt
       * are handled automatically
       * by timestamps: true
       */

      try {
        await newOrder.save();
        orderSaved = true;
        break; // saved with a unique orderNumber
      } catch (saveError) {
        const isLastAttempt = attempt === MAX_ORDER_NUMBER_ATTEMPTS;

        // A concurrent retry with the same key may have committed after the
        // early lookup. Give this attempt's reservation back, then return the
        // already-created order instead of charging stock twice.
        if (saveError.code === 11000 && idempotencyKey) {
          const existingOrder = await orders.findOne({ user_id: String(user._id), idempotency_key: idempotencyKey }).lean();
          if (existingOrder) {
            await restoreStock(reducedStock);
            reducedStock = [];
            return res.status(200).json({ success: true, message: "Order already created", data: buyerOrderView(existingOrder) });
          }
        }

        if (saveError.code === 11000 && !isLastAttempt) {
          // Duplicate orderNumber - extremely unlikely with the wider
          // range above, but cheaper to retry with a fresh number than
          // to fail the whole order (and the stock we already reduced)
          // over a random-number collision.
          continue;
        }

        throw saveError;
      }
    }

    // Stock changed, so cached product lists (public + per-seller) now
    // show stale quantities. Same "products" prefix post_review uses.
    try {
      await cache.delByPrefix("products");
    } catch (cacheError) {
      console.log(cacheError.message);
    }

    // The order is already saved: a socket problem must not turn a
    // successful order into a 500 (or roll back its stock).
    try {
      if (req.io) {
        req.io.to("admins").emit("new_order", {
          order: newOrder,
        });
        const sellers = [...new Set((newOrder.products || []).map((item) => String(item.seller_id)))];
        const payload = {
          _id: newOrder._id,
          orderNumber: newOrder.orderNumber,
          total_price: newOrder.total_price,
          item_count: (newOrder.products || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        };
        for (const sellerId of sellers) {
          const room = socket_events.seller_room ? socket_events.seller_room(sellerId) : `seller:${sellerId}`;
          req.io.to(room).emit("new_order", payload);
        }
      }
    } catch (emitError) {
      console.log(emitError.message);
    }

    /*
     * =========================================
     * 11. Response
     * =========================================
     */

    return res.status(201).json({
      success: true,
      message: "Order created successfully",
      data: buyerOrderView(newOrder),
    });
  } catch (e) {
    console.log(e);

    /*
     * If we already reduced stock for one or
     * more products before this error happened
     * (e.g. the order failed to save), give the
     * quantity back.
     */

    if (reducedStock.length && !orderSaved) {
      await restoreStock(reducedStock);
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = order;