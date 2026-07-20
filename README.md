# @nscodecom/loso-pos-elements

Drop-in web components for the [Loso POS loyalty API](https://github.com/nscode-web-org/loso-pos-sdk).
One custom element runs the whole loyalty side of a sale — resolve → quote → redeem → commit →
refund — and emits an event at each step so your till can mirror the numbers into its own totals.

Built on [`@nscodecom/loso-pos-sdk`](https://www.npmjs.com/package/@nscodecom/loso-pos-sdk). Framework-agnostic:
these are native custom elements, so they work in React, Vue, Angular, or a plain page.

```bash
npm install @nscodecom/loso-pos-elements
```

## Try it

A live panel wired to an in-memory fake proxy — no backend, no key. Clone the repo and:

```bash
npm install
npm run demo      # builds, then serves http://localhost:5173/demo/
```

Scan a customer, quote, redeem with the slider, commit, and refund (whole or partial). Every event
the panel emits is logged beside it, and a "Proxy down" toggle shows the fail-open posture — the
till sells at full price when loyalty is unreachable. The fake proxy lives in
[`demo/fake-proxy.js`](demo/fake-proxy.js).

## Your API key does not go in the browser

This is the one thing to get right, so the package is built to make the wrong thing impossible:
**there is no attribute or property that accepts an API key.**

A `pos_live_…` key authenticates as the merchant. In a page it is readable in devtools by anyone
standing at the till, and it cannot be scoped down or rotated quickly. So the panel talks to
**your** backend, which holds the key and forwards to Loso:

```
browser: <loso-pos-panel base-url="https://till.vendor.example/loyalty">
              │
              ▼  no credentials on this hop
   your backend  ──── Authorization: Bearer pos_live_… ────►  Loso
```

Your proxy needs to forward six paths under `/api/pos/v1`, attaching the key: `config`,
`customer/resolve`, `quote`, `commit`, `commit/{ref}`, `commit/{ref}/refund`. Pass the
`Idempotency-Key` header through unchanged — it is what stops a retry ringing up a second sale.

## Use it

```html
<script type="module">
  import '@nscodecom/loso-pos-elements/define';
</script>

<loso-pos-panel
  base-url="https://till.vendor.example/loyalty"
  pos-transaction-id="POS-2026-000481"
  subtotal="42.00"
  currency="BAM"
  payment-method="card">
</loso-pos-panel>
```

Or register manually, so a bundler can tree-shake it:

```ts
import { defineLosoPosElements } from '@nscodecom/loso-pos-elements';
defineLosoPosElements();
```

### Attributes

| Attribute | Required | Notes |
|---|---|---|
| `base-url` | yes¹ | Your proxy. The `/api/pos/v1` prefix is added for you. |
| `pos-transaction-id` | to commit | Your till's sale id. Never generated for you — it is what the merchant reconciles against. |
| `subtotal` | yes | Pre-discount basket total, `> 0`. |
| `currency` | yes | Must match the merchant's configured currency. |
| `payment-method` | no | Defaults to `other`. Set it — the panel can't know how they paid. |
| `timeout-ms` | no | Per-request timeout. Default 10000; keep it short on commit. |

¹ Unless you assign the `client` property instead.

### Properties and methods

```ts
const panel = document.querySelector('loso-pos-panel')!;

panel.cart = { subtotal: 42, currency: 'BAM', lines: [...] };  // full cart with line detail
panel.discount;    // the accepted discount, in currency
panel.committed;   // the commit result, once there is one

await panel.resolve('+38765423554');
await panel.quote();
await panel.commit();
await panel.refund(14.75);   // omit the amount for a full refund
panel.reset();               // next sale
```

For full control over transport — mTLS, request logging, a custom auth scheme — build the client
yourself and hand it over:

```ts
import { LosoPosClient } from '@nscodecom/loso-pos-sdk';

panel.client = new LosoPosClient({
  baseUrl: 'https://till.vendor.example/loyalty',
  auth: 'proxy',
  fetch: myInstrumentedFetch,
});
```

### Events

All bubble and are composed, so you can listen on an ancestor.

| Event | `detail` |
|---|---|
| `loso-customer-resolved` | `{ customer }` |
| `loso-quoted` | `{ quote }` |
| `loso-discount-changed` | `{ discount, percent }` |
| `loso-committed` | `{ commit }` |
| `loso-refunded` | `{ refund }` |
| `loso-error` | `{ error }` |

```ts
panel.addEventListener('loso-discount-changed', (e) => {
  till.applyDiscountLine(e.detail.discount);   // the currency amount is authoritative
});

panel.addEventListener('loso-committed', (e) => {
  receipt.print(e.detail.commit.loyaltyReference);
});
```

**Never block a sale on loyalty.** Business failures and transport failures both arrive as
`loso-error` and neither throws. If loyalty is unreachable you get `loyalty.unreachable` — sell at
full price and move on.

## Theming

Styles are in a shadow root; override the custom properties from your own stylesheet:

```css
loso-pos-panel {
  --loso-accent: #0b5cff;
  --loso-radius: 4px;
  --loso-font: "Inter", sans-serif;
}
```

Available: `--loso-font`, `--loso-radius`, `--loso-gap`, `--loso-fg`, `--loso-muted`,
`--loso-border`, `--loso-surface`, `--loso-accent`, `--loso-accent-fg`, `--loso-danger`.

## License

MIT
