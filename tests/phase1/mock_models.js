// Strict in-memory stand-in for the Mongoose models used by the offline tests.
//
// Design rules (so a test can never pass only because the fake is lenient):
//  * Values are compared WITH their type. ObjectId("x") !== "x".
//  * Like real Mongoose, a model that declares a `schema` casts filter / update
//    values for declared paths (a 24-hex string becomes an ObjectId on an
//    ObjectId path). Undeclared paths are NOT cast, exactly like Mixed paths.
//  * Unknown query / update operators throw instead of being ignored.
//  * findOneAndUpdate returns the document BEFORE the update unless
//    `new: true` / `returnDocument: "after"` is given.
//
// Only behaviour this project needs is implemented. This is not a Mongoose clone.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;

const FILTER_OPS = new Set(["$in", "$nin", "$gt", "$gte", "$lt", "$lte", "$ne", "$exists", "$regex", "$options"]);
const UPDATE_OPS = new Set(["$set", "$unset", "$inc", "$push", "$pull"]);

function fail(name, message, extra = {}) {
    const err = new Error(message);
    err.name = name;
    Object.assign(err, extra);
    return err;
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof ObjectId) && !(v instanceof Date) && !(v instanceof RegExp);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function clone(v) {
    if (v instanceof ObjectId) return new ObjectId(v.toHexString());
    if (v instanceof Date) return new Date(v.getTime());
    if (Array.isArray(v)) return v.map(clone);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
    return v;
}

// ---- schema descriptor -----------------------------------------------------
// `schema` can be { path: { type: "ObjectId"|"String"|"Number"|"Boolean"|"Date", min, max, enum, required } }
// or a real Mongoose model / schema (converted by describeSchema).
function toDef(t) {
    const kind = { ObjectId: "ObjectId", ObjectID: "ObjectId", String: "String", Number: "Number", Boolean: "Boolean", Date: "Date" }[t && t.instance];
    if (!kind) return undefined; // Mixed / arrays / subdocuments are not cast, same as Mongoose
    const o = t.options || {};
    return { type: kind, min: o.min, max: o.max, enum: Array.isArray(o.enum) ? o.enum : t.enumValues && t.enumValues.length ? t.enumValues : undefined, required: o.required === true };
}
// Returns { get(path), keys() }. Dotted paths into document arrays (products.product) are
// resolved through the real schema; paths Mongoose treats as Mixed (reviews._id) have no def.
function describeSchema(modelOrSchema) {
    if (!modelOrSchema) return { get: () => undefined, keys: () => [] };
    const schema = modelOrSchema.schema || modelOrSchema;
    if (typeof modelOrSchema === "function" && !modelOrSchema.schema) {
        throw new Error("describeSchema: got a function without .schema (an injected fake model?). Pass the real model/schema.");
    }
    if (typeof schema.path !== "function") { // plain descriptor map
        return { get: (p) => schema[p], keys: () => Object.keys(schema) };
    }
    const top = [];
    schema.eachPath((p) => { if (p !== "__v" && !p.includes(".") && toDef(schema.path(p))) top.push(p); });
    return { schema, get: (p) => (p === "__v" ? undefined : toDef(schema.path(p))), keys: () => top };
}

function castValue(def, value, path) {
    if (value === null || value === undefined || !def) return value;
    if (Array.isArray(value)) return value.map((v) => castValue(def, v, path));
    switch (def.type) {
        case "ObjectId":
            if (value instanceof ObjectId) return value;
            if (typeof value === "string" && /^[a-f0-9]{24}$/i.test(value)) return new ObjectId(value);
            throw fail("CastError", `Cast to ObjectId failed for value "${String(value)}" at path "${path}"`, { path });
        case "String":
            if (typeof value === "string") return value;
            if (typeof value === "number" || typeof value === "boolean") return String(value);
            throw fail("CastError", `Cast to string failed at path "${path}"`, { path });
        case "Number": {
            if (typeof value === "number" && !Number.isNaN(value)) return value;
            if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
            throw fail("CastError", `Cast to Number failed at path "${path}"`, { path });
        }
        case "Boolean":
            if (typeof value === "boolean") return value;
            if (value === "true" || value === "false") return value === "true";
            throw fail("CastError", `Cast to Boolean failed at path "${path}"`, { path });
        case "Date": {
            const d = value instanceof Date ? value : new Date(value);
            if (Number.isNaN(d.getTime())) throw fail("CastError", `Cast to Date failed at path "${path}"`, { path });
            return d;
        }
        default:
            return value;
    }
}

