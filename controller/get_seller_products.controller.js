const products = require("../models/products");
const cache = require("../utils/cache");
const { read_pagination } = require("../utils/pagination");

const get_products = async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
        data: [],
      });
    }

    // FIX: seller identity must come from the authenticated user
    // (set by auth_seller), never from the client - the original
    // code trusted `req.body.user_id`, which on a GET route isn't
    // even reliably sent, and would let one seller read another
    // seller's product list just by passing a different id.
    const seller_id = user._id.toString();

    // Page size (default 10, max 50) and page number; page is bounded too
    // (utils/pagination.js MAX_SKIP).
    const pg = read_pagination(req, res, { defaultLimit: 10, maxLimit: 50 });
    if (!pg) return;
    const { page, limit, skip } = pg;

    // Unique cache key for each seller and page
    const epoch = cache.getProductsEpoch ? await cache.getProductsEpoch() : 0;
    const cacheKey = `products:v${epoch}:seller=${seller_id}:page=${page}:limit=${limit}`;

    // Check cache
    const cachedProducts = await cache.get(cacheKey);

    if (cachedProducts) {
      console.log("Products from CACHE");

      return res.status(200).json({
        success: true,
        message: "Get products successfully",
        data: cachedProducts.data,
        pagination: cachedProducts.pagination,
      });
    }

    // FIX: the products schema's field is `seller_id`, not `user_id` -
    // querying `{ user_id }` matched nothing, ever, since that field
    // doesn't exist on the products collection.
    const all_products = await products
      .find({
        seller_id: seller_id,
      })
      .select("-reviews")
      .populate("section", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Count products for this seller only
    const totalProducts = await products.countDocuments({
      seller_id: seller_id,
    });

    const totalPages = Math.ceil(totalProducts / limit);

    // No products found
    if (all_products.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No products found",
        data: [],
        pagination: {
          page,
          limit,
          totalProducts,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      });
    }

    const responseData = {
      data: all_products,
      pagination: {
        page,
        limit,
        totalProducts,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };

    // Store in cache
    await cache.set(cacheKey, responseData, cache.PRODUCTS_CACHE_TTL_SECONDS || 60);

    console.log("Products from DATABASE");

    return res.status(200).json({
      success: true,
      message: "Get products successfully",
      data: all_products,
      pagination: responseData.pagination,
    });
  } catch (e) {
    console.log(e.message);

    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
};

module.exports = get_products;