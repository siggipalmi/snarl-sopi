/**
 * The money received for a fridge order the customer paid only part of (fridge 0.70.13: the card
 * allowed less than the basket and nobody tapped for the rest). It is real revenue, so it goes to
 * `orders` like any sale — but at what was paid, not the basket's total.
 *
 * Accounting sums the lines by VAT rate, so the paid amount is spread over the lines in proportion
 * to their value: the VAT split of what was received matches the basket's. Units are left as they
 * were — every item did leave the machine.
 */

/**
 * Lines with lineIsk scaled so they sum to exactly [paidIsk] (largest remainder, whole kr).
 * Lines with no value keep 0. Returns new objects; the inputs are not changed.
 */
function paidShare(lines, paidIsk, totalIsk) {
  const rows = (lines || []).map(l => Object.assign({}, l));
  const paid = Math.max(0, Math.round(paidIsk || 0));
  const value = rows.map(l => Math.max(0, Number(l.lineIsk) || 0));
  const sum = value.reduce((s, v) => s + v, 0);
  if (!sum) {
    // No line carries a value (not something the app sends): book it all on the first line.
    if (rows.length && paid < Math.round(totalIsk || 0)) rows.forEach((l, i) => { l.lineIsk = i === 0 ? paid : 0; });
    return rows;
  }
  if (paid >= sum) return rows;
  const exact = value.map(v => v * paid / sum);
  const floor = exact.map(Math.floor);
  let left = paid - floor.reduce((s, v) => s + v, 0);
  const order = exact.map((x, i) => [x - floor[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; floor[i] += 1; left -= 1; }
  rows.forEach((l, i) => { l.lineIsk = floor[i]; });
  return rows;
}

module.exports = { paidShare };
