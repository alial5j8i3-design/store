// ---------------------------------------------------------------------
// DATA ACCESS ALLOWLIST: the assistant may read ONLY these two models.
// Never require users / super_admin / orders / tickets / coupons / store
// here. Every tool below is hard-coded to these two collections, so even a
// successful prompt injection cannot reach anything else.
// ---------------------------------------------------------------------
const products = require("../models/products");
const section = require("../models/section");
const config = require("../config/ai_assistant.config");


function escapeRegex(text) {
    return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampNumber(value, { min, max, fallback }) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
}

function safeString(value, maxLength = 120) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}


const PRODUCT_PUBLIC_FIELDS =
    "_id name description price final_price discount quantity section images";

const SECTION_PUBLIC_FIELDS = "name";



function toPublicProduct(p) {
    if (!p) return null;

    const inStock =
        typeof p.quantity === "number" ? p.quantity > 0 : undefined;

    return {
        name: safeString(p.name, 120) || "product",
        // Product descriptions are seller-controlled, untrusted tool data.
        description: safeString(p.description, 120),
        price: p.price ?? null,
        final_price: p.final_price > 0 ? p.final_price : (p.price ?? null),
        discount: p.discount || 0,
        section: p.section && p.section.name ? safeString(p.section.name, 60) : null,
        in_stock: inStock,
    };
}


function toProductCard(p) {
    if (!p) return null;

    const price = safeNumber(p.price);
    const rawFinal = safeNumber(p.final_price);
    const finalPrice = rawFinal && rawFinal > 0 ? rawFinal : price;
    const discount = safeNumber(p.discount) || 0;

    const firstImage = Array.isArray(p.images)
        ? p.images.find(img => typeof img === "string" && img.trim())
        : p.images;

    return {
        id: p._id ? String(p._id) : null,
        name: safeString(p.name, 120) || "product",
        image: safeString(firstImage, 500) || null,
        price,
        final_price: finalPrice,
        discount: discount > 0 ? discount : 0,
        section: p.section && p.section.name ? safeString(p.section.name, 60) : null,
        in_stock: typeof p.quantity === "number" ? p.quantity > 0 : true,
    };
}

function toPublicSection(s) {
    if (!s) return null;
    return {
        name: safeString(s.name, 80),
        description: safeString(s.description, 200),
    };
}



const TOOL_DEFINITIONS = [
    {
        type: "function",
        function: {
            name: "search_products",
            description:
                    "Search the store's current products (name/description/price/category/availability). " +
                    "Always use this tool before answering any question about a product, price, " +
                    "or availability, rather than guessing or relying on memory. " +
                    "The tool's results are automatically displayed to the customer as product cards featuring images and prices, " +
                    "so simply provide a brief introductory sentence and do not repeat the list of products or prices in the text.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "A word or phrase to search for a product name or description. Leave blank to display general products.",
                    },
                    section_name: {
                        type: "string",
                        description: "Category name for filtering products (optional).",
                    },
                    max_price: {
                        type: "number",
                        description: "Maximum acceptable price (optional).",
                    },
                    min_price: {
                        type: "number",
                        description: "Minimum acceptable price (optional).",
                    },
                    in_stock_only: {
                        type: "boolean",
                        description: "Show only in-stock products (optional).",
                    },
                    limit: {
                        type: "number",
                        description: `Maximum number of results (default and maximum ${config.AI_MAX_SEARCH_RESULTS}).`,
                    },
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_sections",
            description:
                "Retrieve the list of all currently available store sections. Use it when a customer asks about sections or categories.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
];

const ALLOWED_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(t => t.function.name));


