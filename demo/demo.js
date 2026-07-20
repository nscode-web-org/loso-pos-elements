// Wires the demo page: registers the element, injects a client backed by the fake proxy,
// and logs every event the panel emits.
import { LosoPosClient } from '@nscodecom/loso-pos-sdk';
import { defineLosoPosElements } from '@nscodecom/loso-pos-elements';

import { createFakeProxy } from './fake-proxy.js';

defineLosoPosElements();

const proxy = createFakeProxy();
const panel = document.getElementById('panel');

// The whole point of the package: no key on the page. The client is proxy-auth and sends
// no Authorization header; `fetch` is the in-memory fake standing in for the vendor backend.
panel.client = new LosoPosClient({
  baseUrl: 'https://demo.local',
  auth: 'proxy',
  fetch: proxy.fetch,
});

// ── Event log ────────────────────────────────────────────────────────────────
const log = document.getElementById('log');
const summarize = {
  'loso-customer-resolved': (d) => d.customer.name,
  'loso-quoted': (d) => (d.quote.redeemable ? `up to ${d.quote.redeemable.maxDiscount.toFixed(2)} BAM` : 'nothing redeemable'),
  'loso-discount-changed': (d) => `${d.discount.toFixed(2)} BAM (${d.percent}%)`,
  'loso-committed': (d) => `${d.commit.loyaltyReference} · paid ${d.commit.finalAmount.toFixed(2)}`,
  'loso-refunded': (d) => `${d.refund.type} · ${d.refund.refundedAmount.toFixed(2)} back`,
  'loso-error': (d) => `${d.error.code} — ${d.error.message}`,
};

for (const name of Object.keys(summarize)) {
  panel.addEventListener(name, (event) => {
    const row = document.createElement('div');
    row.className = 'evt';
    const time = new Date().toLocaleTimeString();
    row.innerHTML = `<span class="name"></span> <span class="detail"></span> <span style="opacity:.5">${time}</span>`;
    row.querySelector('.name').textContent = name;
    // textContent, not innerHTML — event details carry API strings.
    row.querySelector('.detail').textContent = summarize[name](event.detail);
    log.prepend(row);

    // Give each committed sale a fresh transaction id for the next one.
    if (name === 'loso-committed') panel.setAttribute('pos-transaction-id', `POS-DEMO-${Date.now()}`);
  });
}

// ── Controls ─────────────────────────────────────────────────────────────────
document.getElementById('subtotal').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  if (Number.isFinite(value) && value > 0) panel.setAttribute('subtotal', value.toFixed(2));
});

for (const button of document.querySelectorAll('[data-scan]')) {
  button.addEventListener('click', () => panel.resolve(button.dataset.scan));
}

document.getElementById('down').addEventListener('change', (e) => proxy.setDown(e.target.checked));

document.getElementById('reset').addEventListener('click', () => {
  proxy.reset();
  panel.reset();
  panel.setAttribute('pos-transaction-id', `POS-DEMO-${Date.now()}`);
  log.replaceChildren();
});
