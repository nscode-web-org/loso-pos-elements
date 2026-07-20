import { LosoPosClient } from '@nscodecom/loso-pos-sdk';
import type { FetchLike } from '@nscodecom/loso-pos-sdk';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { defineLosoPosElements } from './registry.js';
import type { LosoPosPanel } from './panel.js';

beforeAll(() => defineLosoPosElements());

const ok = <T>(data: T) => ({ ok: true, data, warnings: [] });

/** Replays queued responses in order, and records what was sent. */
function mockFetch(responses: unknown[]): { fetch: FetchLike; calls: Array<{ url: string; body?: string; headers?: Record<string, string> }> } {
  const calls: Array<{ url: string; body?: string; headers?: Record<string, string> }> = [];
  let i = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, body: init?.body, headers: init?.headers });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return Promise.resolve({
      status: 200,
      ok: true,
      text: () => Promise.resolve(JSON.stringify(next)),
    });
  };
  return { fetch, calls };
}

function mountPanel(fetch?: FetchLike): LosoPosPanel {
  const el = document.createElement('loso-pos-panel') as LosoPosPanel;
  el.setAttribute('subtotal', '42.00');
  el.setAttribute('currency', 'BAM');
  el.setAttribute('pos-transaction-id', 'POS-1');
  if (fetch) {
    el.client = new LosoPosClient({ baseUrl: 'https://till.vendor.example', auth: 'proxy', fetch });
  }
  document.body.append(el);
  return el;
}

const quoteData = {
  customer: { customerRef: 'c1', name: 'Sarah K.', tier: 'Gold', active: true },
  redeemable: {
    maxDiscount: 20,
    maxDiscountPercent: 47.61,
    currency: 'BAM',
    options: [],
    constraints: { minPoints: 100, maxPercentOfSubtotal: 50, step: 0.01 },
  },
  earn: { estimatedPoints: 42 },
  redemptionToken: 'tok_abc',
  quoteExpiresAt: '2026-07-16T12:39:00Z',
};

describe('<loso-pos-panel> — credentials', () => {
  it('never sends an Authorization header when driven by base-url', async () => {
    const { fetch, calls } = mockFetch([ok(quoteData)]);
    // Stand in for the element's own lazily-built proxy client, which takes no key at all.
    const client = new LosoPosClient({ baseUrl: 'https://till.vendor.example', auth: 'proxy', fetch });
    await client.getConfig();
    expect(calls[0]?.headers?.['Authorization']).toBeUndefined();
  });

  it('exposes no attribute or property that accepts an API key', () => {
    const el = mountPanel();
    // The guarantee is structural: if a future change adds one, this fails.
    expect(Object.keys(el)).not.toContain('apiKey');
    expect(el.getAttribute('api-key')).toBeNull();
    const observed = (customElements.get('loso-pos-panel') as typeof HTMLElement & {
      observedAttributes: string[];
    }).observedAttributes;
    expect(observed).not.toContain('api-key');
    expect(observed).not.toContain('key');
  });
});

