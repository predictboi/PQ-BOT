// Pure LS-LMSR (Othman/Sandholm/Pennock/Reeves 2010) — ported from tools/lslmsr-test/src/lslmsr.js.
//   b(q) = alpha·Σq ;  C(q) = b·ln Σ exp(q_j/b)
//   p_i  = alpha·L + softmax_i − (alpha/b)·Σ q_j·softmax_j      (L = ln Σ exp(q_j/b))
//   buy k of i cost = C(q+k·e_i) − C(q) ;  sell refund = C(q) − C(q−k·e_i)
// Polyquest displays NORMALIZED prices (p_i / Σp). Use `normPrices()` when comparing with the site / Polymarket.
export class LsLmsr {
  constructor({ outcomes, alpha, seed, seedMode = 'cost', q }) {
    if (!(alpha > 0)) throw new Error('alpha must be > 0');
    this.alpha = alpha;
    if (q) { this.q = q.slice(); this.n = q.length; }
    else {
      if (!(outcomes >= 2)) throw new Error('outcomes must be >= 2');
      this.n = outcomes;
      const k = alpha * outcomes * Math.log(outcomes);
      const q0 = seedMode === 'cost' ? seed / (1 + k) : seed / k;
      this.q = Array(outcomes).fill(q0);
    }
    this.q0 = this.q.slice();
  }
  static b(q, alpha) { return alpha * q.reduce((a, x) => a + x, 0); }
  static cost(q, alpha) {
    const b = LsLmsr.b(q, alpha);
    if (!(b > 0)) throw new Error('b(q) must be > 0');
    const z = q.map((x) => x / b); const m = Math.max(...z);
    const s = z.reduce((a, x) => a + Math.exp(x - m), 0);
    return b * (m + Math.log(s));
  }
  static prices(q, alpha) {
    const b = LsLmsr.b(q, alpha);
    const z = q.map((x) => x / b); const m = Math.max(...z);
    const e = z.map((x) => Math.exp(x - m)); const s = e.reduce((a, x) => a + x, 0);
    const L = m + Math.log(s); const soft = e.map((x) => x / s);
    const wq = q.reduce((a, x, j) => a + x * soft[j], 0);
    return soft.map((sm) => alpha * L + sm - (alpha / b) * wq);
  }
  static normalize(p) { const s = p.reduce((a, x) => a + x, 0); return p.map((x) => x / s); }
  get b() { return LsLmsr.b(this.q, this.alpha); }
  cost() { return LsLmsr.cost(this.q, this.alpha); }
  prices() { return LsLmsr.prices(this.q, this.alpha); }
  normPrices() { return LsLmsr.normalize(this.prices()); }
  clone() { const c = new LsLmsr({ alpha: this.alpha, q: this.q }); c.q0 = this.q0.slice(); return c; }
  quoteBuy(i, shares) { const q2 = this.q.slice(); q2[i] += shares; return LsLmsr.cost(q2, this.alpha) - this.cost(); }
  quoteSell(i, shares) { const q2 = this.q.slice(); q2[i] -= shares; if (q2[i] < 0) throw new Error('cannot sell below zero'); return this.cost() - LsLmsr.cost(q2, this.alpha); }
  sharesForAmount(i, amount, tol = 1e-10) {
    if (!(amount > 0)) return 0;
    let lo = 0, hi = amount;
    while (this.quoteBuy(i, hi) < amount) hi *= 2;
    for (let it = 0; it < 200 && hi - lo > tol * Math.max(1, hi); it++) { const mid = (lo + hi) / 2; if (this.quoteBuy(i, mid) < amount) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  buy(i, shares) { const priceBefore = this.normPrices()[i]; const paid = this.quoteBuy(i, shares); this.q[i] += shares; const priceAfter = this.normPrices()[i]; return { shares, paid, priceBefore, priceAfter, avgPrice: paid / shares }; }
  buyAmount(i, amount) { return this.buy(i, this.sharesForAmount(i, amount)); }
  sell(i, shares) { const priceBefore = this.normPrices()[i]; const received = this.quoteSell(i, shares); this.q[i] -= shares; const priceAfter = this.normPrices()[i]; return { shares, received, priceBefore, priceAfter, avgPrice: received / shares }; }
  outstanding(i) { return this.q[i] - this.q0[i]; }
}

/** Build a model from Polyquest `quest.lslmsrState` → marketState { outcomeSharesWad[], alphaWad } (both 1e18-scaled). */
export function modelFromState(marketState) {
  const q = (marketState.outcomeSharesWad || []).map((w) => Number(w) / 1e18);
  const alpha = Number(marketState.alphaWad) / 1e18;
  return new LsLmsr({ alpha, q });
}

/**
 * Minimum collateral to spend on outcome `i` so that the NORMALIZED price of `i` reaches `target` (bisection on spend).
 * Returns { spend, priceAfter } or null if already at/above target. Capped at `maxSpend`.
 */
export function spendToReachPrice(model, i, target, { maxSpend = 1e9, tol = 1e-4 } = {}) {
  const p0 = model.normPrices()[i];
  if (p0 >= target - 1e-9) return null;
  const priceAfter = (x) => { const m = model.clone(); m.buyAmount(i, x); return m.normPrices()[i]; };
  let lo = 0, hi = 50;
  while (priceAfter(hi) < target && hi < maxSpend) hi *= 2;
  hi = Math.min(hi, maxSpend);
  if (priceAfter(hi) < target) return { spend: hi, priceAfter: priceAfter(hi), capped: true };
  for (let it = 0; it < 80 && hi - lo > Math.max(0.01, tol * hi); it++) { const mid = (lo + hi) / 2; if (priceAfter(mid) < target) lo = mid; else hi = mid; }
  return { spend: hi, priceAfter: priceAfter(hi), capped: false };
}
