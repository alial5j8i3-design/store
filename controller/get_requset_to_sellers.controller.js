const promotion_requests = require("../models/Promotion_requests_for_salesperson");
const { read_pagination } = require("../utils/pagination");

const get_requset_sellers = async (req, res) => {
  try {
    // Page size (default 10, max 50) and page number (bounded, see
    // utils/pagination.js).
    const pg = read_pagination(req, res, { defaultLimit: 10, maxLimit: 50 });
    if (!pg) return;
    const { page, limit, skip } = pg;

    const all_requests = await promotion_requests
      .find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Total number of promotion requests
    const totalRequests = await promotion_requests.estimatedDocumentCount();

    const totalPages = Math.ceil(totalRequests / limit);

    // No requests found
    if (all_requests.length === 0) {
      return res.status(200).json({
        success: true,
        message: "not found",
        data: [],
        pagination: {
          page,
          limit,
          totalRequests,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "get promotion requests successfully",
      data: all_requests,
      pagination: {
        page,
        limit,
        totalRequests,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  } catch (e) {
    console.log(e.message);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = get_requset_sellers;