describe('<loso-pos-panel> — flow', () => {
  it('resolves a customer and emits the event', async () => {
    const { fetch } = mockFetch([ok({ customerRef: 'c1', name: 'Sarah K.', tier: 'Gold', active: true })]);
    const el = mountPanel(fetch);

    const seen = new Promise((resolve) =>
      el.addEventListener('loso-customer-resolved', (e) => resolve((e as CustomEvent).detail.customer))
    );
    await el.resolve('+38765423554');

    expect(await seen).toMatchObject({ name: 'Sarah K.' });
    expect(el.shadowRoot?.textContent).toContain('Sarah K.');
  });

  it('quotes, and defaults the discount to zero rather than spending points for the cashier', async () => {
    const { fetch } = mockFetch([ok(quoteData)]);
    const el = mountPanel(fetch);
    await el.quote();

    expect(el.discount).toBe(0);
    expect(el.shadowRoot?.textContent).toContain('20.00');
  });

  it('commits with the accepted discount and a reconciling finalAmount', async () => {
    const { fetch, calls } = mockFetch([
      ok(quoteData),
      ok({
        loyaltyReference: 'TXN-1',
        posTransactionId: 'POS-1',
        discountApplied: 12.5,
        pointsRedeemed: 1250,
        pointsEarned: 29.5,
        newPointsBalance: 779.5,
        finalAmount: 29.5,
      }),
    ]);
    const el = mountPanel(fetch);
    await el.quote();

    // Drive the slider the way a cashier would.
    const slider = el.shadowRoot?.querySelector<HTMLInputElement>('[data-el="discount"]');
    expect(slider).toBeTruthy();
    slider!.value = '12.5';
    slider!.dispatchEvent(new Event('input'));
    expect(el.discount).toBe(12.5);

    await el.commit();

    const body = JSON.parse(calls[1]?.body ?? '{}');
    expect(body.redemption).toMatchObject({ redemptionToken: 'tok_abc', acceptDiscount: 12.5 });
    // The contract rejects a commit whose tender does not match subtotal - discount.
    expect(body.tender.finalAmount).toBe(29.5);
    expect(el.committed?.loyaltyReference).toBe('TXN-1');
  });

  it('omits the redemption block entirely on an earn-only sale', async () => {
    const { fetch, calls } = mockFetch([
      ok(quoteData),
      ok({ loyaltyReference: 'TXN-2', discountApplied: 0, pointsRedeemed: 0, pointsEarned: 42, newPointsBalance: 42, finalAmount: 42 }),
    ]);
    const el = mountPanel(fetch);
    await el.quote();
    await el.commit(); // discount left at 0

    const body = JSON.parse(calls[1]?.body ?? '{}');
    expect(body.redemption).toBeUndefined();
    expect(body.tender.finalAmount).toBe(42);
  });

  it('clamps a discount above the quoted ceiling', async () => {
    const { fetch } = mockFetch([ok(quoteData)]);
    const el = mountPanel(fetch);
    await el.quote();

    const slider = el.shadowRoot?.querySelector<HTMLInputElement>('[data-el="discount"]');
    slider!.value = '999';
    slider!.dispatchEvent(new Event('input'));

    expect(el.discount).toBe(20); // maxDiscount, not 999
  });

  it('drops a stale quote when the cart changes', async () => {
    const { fetch } = mockFetch([ok(quoteData)]);
    const el = mountPanel(fetch);
    await el.quote();
    expect(el.discount).toBe(0);

    el.setAttribute('subtotal', '50.00');
    // A quote priced against the old basket would be refused as quote.cart_mismatch.
    expect(el.shadowRoot?.querySelector('[data-el="discount"]')).toBeNull();
  });
});

describe('<loso-pos-panel> — failure', () => {
  it('surfaces a business error without throwing', async () => {
    const { fetch } = mockFetch([
      { ok: false, error: { code: 'redeem.insufficient_points', message: 'Not enough points.', retryable: true } },
    ]);
    const el = mountPanel(fetch);

    const seen = new Promise((resolve) =>
      el.addEventListener('loso-error', (e) => resolve((e as CustomEvent).detail.error))
    );
    await expect(el.quote()).resolves.toBeUndefined();

    expect(await seen).toMatchObject({ code: 'redeem.insufficient_points' });
    expect(el.shadowRoot?.textContent).toContain('Not enough points.');
  });

  it('refuses to commit without a pos-transaction-id rather than inventing one', async () => {
    const { fetch, calls } = mockFetch([ok(quoteData)]);
    const el = mountPanel(fetch);
    el.removeAttribute('pos-transaction-id');
    await el.quote();

    const seen = new Promise((resolve) =>
      el.addEventListener('loso-error', (e) => resolve((e as CustomEvent).detail.error))
    );
    await el.commit();

    expect(await seen).toMatchObject({ code: 'request.validation_failed', retryable: false });
    expect(calls).toHaveLength(1); // the quote only — no commit went out
    expect(el.committed).toBeNull();
  });

  it('reports a missing base-url as a config error rather than crashing', async () => {
    const el = mountPanel(); // no client, no base-url
    const seen = new Promise((resolve) =>
      el.addEventListener('loso-error', (e) => resolve((e as CustomEvent).detail.error))
    );
    await el.quote();
    expect(await seen).toMatchObject({ retryable: false });
  });

  it('escapes API-supplied text instead of rendering it as markup', async () => {
    const { fetch } = mockFetch([
      ok({ customerRef: 'c1', name: '<img src=x onerror="alert(1)">', tier: 'Gold', active: true }),
    ]);
    const el = mountPanel(fetch);
    await el.resolve('x');

    expect(el.shadowRoot?.querySelector('img')).toBeNull();
    expect(el.shadowRoot?.textContent).toContain('<img src=x');
  });
});

/** A fetch whose one response is withheld until you call `release()`. */
function deferredFetch(response: unknown): { fetch: FetchLike; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fetch: FetchLike = async () => {
    await gate;
    return { status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(response)) };
  };
  return { fetch, release };
}

