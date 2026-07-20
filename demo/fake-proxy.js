// An in-memory stand-in for a vendor's proxy + the Loso API, so the demo runs with no
// backend and no key. It implements the six `/api/pos/v1` endpoints the panel calls, with
// arithmetic that matches the worked example in the wire guide: earn 1 point per 1.00,
// cash out at 0.01 per point, redemption capped at 50% of subtotal, 100-point minimum.
//
// This is a demo fixture, not a reference implementation — the real ledger lives server-side.

const round2 = (n) => Math.round(n * 100) / 100;

const CONFIG = {
  apiVersion: 'v1',
  currency: 'BAM',
  redeemEnabled: true,
  maxRedeemPercentOfSubtotal: 50,
  earnBasis: 'net',
  quoteTtlSeconds: 300,
};

/** Seed customers, keyed by the code you'd scan (id, phone). Balances mutate as you sell. */
function seedCustomers() {
  return {
    'cust-sarah': { customerRef: 'cust-sarah', name: 'Sarah K.', tier: 'Gold', active: true, points: 2000 },
    '+38765423554': { customerRef: 'cust-sarah' }, // alias → same customer
    'cust-marko': { customerRef: 'cust-marko', name: 'Marko P.', tier: 'Silver', active: true, points: 80 }, // below the 100 minimum
  };
}

const ok = (data, warnings = []) => ({ status: 200, body: { ok: true, data, warnings } });
const fail = (status, code, message, extra = {}) => ({
  status,
  body: { ok: false, error: { code, message, ...extra } },
});

