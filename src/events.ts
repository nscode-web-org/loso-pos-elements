import type {
  PosCommitResponse,
  PosCustomer,
  PosError,
  PosQuoteResponse,
  PosRefundResponse,
} from '@nscodecom/loso-pos-sdk';

/**
 * Every event the panel emits, keyed by its `type`. All bubble and are composed, so a host can
 * listen on an ancestor rather than the element itself.
 *
 * The panel never throws and never blocks a sale: a failure arrives as `loso-error`, and the
 * till is free to ignore it and tender at full price.
 */
export interface LosoPosPanelEventMap {
  /** A scan resolved to a customer. */
  'loso-customer-resolved': CustomEvent<{ customer: PosCustomer }>;
  /** A quote came back. `redeemable` may be absent — nothing to spend on this cart. */
  'loso-quoted': CustomEvent<{ quote: PosQuoteResponse }>;
  /**
   * The cashier moved the discount. `discount` is the currency amount, which is what gets sent
   * as `acceptDiscount` and what the points are priced from; `percent` is the same figure as a
   * share of the subtotal, for tills whose discount engine takes a percentage.
   */
  'loso-discount-changed': CustomEvent<{ discount: number; percent: number }>;
  /** The sale is committed. `loyaltyReference` belongs on the receipt. */
  'loso-committed': CustomEvent<{ commit: PosCommitResponse }>;
  /** A refund landed. */
  'loso-refunded': CustomEvent<{ refund: PosRefundResponse }>;
  /**
   * Any failure — business (`redeem.insufficient_points`) or transport (`loyalty.unreachable`).
   * `retryable` mirrors the wire contract: re-quote and try again, or sell at full price.
   */
  'loso-error': CustomEvent<{ error: PosError }>;
}

export type LosoPosPanelEventName = keyof LosoPosPanelEventMap;
