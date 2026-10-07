// Central place for Socket.IO rooms and event payloads.
//
// Rooms
//   catalog    - PUBLIC catalog notifications (new/updated/deleted product,
//                section, review, store). Every connected client may be in it
//                (see `join_users` in server.js), so payloads sent here must
//                contain ONLY data that is already public, and only the
//                minimum the frontend needs (ids + display name). The client
//                re-fetches the real data through the normal, authorised API.
//   user:<id>  - PRIVATE room of one authenticated user (joined only after the
//                JWT cookie is verified in server.js).
//   admins     - super_admin dashboards (joined only after a role check).
//
// Never put a full Mongoose document, e-mail, phone number, GPS URL, password
// hash or any other private field in a payload.

const CATALOG_ROOM = "catalog";
const ADMINS_ROOM = "admins";

const user_room = (user_id) => `user:${String(user_id)}`;
const seller_room = (user_id) => `seller:${String(user_id)}`;

// Emits one event to one or more rooms. The database write that triggered
// the event has already succeeded, so a socket problem must never turn the
// request into a 500: errors are logged and swallowed.
function emit_to(io, rooms, event, payload) {
    if (!io) {
        return;
    }
    try {
        for (const room of Array.isArray(rooms) ? rooms : [rooms]) {
            io.to(room).emit(event, payload);
        }
    } catch (e) {
        console.warn(`[socket] failed to emit "${event}":`, e.message);
    }
}

// A socket joins its private rooms once, at connection time, from the role
// stored in the database at that moment. When an admin changes a role later,
// already-open sockets of that user must follow the change immediately,
// otherwise a promoted seller misses new_order / new_ticket until reconnecting
// and a demoted seller keeps receiving them. Both helpers only ever touch the
// affected user's own rooms (derived from the DB id, never from a client
// value) and never throw: the role change is already saved.
function grant_seller_room(io, user_id) {
    if (!io || typeof io.in !== "function") return;
    try {
        io.in(user_room(user_id)).socketsJoin(seller_room(user_id));
    } catch (e) {
        console.warn("[socket] failed to add sockets to the seller room:", e.message);
    }
}

function revoke_seller_room(io, user_id) {
    if (!io || typeof io.in !== "function") return;
    try {
        io.in(seller_room(user_id)).socketsLeave(seller_room(user_id));
    } catch (e) {
        console.warn("[socket] failed to remove sockets from the seller room:", e.message);
    }
}

const id_of = (doc) => (doc && doc._id !== undefined ? String(doc._id) : undefined);

// ---- minimal public payloads ----

const product_payload = (product) => ({
    product_id: id_of(product),
    name: product.name,
});

const section_payload = (section) => ({
    section_id: id_of(section),
    name: section.name,
});

const review_payload = (product_id, review) => ({
    product_id: String(product_id),
    review_id: id_of(review),
    rating: review.rating,
});

const store_payload = (store) => ({
    store_id: id_of(store),
    slug: store.slug,
});

// ---- minimal role-change payload (user's own room + admins only) ----

const user_role_payload = (user) => ({
    _id: id_of(user),
    name: user.name,
    role: user.role,
});

module.exports = {
    CATALOG_ROOM,
    ADMINS_ROOM,
    user_room,
    seller_room,
    emit_to,
    grant_seller_room,
    revoke_seller_room,
    product_payload,
    section_payload,
    review_payload,
    store_payload,
    user_role_payload,
};