// Arabic/English-aware helpers used to reject a new category that is the
// same as (or very close to) a category that already exists on the site.

const STOP_WORDS = new Set(["و", "في", "من", "الي", "الى", "على", "for", "and", "the", "of"]);

// Lower-cases and strips the parts of a name that don't change its meaning:
// diacritics, tatweel, punctuation, alef/ya/ta-marbuta variants, "ال" prefix.
function normalize_name(raw) {
    let s = String(raw || "").toLowerCase().normalize("NFKC");
    s = s
        .replace(/[\u064B-\u065F\u0670\u0640]/g, "")   // tashkeel + tatweel
        .replace(/[أإآٱ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")             // punctuation / symbols
        .replace(/\s+/g, " ")
        .trim();

    const tokens = s
        .split(" ")
        .map((t) => (t.length > 3 && t.startsWith("ال") ? t.slice(2) : t))
        .map((t) => (/^و.{3,}/.test(t) ? t.slice(1) : t))   // "واثاث" -> "اثاث"
        .filter((t) => t && !STOP_WORDS.has(t));

    return tokens.join(" ");
}

function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        const cur = [i];
        for (let j = 1; j <= b.length; j += 1) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        prev = cur;
    }
    return prev[b.length];
}

// light stemming so "لابتوبات" ~ "لابتوب"
function stem(token) {
    return token.replace(/(ات|ون|ين|ان)$/, "").replace(/^(ال)/, "");
}

function tokens_match(a, b) {
    if (a === b) return true;
    const sa = stem(a);
    const sb = stem(b);
    if (sa === sb) return true;
    const longest = Math.max(sa.length, sb.length);
    if (longest < 4) return false;
    return 1 - levenshtein(sa, sb) / longest >= 0.75;
}

// Returns true when two (already normalized) names describe the same category.
function names_are_similar(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;

    // whole-string closeness (typos, small spelling differences)
    const longest = Math.max(a.length, b.length);
    if (longest >= 4 && 1 - levenshtein(a, b) / longest >= 0.8) return true;

    // every word of the shorter name appears (roughly) in the longer name,
    // e.g. "هواتف" vs "هواتف ذكية"
    const ta = a.split(" ");
    const tb = b.split(" ");
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    return short.every((t) => long.some((u) => tokens_match(t, u)));
}

// existing: array of { name, normalized_name? }
function find_similar_section(new_name, existing) {
    const normalized = normalize_name(new_name);
    for (const sec of existing) {
        const other = sec.normalized_name || normalize_name(sec.name);
        if (names_are_similar(normalized, other)) return sec;
    }
    return null;
}

// Rows read per round trip by the similarity scan below. This only bounds
// MEMORY per batch; it never limits how many sections are checked.
const SIMILARITY_SCAN_BATCH = 500;

/*
 * Duplicate / near-duplicate check against the database (PERF-02).
 *
 *   1. EXACT duplicate: a direct, indexed findOne on `normalized_name`
 *      (unique partial index). Correctness never depends on how many
 *      sections exist.
 *   2. NEAR duplicate (typos, plural forms, "هواتف" vs "هواتف ذكية"): this is
 *      a fuzzy comparison that MongoDB cannot express as a query, so every
 *      section is compared - but in keyset batches (`_id > last`, sorted by
 *      _id) so memory stays bounded while NO section is skipped. It must not
 *      be replaced with `find().limit(N)`: a duplicate beyond row N would be
 *      missed. The scan stops at the first match.
 *
 * `exclude_id` skips the section being renamed.
 * Returns the conflicting section ({ _id, name, normalized_name }) or null.
 */
async function find_conflicting_section(model, new_name, { exclude_id } = {}) {
    const normalized = normalize_name(new_name);
    if (!normalized) return null;

    const exact_filter = { normalized_name: normalized };
    if (exclude_id) exact_filter._id = { $ne: exclude_id };
    const exact = await model.findOne(exact_filter).select("_id name normalized_name").lean();
    if (exact) return exact;

    let last_id = null;
    for (;;) {
        const filter = {};
        if (exclude_id && last_id) filter.$and = [{ _id: { $ne: exclude_id } }, { _id: { $gt: last_id } }];
        else if (exclude_id) filter._id = { $ne: exclude_id };
        else if (last_id) filter._id = { $gt: last_id };

        const query = model.find(filter).select("_id name normalized_name").sort({ _id: 1 }).limit(SIMILARITY_SCAN_BATCH);
        if (typeof query.maxTimeMS === "function") query.maxTimeMS(5000);
        const batch = await query.lean();
        if (batch.length === 0) return null;

        const similar = find_similar_section(new_name, batch);
        if (similar) return similar;

        if (batch.length < SIMILARITY_SCAN_BATCH) return null;
        last_id = batch[batch.length - 1]._id;
    }
}

module.exports = { normalize_name, names_are_similar, find_similar_section, find_conflicting_section, SIMILARITY_SCAN_BATCH };