// Operator objects ({ $in: [...] }) are cast element-wise; plain values directly.
function castCondition(def, cond, path) {
    if (isObj(cond) && Object.keys(cond).some((k) => k.startsWith("$"))) {
        const out = {};
        for (const [op, v] of Object.entries(cond)) {
            if (!FILTER_OPS.has(op)) throw fail("MockUnsupportedOperator", `Unsupported query operator ${op}`);
            if (!def) { out[op] = v; continue; }
            out[op] = op === "$exists" || op === "$regex" || op === "$options" ? v : castValue(def, v, path);
        }
        return out;
    }
    return def ? castValue(def, cond, path) : cond;
}

// ---- typed comparison ------------------------------------------------------
function typeTag(v) {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (v instanceof ObjectId) return "objectid";
    if (v instanceof Date) return "date";
    if (Array.isArray(v)) return "array";
    return typeof v; // string | number | boolean | object
}
function strictEqual(a, b) {
    const ta = typeTag(a), tb = typeTag(b);
    if (ta !== tb) return false;
    if (ta === "objectid") return a.equals(b);
    if (ta === "date") return a.getTime() === b.getTime();
    if (ta === "array") return a.length === b.length && a.every((x, i) => strictEqual(x, b[i]));
    if (ta === "object") {
        const ka = Object.keys(a), kb = Object.keys(b);
        return ka.length === kb.length && ka.every((k) => hasOwn(b, k) && strictEqual(a[k], b[k]));
    }
    return a === b;
}
// Mongo orders only within the same type bracket; cross-type range comparison never matches.
function compare(a, b) {
    const ta = typeTag(a), tb = typeTag(b);
    if (ta !== tb) return null;
    if (ta === "number" || ta === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (ta === "date") return Math.sign(a.getTime() - b.getTime());
    if (ta === "objectid") return Buffer.compare(a.id, b.id);
    return null;
}

// ---- paths -----------------------------------------------------------------
// Values reachable at a dotted path; arrays are traversed (products.seller_id, reviews._id).
function valuesAtPath(doc, path) {
    return path.split(".").reduce((vals, key) => vals.flatMap((v) => {
        if (Array.isArray(v)) return v.flatMap((item) => (item !== null && typeof item === "object" && hasOwn(item, key) ? [item[key]] : []));
        return v !== null && typeof v === "object" && hasOwn(v, key) ? [v[key]] : [undefined];
    }), [doc]);
}
// Mongo matches a scalar against an array field if ANY element equals it (or the array equals it).
function candidates(values) {
    return values.flatMap((v) => (Array.isArray(v) ? [v, ...v] : [v]));
}

function matchValues(values, cond) {
    const vals = candidates(values);
    if (isObj(cond) && Object.keys(cond).some((k) => k.startsWith("$"))) {
        for (const op of Object.keys(cond)) if (!FILTER_OPS.has(op)) throw fail("MockUnsupportedOperator", `Unsupported query operator ${op}`);
        return Object.entries(cond).every(([op, arg]) => {
            switch (op) {
                case "$in": return vals.some((v) => arg.some((c) => (c instanceof RegExp ? typeof v === "string" && c.test(v) : strictEqual(v, c))));
                case "$nin": return !vals.some((v) => arg.some((c) => strictEqual(v, c)));
                case "$ne": return !vals.some((v) => strictEqual(v, arg));
                case "$gt": return vals.some((v) => { const c = compare(v, arg); return c !== null && c > 0; });
                case "$gte": return vals.some((v) => { const c = compare(v, arg); return c !== null && c >= 0; });
                case "$lt": return vals.some((v) => { const c = compare(v, arg); return c !== null && c < 0; });
                case "$lte": return vals.some((v) => { const c = compare(v, arg); return c !== null && c <= 0; });
                case "$exists": return arg ? values.some((v) => v !== undefined) : values.every((v) => v === undefined);
                case "$regex": return vals.some((v) => typeof v === "string" && new RegExp(arg instanceof RegExp ? arg.source : arg, cond.$options || (arg instanceof RegExp ? arg.flags : "")).test(v));
                case "$options": return true;
                default: return false;
            }
        });
    }
    if (cond instanceof RegExp) return vals.some((v) => typeof v === "string" && cond.test(v));
    if (cond === null) return vals.some((v) => v === null || v === undefined);
    return vals.some((v) => strictEqual(v, cond));
}

function matches(doc, filter, castPath = (p, c) => c) {
    for (const key of Object.keys(filter || {})) {
        if (key === "$and") { if (!filter.$and.every((f) => matches(doc, f, castPath))) return false; continue; }
        if (key === "$or") { if (!filter.$or.some((f) => matches(doc, f, castPath))) return false; continue; }
        if (key === "$nor") { if (filter.$nor.some((f) => matches(doc, f, castPath))) return false; continue; }
        if (key.startsWith("$")) throw fail("MockUnsupportedOperator", `Unsupported top-level operator ${key}`);
        if (!matchValues(valuesAtPath(doc, key), castPath(key, filter[key]))) return false;
    }
    return true;
}

function setAtPath(doc, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.reduce((cur, k) => {
        if (cur[k] === null || typeof cur[k] !== "object") cur[k] = {};
        return cur[k];
    }, doc);
    target[last] = value;
}
function getAtPath(doc, path) {
    return path.split(".").reduce((cur, k) => (cur !== null && cur !== undefined ? cur[k] : undefined), doc);
}
function unsetAtPath(doc, path) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.length ? getAtPath(doc, keys.join(".")) : doc;
    if (target && typeof target === "object") delete target[last];
}