export function createFakeProxy() {
  let customers = seedCustomers();
  const sales = {}; // loyaltyReference → sale record, for refunds
  let down = false; // "proxy unreachable" toggle
  let seq = 481;

  const resolveCustomer = (ref) => {
    const c = customers[ref];
    return c && c.customerRef && c.name ? c : customers[c?.customerRef];
  };

  const routes = {
    'GET /config': () => ok(CONFIG),

    'GET /customer/resolve': (_body, query) => {
      const code = (query.get('code') || '').trim();
      const hit = customers[code] && (customers[code].name ? customers[code] : customers[customers[code].customerRef]);
      if (!hit) return fail(404, 'customer.not_found', 'No customer matches that code.');
      const { customerRef, name, tier, active } = hit;
      return ok({ customerRef, name, tier, active });
    },

    'POST /quote': (body) => {
      const subtotal = body?.cart?.subtotal ?? 0;
      const cust = body.customerRef ? resolveCustomer(body.customerRef) : null;
      const estimatedPoints = Math.floor(subtotal); // gross earn estimate
      const base = {
        earn: { estimatedPoints, note: 'Approximate; earned on the net amount paid.' },
      };
      if (!cust || body?.intent?.wantRedeem === false) {
        return ok(base);
      }

      const cashout = round2(cust.points * 0.01);
      const cap = round2(subtotal * (CONFIG.maxRedeemPercentOfSubtotal / 100));
      const maxDiscount = cust.points < 100 ? 0 : Math.min(cashout, cap);
      if (maxDiscount <= 0) {
        return ok({ ...base, customer: pick(cust) });
      }

      const maxDiscountPercent = Math.floor((maxDiscount / subtotal) * 10000) / 100;
      return ok({
        ...base,
        customer: pick(cust),
        redeemable: {
          maxDiscount,
          maxDiscountPercent,
          currency: CONFIG.currency,
          options: [
            {
              type: 'points_cashout',
              discount: maxDiscount,
              discountPercent: maxDiscountPercent,
              costPoints: Math.round(maxDiscount / 0.01),
              label: `Redeem ${Math.round(maxDiscount / 0.01)} points (${maxDiscount.toFixed(2)} ${CONFIG.currency})`,
            },
          ],
          constraints: { minPoints: 100, maxPercentOfSubtotal: 50, step: 0.01 },
        },
        redemptionToken: `demo-tok-${Math.random().toString(36).slice(2, 10)}`,
        quoteExpiresAt: new Date(Date.now() + CONFIG.quoteTtlSeconds * 1000).toISOString(),
      });
    },

    'POST /commit': (body) => {
      const subtotal = body?.cart?.subtotal ?? 0;
      const acceptDiscount = body?.redemption?.acceptDiscount ?? 0;
      const cust = body.customerRef ? resolveCustomer(body.customerRef) : null;
      const finalAmount = round2(subtotal - acceptDiscount);

      const pointsRedeemed = Math.round(acceptDiscount / 0.01);
      const pointsEarned = Math.round(finalAmount); // net earn
      if (cust) cust.points = round2(cust.points - pointsRedeemed + pointsEarned);

      const loyaltyReference = `TXN-DEMO-${seq++}`;
      sales[loyaltyReference] = {
        loyaltyReference,
        customerRef: cust?.customerRef ?? null,
        finalAmount,
        pointsRedeemed,
        pointsEarned,
        refundedTotal: 0,
      };
      return ok({
        loyaltyReference,
        posTransactionId: body.posTransactionId,
        discountApplied: acceptDiscount,
        pointsRedeemed,
        pointsEarned,
        newPointsBalance: cust?.points ?? 0,
        finalAmount,
      });
    },

    'POST /commit/:ref/refund': (body, _query, ref) => {
      const sale = sales[ref];
      if (!sale) return fail(404, 'commit.not_found', 'No sale matches that reference.');
      const remaining = round2(sale.finalAmount - sale.refundedTotal);
      const full = body?.amount === undefined;
      const amount = full ? remaining : body.amount;
      if (amount > remaining + 0.001) {
        return fail(422, 'refund.exceeds_amount', 'Refund would exceed the sale total.');
      }

      const fraction = sale.finalAmount > 0 ? amount / sale.finalAmount : 0;
      const pointsReversed = Math.round(sale.pointsEarned * fraction);
      const pointsRestored = Math.round(sale.pointsRedeemed * fraction);
      const cust = sale.customerRef ? customers[sale.customerRef] : null;
      if (cust) cust.points = round2(cust.points - pointsReversed + pointsRestored);
      sale.refundedTotal = round2(sale.refundedTotal + amount);

      return ok({
        refundReference: `RFD-DEMO-${seq++}`,
        loyaltyReference: ref,
        type: full && sale.refundedTotal === amount ? 'full' : 'partial',
        refundedAmount: amount,
        pointsReversed,
        pointsRestored,
        newPointsBalance: cust?.points ?? 0,
      });
    },
  };

  /** A `fetch` in the shape the SDK depends on. Routes on the path under /api/pos/v1. */
  const fetch = async (url, init) => {
    if (down) {
      // What the SDK turns into a `loyalty.unreachable` envelope — the till sells full price.
      throw new TypeError('Failed to fetch (demo: proxy is down)');
    }
    await delay(200); // a touch of latency, so the busy state is visible

    const method = (init?.method || 'GET').toUpperCase();
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^.*\/api\/pos\/v1/, '');
    const body = init?.body ? JSON.parse(init.body) : undefined;

    // Match /commit/{ref}/refund first, then the static routes.
    const refund = path.match(/^\/commit\/([^/]+)\/refund$/);
    const handler = refund
      ? routes['POST /commit/:ref/refund']
      : routes[`${method} ${path.split('?')[0]}`];

    const result = handler
      ? refund
        ? handler(body, parsed.searchParams, decodeURIComponent(refund[1]))
        : handler(body, parsed.searchParams)
      : fail(404, 'request.validation_failed', `No demo route for ${method} ${path}`);

    return {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      text: async () => JSON.stringify(result.body),
    };
  };

  return {
    fetch,
    setDown: (value) => {
      down = value;
    },
    reset: () => {
      customers = seedCustomers();
      for (const k of Object.keys(sales)) delete sales[k];
    },
    balanceOf: (ref) => customers[ref]?.points ?? null,
  };
}

function pick(c) {
  return { customerRef: c.customerRef, name: c.name, tier: c.tier, active: c.active };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