async function executeSearchProducts(rawArgs) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};

    const limit = clampNumber(args.limit, {
        min: 1,
        max: config.AI_MAX_SEARCH_RESULTS,
        fallback: config.AI_MAX_SEARCH_RESULTS,
    });

    const filter = { is_active: { $ne: false } };

    const sectionName = safeString(args.section_name, 60);
    if (sectionName) {
        const matchingSections = await section
            .find({ name: { $regex: escapeRegex(sectionName), $options: "i" } })
            .select("_id")
            .limit(50)
            .lean();
        const sectionIds = matchingSections.map((item) => item._id);
        if (sectionIds.length === 0) {
            return { count: 0, products: [], cards: [] };
        }
        filter.section = { $in: sectionIds };
    }

    // Split the query into words so "pro 13 iphone" still finds
    // "iPhone 13 Pro". Every word must appear in the name or description.
    const query = safeString(args.query, 80);
    const words = query
        .split(" ")
        .map(w => w.trim())
        .filter(w => w.length > 0)
        .slice(0, 6);
    const wordClauses = words.map(w => {
        const pattern = escapeRegex(w);
        return {
            $or: [
                { name: { $regex: pattern, $options: "i" } },
                { description: { $regex: pattern, $options: "i" } },
            ],
        };
    });
    if (wordClauses.length > 0) filter.$and = wordClauses;

    const minPrice = Number(args.min_price);
    const maxPrice = Number(args.max_price);
    if (Number.isFinite(minPrice) || Number.isFinite(maxPrice)) {
        filter.price = {};
        if (Number.isFinite(minPrice)) filter.price.$gte = Math.max(minPrice, 0);
        if (Number.isFinite(maxPrice)) filter.price.$lte = Math.max(maxPrice, 0);
    }

    if (args.in_stock_only === true) {
        filter.quantity = { $gt: 0 };
    }

    const runQuery = async (f) => {
        const q = products
            .find(f)
            .select(PRODUCT_PUBLIC_FIELDS)
            .populate("section", "name")
            .limit(limit);
        // Bound DB execution time (regex search).
        if (typeof q.maxTimeMS === "function") q.maxTimeMS(2000);
        return q.lean();
    };

    let results = await runQuery(filter);
    let loose = false;

    // Nothing matched ALL words -> retry matching ANY word, so the model
    // gets related products instead of an empty answer.
    if (results.length === 0 && wordClauses.length > 1) {
        const { $and, ...rest } = filter;
        results = await runQuery({ ...rest, $or: wordClauses.flatMap(c => c.$or) });
        loose = results.length > 0;
    }

    return {
        count: results.length,
        // true => these are partial matches, not exact ones. The model must
        // say so instead of presenting them as the exact product.
        partial_match: loose,
        products: results.map(toPublicProduct),
        cards: results.map(toProductCard),
    };
}

async function executeGetSections() {
    const results = await section
        .find({})
        .select(SECTION_PUBLIC_FIELDS)
        .limit(50)
        .lean();

    return {
        count: results.length,
        sections: results.map(toPublicSection),
    };
}

async function executeTool(name, rawArguments) {
    if (!ALLOWED_TOOL_NAMES.has(name)) {
        return { result: { error: `The tool "${name}" Not permitted.` }, cards: [] };
    }

    let args = {};
    try {
        args = rawArguments ? JSON.parse(rawArguments) : {};
    } catch (_) {
        args = {};
    }

    try {
        switch (name) {
            case "search_products": {
                const { cards, ...forModel } = await executeSearchProducts(args);
                return { result: forModel, cards: Array.isArray(cards) ? cards : [] };
            }
            case "get_sections":
                return { result: await executeGetSections(), cards: [] };
            default:
                return { result: { error: "Unknown tool." }, cards: [] };
        }
    } catch (error) {
        console.log(`[ai_assistant.tools] Implementation failed ${name}:`, error.message);
        return {
            result: { error: "An error occurred while executing the database search." },
            cards: [],
        };
    }
}

module.exports = {
    TOOL_DEFINITIONS,
    ALLOWED_TOOL_NAMES,
    executeTool,
    executeSearchProducts,
    executeGetSections,
    toPublicProduct,
    toProductCard,
    toPublicSection,
};