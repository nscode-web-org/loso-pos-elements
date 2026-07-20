import { LosoPosClient } from '@nscodecom/loso-pos-sdk';
import type {
  PosCart,
  PosCommitResponse,
  PosCustomer,
  PosEnvelope,
  PosError,
  PosQuoteResponse,
  PosRefundResponse,
} from '@nscodecom/loso-pos-sdk';

import type { LosoPosPanelEventMap } from './events.js';
import { panelStyles } from './styles.js';

/**
 * `<loso-pos-panel>` — the whole loyalty flow for one sale, as a single custom element.
 *
 * Runs resolve → quote → redeem → commit → refund, emitting an event at each step so the till
 * can mirror the numbers into its own totals. It renders the loyalty part of a sale; it does not
 * own the basket.
 *
 * ### Credentials
 *
 * The panel defaults to **proxy auth** and never accepts an API key. `base-url` points at your
 * own backend, which holds the merchant's `pos_live_…` key and forwards to Loso. A key in a page
 * is readable in devtools and authenticates as the merchant, so there is deliberately no
 * attribute that would let one get there. For full control over transport, assign a configured
 * {@link LosoPosClient} to the `client` property instead.
 *
 * ```html
 * <loso-pos-panel base-url="https://till.vendor.example/loyalty" subtotal="42.00" currency="BAM">
 * </loso-pos-panel>
 * ```
 */