// ---- model factory ---------------------------------------------------------
// `uniqueIndexes`: compound / partial unique indexes, e.g.
//   [{ fields: ["order_id", "order_updated_at"] },
//    { fields: ["user_id", "idempotency_key"], when: (doc) => typeof doc.idempotency_key === "string" }]
// Values are compared with strictEqual (type-aware, ObjectId.equals, Date.getTime) -- never via String().
// `when` mimics partialFilterExpression: documents it rejects are outside the index.
function makeFakeModel(name, { requiredFields = [], uniqueFields = [], uniqueIndexes = [], schema } = {}) {
    const docs = [];
    const defs = describeSchema(schema);
    const def = (path) => defs.get(path);
    const castPath = (p, c) => castCondition(def(p), c, p);

    function checkField(path, value, { onlyIfPresent = false } = {}) {
        const d = def(path);
        const required = requiredFields.includes(path) || (d && d.required);
        if (value === undefined || value === null || value === "") {
            if (required && !onlyIfPresent) throw fail("ValidationError", `${name} validation failed: ${path} is required`, { errors: { [path]: { kind: "required" } } });
            if (required && onlyIfPresent && value !== undefined) throw fail("ValidationError", `${name} validation failed: ${path} is required`, { errors: { [path]: { kind: "required" } } });
            return;
        }
        if (!d) return;
        const list = Array.isArray(value) ? value : [value];
        for (const v of list) {
            if (d.min !== undefined && Number(v) < d.min) throw fail("ValidationError", `${name} validation failed: ${path} must be >= ${d.min}`, { errors: { [path]: { kind: "min" } } });
            if (d.max !== undefined && Number(v) > d.max) throw fail("ValidationError", `${name} validation failed: ${path} must be <= ${d.max}`, { errors: { [path]: { kind: "max" } } });
            if (d.enum && !d.enum.includes(v)) throw fail("ValidationError", `${name} validation failed: ${path} must be one of ${d.enum.join(", ")}`, { errors: { [path]: { kind: "enum" } } });
        }
    }
    function validateDoc(data) {
        for (const f of new Set([...requiredFields, ...defs.keys()])) checkField(f, getAtPath(data, f));
    }
    function castDoc(data) {
        const out = clone(data);
        for (const p of defs.keys()) {
            const v = getAtPath(out, p);
            if (v !== undefined) setAtPath(out, p, castValue(def(p), v, p));
        }
        return out;
    }
    // Seeds bypass casting on purpose, but a wrongly typed seed on a declared path is a test bug.
    function assertSeedTypes(data) {
        for (const p of defs.keys()) {
            const v = getAtPath(data, p);
            if (v === undefined || v === null) continue;
            const t = typeTag(v), want = { ObjectId: "objectid", String: "string", Number: "number", Boolean: "boolean", Date: "date" }[def(p).type];
            if (!(Array.isArray(v) ? v.every((x) => typeTag(x) === want) : t === want)) {
                throw fail("MockSeedTypeError", `${name}.__seed: path "${p}" must be ${def(p).type} but got ${t}`);
            }
        }
    }
    function checkUnique(data, ignoreId) {
        for (const f of uniqueFields) {
            const dup = docs.find((d) => d[f] !== undefined && strictEqual(d[f], data[f]) && !strictEqual(d._id, ignoreId));
            if (dup) throw fail("MongoServerError", `duplicate key on ${f}`, { code: 11000 });
        }
        for (const { fields, when } of uniqueIndexes) {
            if (typeof when === "function" && !when(data)) continue;
            const val = (d, f) => { const v = getAtPath(d, f); return v === undefined ? null : v; }; // missing == null in a Mongo index key
            const dup = docs.find((d) => (typeof when !== "function" || when(d)) && !strictEqual(d._id, ignoreId) && fields.every((f) => strictEqual(val(d, f), val(data, f))));
            if (dup) throw fail("MongoServerError", `E11000 duplicate key on (${fields.join(", ")})`, { code: 11000 });
        }
    }

    function applyUpdate(doc, update, { validate = false } = {}) {
        const ops = Object.keys(update || {});
        const operators = ops.filter((k) => k.startsWith("$"));
        if (operators.length && operators.length !== ops.length) throw fail("MockUnsupportedOperator", "Cannot mix update operators and plain fields");
        for (const op of operators) if (!UPDATE_OPS.has(op)) throw fail("MockUnsupportedOperator", `Unsupported update operator ${op}`);
        // Mongoose wraps a plain-field update in $set (it never replaces the document).
        if (!operators.length) return applyUpdate(doc, { $set: update }, { validate });
        const next = clone(doc);
        for (const [p, v] of Object.entries(update.$set || {})) {
            const cv = castValue(def(p), v, p);
            if (validate) checkField(p, cv, { onlyIfPresent: true });
            setAtPath(next, p, clone(cv));
        }
        for (const p of Object.keys(update.$unset || {})) unsetAtPath(next, p);
        for (const [p, v] of Object.entries(update.$inc || {})) {
            if (typeof v !== "number" || Number.isNaN(v)) throw fail("CastError", `$inc requires a number for ${p}`);
            const cur = getAtPath(next, p);
            if (cur !== undefined && cur !== null && typeof cur !== "number") throw fail("MongoServerError", `Cannot apply $inc to a value of non-numeric type at ${p}`);
            setAtPath(next, p, (cur || 0) + v);
        }
        for (const [p, v] of Object.entries(update.$push || {})) {
            if (isObj(v) && Object.keys(v).some((k) => k.startsWith("$"))) throw fail("MockUnsupportedOperator", `Unsupported $push modifier on ${p}`);
            const cur = getAtPath(next, p);
            if (cur !== undefined && cur !== null && !Array.isArray(cur)) throw fail("MongoServerError", `The field '${p}' must be an array to apply $push`);
            setAtPath(next, p, [...(cur || []), clone(castValue(def(p), v, p))]);
        }
        for (const [p, cond] of Object.entries(update.$pull || {})) {
            const cur = getAtPath(next, p);
            if (cur === undefined || cur === null) continue;
            if (!Array.isArray(cur)) throw fail("MongoServerError", `Cannot apply $pull to a non-array value at ${p}`);
            const isDoc = isObj(cond) && !Object.keys(cond).some((k) => k.startsWith("$"));
            setAtPath(next, p, cur.filter((item) => {
                if (isDoc) return !(item !== null && typeof item === "object" && matches(item, cond));
                return !matchValues([item], castCondition(def(p), cond, p));
            }));
        }
        return next;
    }

    class FakeQuery {
        constructor(factory) { this._factory = factory; this._sort = null; this._skip = 0; this._limit = 0; this._select = null; this.populated = []; }
        populate(...args) { this.populated.push(args); return this; } // not simulated: no joined collections here
        sort(s) { this._sort = s; return this; }
        skip(n) { this._skip = n; return this; }
        limit(n) { this._limit = n; return this; }
        select(s) { this._select = s; return this; }
        lean() { return this; }
        _shape(result) {
            if (!Array.isArray(result)) return this._project(result);
            let out = result;
            if (this._sort) {
                const keys = typeof this._sort === "string" ? this._sort.split(/\s+/).filter(Boolean).map((k) => [k.replace(/^-/, ""), k.startsWith("-") ? -1 : 1]) : Object.entries(this._sort);
                out = [...out].sort((a, b) => { for (const [k, dir] of keys) { const c = compare(getAtPath(a, k), getAtPath(b, k)); if (c) return c * (dir < 0 ? -1 : 1); } return 0; });
            }
            if (this._skip) out = out.slice(this._skip);
            if (this._limit) out = out.slice(0, this._limit);
            return out.map((d) => this._project(d));
        }
        _project(d) {
            if (!d || !this._select) return d;
            const fields = typeof this._select === "string" ? this._select.split(/\s+/).filter(Boolean) : Object.keys(this._select).filter((k) => this._select[k]);
            const exclude = fields.length && fields.every((f) => f.startsWith("-"));
            if (exclude) { const o = clone(d); fields.forEach((f) => unsetAtPath(o, f.slice(1))); return o; }
            const o = { _id: d._id };
            for (const f of fields) { const top = f.split(".")[0]; if (hasOwn(d, top)) o[top] = clone(d[top]); }
            return o;
        }
        exec() { return this._factory().then((r) => this._shape(r)); }
        then(resolve, reject) { return this.exec().then(resolve, reject); }
        catch(reject) { return this.exec().catch(reject); }
    }

    class FakeDoc {
        constructor(data) {
            Object.assign(this, castDoc(data));
            if (!this._id) this._id = new ObjectId();
        }
        async save() {
            validateDoc(this);
            checkUnique(this, this._id);
            const i = docs.findIndex((d) => strictEqual(d._id, this._id));
            const stored = clone({ ...this });
            if (i === -1) docs.push(stored); else docs[i] = stored;
            return this;
        }
    }

    // Cast + validate the whole filter BEFORE looking at any document (Mongoose does the same,
    // so a bad id / unknown operator fails even when the collection is empty).
    function castFilter(filter = {}) {
        const out = {};
        for (const [key, cond] of Object.entries(filter || {})) {
            if (key === "$and" || key === "$or" || key === "$nor") out[key] = cond.map(castFilter);
            else if (key.startsWith("$")) throw fail("MockUnsupportedOperator", `Unsupported top-level operator ${key}`);
            else out[key] = castPath(key, cond);
        }
        return out;
    }
    const find = (filter = {}) => { const cf = castFilter(filter); return docs.filter((d) => matches(d, cf)); };
    FakeDoc.find = (filter = {}) => new FakeQuery(async () => find(filter).map(clone));
    FakeDoc.findOne = (filter = {}) => new FakeQuery(async () => { const d = find(filter)[0]; return d ? clone(d) : null; });
    FakeDoc.findById = (id) => FakeDoc.findOne({ _id: id });
    FakeDoc.create = async (data) => new FakeDoc(data).save();
    FakeDoc.countDocuments = async (filter = {}) => find(filter).length;
    FakeDoc.exists = async (filter = {}) => { const d = find(filter)[0]; return d ? { _id: d._id } : null; };
    FakeDoc.aggregate = async (pipeline = []) => {
        const filter = pipeline.find((s) => s.$match)?.$match || {};
        const ratings = find(filter).flatMap((d) => (Array.isArray(d.reviews) ? d.reviews : [])).map((r) => Number(r.rating)).filter((r) => Number.isFinite(r) && r >= 1 && r <= 5);
        return ratings.length ? [{ _id: null, reviewCount: ratings.length, rating: ratings.reduce((a, b) => a + b, 0) / ratings.length }] : [];
    };

    function updateOneInternal(filter, update, opts = {}) {
        if (opts.upsert) throw fail("MockUnsupportedOperator", "upsert is not supported by the fake model");
        const cf = castFilter(filter);
        const idx = docs.findIndex((d) => matches(d, cf));
        if (idx === -1) return null;
        const before = docs[idx];
        const after = applyUpdate(before, update, { validate: !!opts.runValidators });
        checkUnique(after, before._id);
        docs[idx] = after;
        return { before: clone(before), after: clone(after), changed: !strictEqual(before, after) };
    }

    FakeDoc.findOneAndUpdate = (filter, update, opts = {}) => new FakeQuery(async () => {
        if (typeof FakeDoc.__beforeFindOneAndUpdate === "function") await FakeDoc.__beforeFindOneAndUpdate(filter, update);
        const r = updateOneInternal(filter, update, opts);
        if (!r) return null;
        return opts.new === true || opts.returnDocument === "after" ? r.after : r.before;
    });
    FakeDoc.findByIdAndUpdate = (id, update, opts) => FakeDoc.findOneAndUpdate({ _id: id }, update, opts);
    FakeDoc.updateOne = async (filter, update, opts = {}) => {
        const r = updateOneInternal(filter, update, opts);
        return { acknowledged: true, matchedCount: r ? 1 : 0, modifiedCount: r && r.changed ? 1 : 0 };
    };
    FakeDoc.updateMany = async (filter, update, opts = {}) => {
        if (opts.upsert) throw fail("MockUnsupportedOperator", "upsert is not supported by the fake model");
        let matched = 0, modified = 0;
        const cf = castFilter(filter);
        for (let i = 0; i < docs.length; i++) {
            if (!matches(docs[i], cf)) continue;
            matched++;
            const after = applyUpdate(docs[i], update, { validate: !!opts.runValidators });
            checkUnique(after, docs[i]._id);
            if (!strictEqual(docs[i], after)) modified++;
            docs[i] = after;
        }
        return { acknowledged: true, matchedCount: matched, modifiedCount: modified };
    };
    FakeDoc.findOneAndDelete = async (filter) => {
        const cf = castFilter(filter);
        const idx = docs.findIndex((d) => matches(d, cf));
        if (idx === -1) return null;
        return clone(docs.splice(idx, 1)[0]);
    };
    FakeDoc.findByIdAndDelete = (id) => FakeDoc.findOneAndDelete({ _id: id });

    if (defs.schema) FakeDoc.schema = defs.schema; // lets a fake be passed where a model is expected
    FakeDoc.__docs = docs; // test inspection helper
    FakeDoc.__seed = (arr) => { arr.forEach(assertSeedTypes); docs.push(...arr.map((d) => { const c = clone(d); if (!c._id) c._id = new ObjectId(); return c; })); };
    return FakeDoc;
}

// Load the REAL Mongoose schema of a project model (no DB connection needed) so the fake
// casts and validates exactly the paths the application declares.
const realCache = new Map();
function realSchema(file) {
    if (realCache.has(file)) return realCache.get(file);
    const model = require(require("path").join(__dirname, "..", "..", "models", file));
    // A test may already have injected a fake over this module in require.cache.
    if (!model || !model.schema || typeof model.schema.path !== "function") throw new Error(`realSchema("${file}"): module is not a real Mongoose model (already replaced by a fake?)`);
    realCache.set(file, model);
    return model;
}

module.exports = { makeFakeModel, describeSchema, realSchema, ObjectId, strictEqual };