// Money helpers: all order arithmetic is done in INTEGER CENTS so binary
// floating point can never leak into prices or totals (0.1 + 0.2, 3413.2599999999998 ...).
// Rounding policy: round half up (an exact half cent goes up).

// Currency amount (e.g. 630.55) -> integer cents. Math.round absorbs the
// representation noise of values that are already (at most) 2-decimal amounts.
const toCents = (amount) => Math.round(Number(amount) * 100);

// Integer cents -> currency amount. Dividing an integer by 100 yields the
// double closest to the two-decimal value, so the stored number is whole cents.
const fromCents = (cents) => cents / 100;

// Integer round-half-up of num / den (non-negative integers).
const divRoundHalfUp = (num, den) => Math.floor((2 * num + den) / (2 * den));

// Percent (0-100, up to 2 decimals) -> basis points (0-10000).
const percentToBps = (percent) => Math.round(Number(percent) * 100);

// cents after taking `percent` off, rounded half up once, in integers only.
const applyPercentOffCents = (cents, percent) =>
  divRoundHalfUp(cents * (10000 - percentToBps(percent)), 10000);

module.exports = { toCents, fromCents, divRoundHalfUp, percentToBps, applyPercentOffCents };