export class LosoPosPanel extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['base-url', 'subtotal', 'currency', 'pos-transaction-id', 'payment-method', 'timeout-ms'];
  }

  #root: ShadowRoot;
  #client: LosoPosClient | null = null;
  /** Set via the `client` property; takes precedence over `base-url`. */
  #injectedClient: LosoPosClient | null = null;
  #cart: PosCart | null = null;

  // Flow state.
  #customer: PosCustomer | null = null;
  #quote: PosQuoteResponse | null = null;
  #discount = 0;
  #commit: PosCommitResponse | null = null;
  #refund: PosRefundResponse | null = null;
  #error: PosError | null = null;
  #busy = false;

  // Refund state. `#refundAmount` is what the cashier will refund next; `#refundedTotal`
  // is the running sum, so successive partials are capped at what is still refundable —
  // the contract rejects a cumulative over-refund (`refund.exceeds_amount`).
  #refundAmount = 0;
  #refundedTotal = 0;

  // Accessibility bookkeeping. The shadow root holds a persistent skeleton — two
  // live regions and one mount point — built once; only the mount's contents are
  // replaced on render, so the live regions survive to announce and focus can be
  // placed deliberately rather than lost each time.
  #skeletonBuilt = false;
  /** A selector for the control to focus after the next render, or null to leave focus alone. */
  #focusTarget: string | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Supply a pre-configured client — a custom transport, mTLS, request logging, or a test double.
   * Overrides `base-url`.
   */
  get client(): LosoPosClient | null {
    return this.#injectedClient;
  }
  set client(value: LosoPosClient | null) {
    this.#injectedClient = value;
    this.#client = value;
    this.#render();
  }

  /**
   * The basket to price. Set the full cart (with `lines`) here, or use the `subtotal` and
   * `currency` attributes for the common case.
   */
  get cart(): PosCart | null {
    return this.#cart ?? this.#cartFromAttributes();
  }
  set cart(value: PosCart | null) {
    this.#cart = value;
    // The cart changed, so any quote priced against the old one is stale — the contract rejects
    // a commit whose cart drifted (`quote.cart_mismatch`), so drop it rather than send it.
    this.#quote = null;
    this.#discount = 0;
    this.#render();
  }

  /** The discount the cashier accepted, in currency. Sent as `acceptDiscount`. */
  get discount(): number {
    return this.#discount;
  }

  /** The committed sale, once there is one. */
  get committed(): PosCommitResponse | null {
    return this.#commit;
  }

  /** Resolve a scanned code, phone, email, or card number to a customer. */
  async resolve(code: string): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed) return;
    await this.#run(async (client) => {
      const result = await client.resolveCustomer(trimmed);
      if (result.ok) {
        this.#customer = result.data;
        this.#announce(`Customer ${result.data.name} resolved.`);
        this.#focusTarget = '[data-act="quote"]';
        this.#emit('loso-customer-resolved', { customer: result.data });
      }
      return result;
    });
  }

  /** Price the current cart. Read-only — safe to call whenever the basket changes. */
  async quote(): Promise<void> {
    const cart = this.cart;
    if (!cart) return;
    await this.#run(async (client) => {
      const result = await client.quote({
        ...(this.#customer ? { customerRef: this.#customer.customerRef } : {}),
        cart,
        intent: { wantRedeem: true },
      });
      if (result.ok) {
        this.#quote = result.data;
        // Default to taking nothing. The quote is a ceiling, not an instruction, and
        // pre-spending someone's points because a widget defaulted high is not ours to do.
        this.#setDiscount(0, false);

        const redeemable = result.data.redeemable;
        if (redeemable && redeemable.maxDiscount > 0) {
          const currency = cart.currency;
          this.#announce(`Quote ready. Up to ${money(redeemable.maxDiscount)} ${currency} available to redeem.`);
          // Land on the slider, the one thing the cashier acts on next.
          this.#focusTarget = '[data-el="discount"]';
        } else {
          this.#announce('Quote ready. Nothing redeemable on this basket; the sale still earns.');
          this.#focusTarget = '[data-act="commit"]';
        }
        this.#emit('loso-quoted', { quote: result.data });
      }
      return result;
    });
  }

  /** Finalize the sale. Retries reuse one idempotency key, so a timeout cannot double-sell. */
  async commit(): Promise<void> {
    const cart = this.cart;
    if (!cart || this.#commit) return;
    const token = this.#quote?.redemptionToken;
    const discount = this.#discount;

    // The till's own sale id, deliberately not invented here: it is the key the merchant
    // reconciles their receipt against our ledger with, so a generated one would quietly
    // break reconciliation rather than fail.
    const posTransactionId = this.getAttribute('pos-transaction-id')?.trim();
    if (!posTransactionId) {
      this.#fail({
        code: 'request.validation_failed',
        message: 'loso-pos-panel: `pos-transaction-id` is required to commit — set it to the till’s sale id.',
        retryable: false,
      });
      return;
    }

    await this.#run(async (client) => {
      const result = await client.commitWithRetry({
        posTransactionId,
        ...(this.#customer ? { customerRef: this.#customer.customerRef } : {}),
        cart,
        // Omitted entirely for an earn-only sale — sending a zero discount with a token
        // would ask the server to price a redemption that isn't happening.
        ...(token && discount > 0
          ? { redemption: { redemptionToken: token, acceptDiscount: discount } }
          : {}),
        // Defaults to "other" rather than "card": the panel does not know how the customer
        // paid, and guessing would write a wrong figure into the merchant's ledger.
        tender: {
          finalAmount: round2(cart.subtotal - discount),
          paymentMethod: this.getAttribute('payment-method')?.trim() || 'other',
        },
      });
      if (result.ok) {
        this.#commit = result.data;
        // Default the refund slider to the whole amount: "customer returns everything"
        // is the common case, and it can never over-refund.
        this.#refundAmount = result.data.finalAmount;
        this.#refundedTotal = 0;
        this.#announce(
          `Sale committed. Reference ${result.data.loyaltyReference}. Paid ${money(result.data.finalAmount)} ${cart.currency}.`
        );
        this.#focusTarget = '[data-act="new-sale"]';
        this.#emit('loso-committed', { commit: result.data });
      }
      return result;
    });
  }

  /** Reverse the committed sale. Omit `amount` for a full refund. */
  async refund(amount?: number): Promise<void> {
    const reference = this.#commit?.loyaltyReference;
    if (!reference) return;
    await this.#run(async (client) => {
      const result = await client.refundWithRetry(reference, {
        reason: 'customer_return',
        ...(amount === undefined ? {} : { amount }),
      });
      if (result.ok) {
        this.#refund = result.data;
        this.#refundedTotal = round2(this.#refundedTotal + result.data.refundedAmount);
        const remaining = round2((this.#commit?.finalAmount ?? 0) - this.#refundedTotal);
        this.#refundAmount = remaining;
        this.#announce(
          `Refund processed. ${money(result.data.refundedAmount)} ${this.cart?.currency ?? ''} refunded.` +
            (remaining > 0 ? ` ${money(remaining)} still refundable.` : '')
        );
        // If more is refundable, leave the cashier on the refund control to continue;
        // otherwise send them to the next sale.
        this.#focusTarget = remaining > 0 ? '[data-el="refund"]' : '[data-act="new-sale"]';
        this.#emit('loso-refunded', { refund: result.data });
      }
      return result;
    });
  }

  /** Clear all flow state for the next sale. Keeps the client and cart configuration. */
  reset(): void {
    this.#customer = null;
    this.#quote = null;
    this.#discount = 0;
    this.#commit = null;
    this.#refund = null;
    this.#error = null;
    this.#refundAmount = 0;
    this.#refundedTotal = 0;
    // Back to the top of the flow — put the cashier on the scan field.
    this.#focusTarget = '[data-el="code"]';
    this.#render();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  connectedCallback(): void {
    // Give the host a name and a landmark so it is findable when navigating by
    // region, not just an anonymous cluster of buttons. Author-overridable — set
    // your own role/aria-label and these back off.
    if (!this.hasAttribute('role')) this.setAttribute('role', 'group');
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Loyalty');
    this.#render();
  }

  attributeChangedCallback(name: string): void {
    if (name === 'base-url' || name === 'timeout-ms') {
      this.#client = null; // Rebuilt lazily against the new configuration.
    }
    if (name === 'subtotal' || name === 'currency') {
      this.#quote = null; // Same staleness rule as the `cart` setter.
      this.#discount = 0;
    }
    this.#render();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  #getClient(): LosoPosClient | null {
    if (this.#injectedClient) return this.#injectedClient;
    if (this.#client) return this.#client;

    const baseUrl = this.getAttribute('base-url');
    if (!baseUrl) return null;

    const timeout = Number(this.getAttribute('timeout-ms'));
    this.#client = new LosoPosClient({
      baseUrl,
      // No API key, by construction. See the class doc.
      auth: 'proxy',
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    });
    return this.#client;
  }

  #cartFromAttributes(): PosCart | null {
    const subtotal = Number(this.getAttribute('subtotal'));
    const currency = this.getAttribute('currency');
    if (!Number.isFinite(subtotal) || subtotal <= 0 || !currency) return null;
    return { subtotal, currency };
  }

  /** Runs a call with busy state, and funnels every failure into one place. */
  async #run<T>(
    call: (client: LosoPosClient) => Promise<PosEnvelope<T>>
  ): Promise<void> {
    const client = this.#getClient();
    if (!client) {
      this.#fail({
        code: 'request.validation_failed',
        message: 'loso-pos-panel: set `base-url` (or the `client` property) before calling.',
        retryable: false,
      });
      return;
    }

    this.#busy = true;
    this.#error = null;
    this.#render();
    try {
      const result = await call(client);
      if (!result.ok) this.#fail(result.error);
    } finally {
      this.#busy = false;
      this.#render();
    }
  }

  #fail(error: PosError): void {
    this.#error = error;
    // Assertive: a failed sale interrupts whatever the cashier was about to do.
    this.#announce(error.message, true);
    this.#emit('loso-error', { error });
    this.#render();
  }

  #setDiscount(value: number, emit = true): void {
    const max = this.#quote?.redeemable?.maxDiscount ?? 0;
    // Clamped, then rounded to the cent: the contract reconciles `finalAmount` against
    // `subtotal - acceptDiscount` to within a cent, so a float artefact here is a failed commit.
    const next = round2(Math.min(Math.max(value, 0), max));
    if (next === this.#discount) return;
    this.#discount = next;
    if (emit) {
      const subtotal = this.cart?.subtotal ?? 0;
      // Rounded down, never to nearest — see the wire contract on percentage discounts.
      const percent = subtotal > 0 ? Math.floor((next / subtotal) * 10000) / 100 : 0;
      this.#emit('loso-discount-changed', { discount: next, percent });
    }
  }

  #emit<K extends keyof LosoPosPanelEventMap>(
    type: K,
    detail: LosoPosPanelEventMap[K] extends CustomEvent<infer D> ? D : never
  ): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  #render(): void {
    if (!this.isConnected) return;
    this.#buildSkeleton();

    const mount = this.#root.querySelector<HTMLElement>('[data-el="mount"]');
    if (!mount) return;

    mount.innerHTML = this.#template();
    this.setAttribute('aria-busy', this.#busy ? 'true' : 'false');
    this.#bind();

    // While a request is in flight, disable every control so a keyboard user
    // cannot fire a second one — dimming with pointer-events alone would still
    // let Tab+Enter through.
    if (this.#busy) {
      mount
        .querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')
        .forEach((el) => {
          el.disabled = true;
        });
    }

    this.#applyFocus(mount);
  }

  /**
   * The parts of the shadow tree that must outlive a re-render: the two live
   * regions (a wholesale innerHTML swap re-parses `role="alert"` and it stops
   * announcing reliably), plus the mount point whose contents do get replaced.
   */
  #buildSkeleton(): void {
    if (this.#skeletonBuilt) return;
    this.#root.innerHTML =
      `<style>${panelStyles}</style>` +
      `<div class="loso-sr-only" data-el="status" role="status" aria-live="polite"></div>` +
      `<div class="loso-sr-only" data-el="alert" role="alert" aria-live="assertive"></div>` +
      `<div data-el="mount"></div>`;
    this.#skeletonBuilt = true;
  }

  /**
   * Place focus on the control an action leads to next, since the control that
   * triggered it was just replaced. Only when focus is "loose" — on the body
   * because our element vanished, or on the host — so a cashier who moved to
   * another part of the till during an async call is left where they are.
   */
  #applyFocus(mount: HTMLElement): void {
    const target = this.#focusTarget;
    this.#focusTarget = null;
    if (!target || this.#busy) return;

    const active = this.ownerDocument.activeElement;
    const loose = active === null || active === this.ownerDocument.body || active === this;
    if (!loose) return;

    mount.querySelector<HTMLElement>(target)?.focus();
  }

  /** Announce a transition to assistive tech. Polite by default; assertive for errors. */
  #announce(message: string, assertive = false): void {
    const region = this.#root.querySelector<HTMLElement>(
      assertive ? '[data-el="alert"]' : '[data-el="status"]'
    );
    if (region) region.textContent = message;
  }

  #template(): string {
    const cart = this.cart;
    const currency = cart?.currency ?? '';
    const parts: string[] = [];

    if (this.#commit) {
      parts.push(this.#receiptTemplate(currency));
    } else {
      parts.push(this.#customerTemplate());
      parts.push(this.#offerTemplate(cart?.subtotal ?? 0, currency));
      parts.push(this.#tenderTemplate(cart?.subtotal ?? 0, currency));
    }

    if (this.#refund) parts.push(this.#refundTemplate(currency));
    if (this.#error) parts.push(this.#errorTemplate());

    return `<div class="stack${this.#busy ? ' busy' : ''}">${parts.join('')}</div>`;
  }

  #customerTemplate(): string {
    if (this.#customer) {
      const { name, tier } = this.#customer;
      return `
        <div class="card">
          <div class="spread">
            <div>
              <div><strong>${esc(name)}</strong></div>
              ${tier ? `<p class="muted">${esc(tier)}</p>` : ''}
            </div>
            <button type="button" data-act="clear-customer">Clear</button>
          </div>
        </div>`;
    }
    return `
      <div class="card">
        <label class="muted" for="loso-code">Scan a customer, or sell anonymously.</label>
        <div class="row">
          <input type="text" id="loso-code" data-el="code" autocomplete="off" spellcheck="false"
                 placeholder="Scan code, phone or email" aria-label="Scan code, phone or email" />
          <button type="button" data-act="resolve">Resolve</button>
        </div>
      </div>`;
  }

  #offerTemplate(subtotal: number, currency: string): string {
    if (!this.#quote) {
      return `<button type="button" class="primary" data-act="quote" ${subtotal > 0 ? '' : 'disabled'}>
                What can they spend?
              </button>`;
    }

    const redeemable = this.#quote.redeemable;
    if (!redeemable || redeemable.maxDiscount <= 0) {
      return `<p class="muted">Nothing redeemable on this basket — below the minimum, over the cap,
              or redemption is off. The sale still earns.</p>`;
    }

    const step = redeemable.constraints?.step ?? 0.01;
    const percent = subtotal > 0 ? Math.floor((this.#discount / subtotal) * 10000) / 100 : 0;

    return `
      <div class="card">
        <div class="offer__amount">${money(redeemable.maxDiscount)} ${esc(currency)}</div>
        <p class="muted">A ceiling, not an instruction — take any amount up to it.</p>
        <label class="muted" for="loso-discount">Loyalty discount</label>
        <!-- Visual readout only: aria-hidden so the value is not read twice, once
             here and once from the slider's aria-valuetext. -->
        <div class="offer__readout" data-el="discount-readout" aria-hidden="true">
          <strong>${money(this.#discount)} ${esc(currency)}</strong> (${percent}%)
        </div>
        <input type="range" id="loso-discount" data-el="discount"
               min="0" max="${redeemable.maxDiscount}" step="${step}" value="${this.#discount}"
               aria-valuetext="${money(this.#discount)} ${esc(currency)}, ${percent} percent" />
      </div>`;
  }

  #tenderTemplate(subtotal: number, currency: string): string {
    const total = round2(subtotal - this.#discount);
    const earn = this.#quote?.earn?.estimatedPoints;
    return `
      <button type="button" class="primary" data-act="commit" ${subtotal > 0 ? '' : 'disabled'}>
        Take ${money(total)} ${esc(currency)}
      </button>
      ${earn === undefined ? '' : `<p class="muted">Will earn ≈ ${earn} pts. Commit is authoritative.</p>`}`;
  }

  #receiptTemplate(currency: string): string {
    const c = this.#commit as PosCommitResponse;
    const remaining = round2(c.finalAmount - this.#refundedTotal);
    const amount = round2(Math.min(Math.max(this.#refundAmount, 0), remaining));

    const receipt = `
      <div class="card receipt">
        <div class="spread"><span>Reference</span><strong>${esc(c.loyaltyReference)}</strong></div>
        <div class="spread"><span>Discount applied</span><strong>${money(c.discountApplied)}</strong></div>
        <div class="spread"><span>Points redeemed</span><strong>${c.pointsRedeemed}</strong></div>
        <div class="spread"><span>Points earned</span><strong>${c.pointsEarned}</strong></div>
        <div class="spread"><span>New balance</span><strong>${c.newPointsBalance}</strong></div>
        <div class="spread total"><span>Paid</span><strong>${money(c.finalAmount)} ${esc(currency)}</strong></div>
      </div>`;

    // Once nothing is refundable, the only action left is the next sale.
    if (remaining <= 0) {
      return `${receipt}
        <div class="row"><button type="button" data-act="new-sale">New sale</button></div>`;
    }

    // Slider from 0 to what is still refundable — drag to the top for a full refund,
    // down for a partial. Same idiom as the discount slider, including the voiced value.
    return `${receipt}
      <div class="card">
        <label class="muted" for="loso-refund">Refund amount</label>
        <div class="offer__readout" data-el="refund-readout" aria-hidden="true">
          <strong>${money(amount)} ${esc(currency)}</strong> of ${money(remaining)}
        </div>
        <input type="range" id="loso-refund" data-el="refund"
               min="0" max="${remaining}" step="0.01" value="${amount}"
               aria-valuetext="${money(amount)} ${esc(currency)}" />
        <div class="row">
          <button type="button" class="primary" data-act="refund">Refund <span data-el="refund-label">${money(amount)} ${esc(currency)}</span></button>
          <button type="button" data-act="new-sale">New sale</button>
        </div>
      </div>`;
  }

  #refundTemplate(currency: string): string {
    const r = this.#refund as PosRefundResponse;
    return `
      <div class="card receipt">
        <div class="spread"><span>${esc(r.type)} refund</span><strong>${esc(r.refundReference)}</strong></div>
        <div class="spread"><span>Refunded</span><strong>${money(r.refundedAmount)} ${esc(currency)}</strong></div>
        <div class="spread"><span>Points restored</span><strong>+${r.pointsRestored}</strong></div>
        <div class="spread"><span>New balance</span><strong>${r.newPointsBalance}</strong></div>
      </div>`;
  }

  #errorTemplate(): string {
    const e = this.#error as PosError;
    // No role="alert" here — the persistent assertive live region announces the
    // failure, so a role on this rebuilt card would double it. This is the
    // visible half; the spoken half lives in #fail.
    return `
      <div class="card error">
        <span class="error__code">${esc(e.code)}</span>
        <p class="muted">${esc(e.message)}</p>
        ${e.retryable ? '<p class="muted">Retryable — re-quote and try again.</p>' : ''}
      </div>`;
  }

  #bind(): void {
    const root = this.#root;
    const on = (act: string, handler: () => void) => {
      root.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)?.addEventListener('click', handler);
    };

    const code = root.querySelector<HTMLInputElement>('[data-el="code"]');
    on('resolve', () => void this.resolve(code?.value ?? ''));
    // A scanner wedge types the code and presses Enter — without this the panel looks broken
    // to the one input device a till actually uses.
    code?.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        event.preventDefault();
        void this.resolve(code.value);
      }
    });

    on('clear-customer', () => {
      this.#customer = null;
      this.#quote = null;
      this.#discount = 0;
      this.#focusTarget = '[data-el="code"]';
      this.#render();
    });
    on('quote', () => void this.quote());
    on('commit', () => void this.commit());
    on('new-sale', () => this.reset());

    on('refund', () => {
      const paid = this.#commit?.finalAmount ?? 0;
      // A first, full-amount refund omits `amount` so the API treats it as a true full
      // refund — which also reverses stamp cards, challenges and referral bonuses.
      // A partial (or a top-up on an already-partly-refunded sale) passes the amount and
      // reverses loyalty pro rata only.
      const isFull = this.#refundedTotal === 0 && this.#refundAmount >= paid;
      void this.refund(isFull ? undefined : this.#refundAmount);
    });

    const refundSlider = root.querySelector<HTMLInputElement>('[data-el="refund"]');
    refundSlider?.addEventListener('input', (event) => {
      const remaining = round2((this.#commit?.finalAmount ?? 0) - this.#refundedTotal);
      const value = round2(Math.min(Math.max(Number((event.target as HTMLInputElement).value), 0), remaining));
      this.#refundAmount = value;
      const currency = this.cart?.currency ?? '';
      // Update in place — a re-render mid-drag would tear the thumb from the pointer.
      const readout = root.querySelector('[data-el="refund-readout"]');
      if (readout) readout.innerHTML = `<strong>${money(value)} ${esc(currency)}</strong> of ${money(remaining)}`;
      const label = root.querySelector('[data-el="refund-label"]');
      if (label) label.textContent = `${money(value)} ${currency}`;
      refundSlider.setAttribute('aria-valuetext', `${money(value)} ${currency}`);
    });

    const slider = root.querySelector<HTMLInputElement>('[data-el="discount"]');
    slider?.addEventListener('input', (event) => {
      this.#setDiscount(Number((event.target as HTMLInputElement).value));
      // Re-render would tear the range thumb out from under the pointer mid-drag, so
      // update the readout and the slider's spoken value in place instead.
      const currency = this.cart?.currency ?? '';
      const subtotal = this.cart?.subtotal ?? 0;
      const percent = subtotal > 0 ? Math.floor((this.#discount / subtotal) * 10000) / 100 : 0;
      const readout = root.querySelector('[data-el="discount-readout"]');
      if (readout) readout.innerHTML = `<strong>${money(this.#discount)} ${esc(currency)}</strong> (${percent}%)`;
      slider.setAttribute('aria-valuetext', `${money(this.#discount)} ${currency}, ${percent} percent`);
    });
  }
}

/** Currency, fixed to the cent — the unit the contract settles in. */
function money(value: number): string {
  return value.toFixed(2);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Escapes interpolated text. Customer names, error messages and references all cross from the
 * API into `innerHTML`, so this is the boundary that stops a crafted name becoming markup.
 */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