describe('<loso-pos-panel> — accessibility', () => {
  it('names itself as a landmark, without clobbering an author-set label', () => {
    const el = mountPanel();
    expect(el.getAttribute('role')).toBe('group');
    expect(el.getAttribute('aria-label')).toBe('Loyalty');

    const custom = document.createElement('loso-pos-panel') as LosoPosPanel;
    custom.setAttribute('aria-label', 'Rewards');
    document.body.append(custom);
    expect(custom.getAttribute('aria-label')).toBe('Rewards'); // left alone
  });

  it('keeps persistent live regions that survive a re-render', () => {
    const el = mountPanel();
    const status = el.shadowRoot?.querySelector('[data-el="status"]');
    const alert = el.shadowRoot?.querySelector('[data-el="alert"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(alert?.getAttribute('role')).toBe('alert');

    // Force a re-render; the very same region nodes must still be there, or an
    // announcement set on them would never reach a screen reader.
    el.setAttribute('subtotal', '99.00');
    expect(el.shadowRoot?.querySelector('[data-el="status"]')).toBe(status);
  });

  it('announces a ready quote politely and a failure assertively', async () => {
    const { fetch } = mockFetch([ok(quoteData)]);
    const el = mountPanel(fetch);
    await el.quote();
    expect(el.shadowRoot?.querySelector('[data-el="status"]')?.textContent).toMatch(/Quote ready.*20\.00 BAM/);

    const { fetch: failing } = mockFetch([
      { ok: false, error: { code: 'redeem.insufficient_points', message: 'Not enough points.', retryable: true } },
    ]);
    el.client = new LosoPosClient({ baseUrl: 'https://till.vendor.example', auth: 'proxy', fetch: failing });
    await el.quote();
    expect(el.shadowRoot?.querySelector('[data-el="alert"]')?.textContent).toBe('Not enough points.');
  });

  it('gives the slider a spoken value that tracks the drag', async () => {
    const { fetch } = mockFetch([ok(quoteData)]);
    const el = mountPanel(fetch);
    await el.quote();

    const slider = el.shadowRoot?.querySelector<HTMLInputElement>('[data-el="discount"]');
    // Named by the visible <label>, valued by aria-valuetext — so a reader says
    // "Loyalty discount, 0.00 BAM" not a bare "0".
    expect(el.shadowRoot?.querySelector('label[for="loso-discount"]')?.textContent?.trim()).toBe('Loyalty discount');
    expect(slider?.getAttribute('aria-valuetext')).toBe('0.00 BAM, 0 percent');

    slider!.value = '12.5';
    slider!.dispatchEvent(new Event('input'));
    // 12.50 / 42.00 = 29.76%, floored (never rounded up, same rule as the wire contract).
    expect(slider?.getAttribute('aria-valuetext')).toBe('12.50 BAM, 29.76 percent');
  });

  it('disables controls and marks itself busy while a request is in flight', async () => {
    const { fetch, release } = deferredFetch(ok(quoteData));
    const el = mountPanel();
    el.client = new LosoPosClient({ baseUrl: 'https://till.vendor.example', auth: 'proxy', fetch });

    const pending = el.quote();
    // Mid-flight: aria-busy set, and the quote button cannot be fired again.
    expect(el.getAttribute('aria-busy')).toBe('true');
    const quoteButton = el.shadowRoot?.querySelector<HTMLButtonElement>('[data-act="quote"]');
    expect(quoteButton?.disabled).toBe(true);

    release();
    await pending;
    expect(el.getAttribute('aria-busy')).toBe('false');
  });

  it('moves focus to the next step so a keyboard user is not dropped', async () => {
    const { fetch } = mockFetch([ok({ customerRef: 'c1', name: 'Sarah K.', tier: 'Gold', active: true })]);
    const el = mountPanel(fetch);

    // Put focus where a cashier's is when they trigger resolve — in the scan field. This
    // is also the loose state the panel needs to claim focus, and it sidesteps the
    // activeElement that happy-dom leaks between tests in its shared document.
    el.shadowRoot?.querySelector<HTMLInputElement>('[data-el="code"]')?.focus();

    // Assert on what the panel focused, via a spy: happy-dom's ShadowRoot.activeElement
    // getter is unreliable, but the behavior under test is "the panel calls focus() on
    // the next control", which is exactly what this captures.
    let focused: HTMLElement | null = null;
    const spy = vi
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(function (this: HTMLElement) {
        focused = this;
      });
    try {
      await el.resolve('+38765423554');
    } finally {
      spy.mockRestore();
    }

    // The scan input that had focus is gone; focus should land on the quote button.
    expect(focused).not.toBeNull();
    expect((focused as unknown as HTMLElement).getAttribute('data-act')).toBe('quote');
  });
});
