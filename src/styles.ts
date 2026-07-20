/**
 * Panel styles, scoped by the shadow root.
 *
 * Theming is via custom properties only — they pierce the shadow boundary, so a vendor restyles
 * the panel from their own stylesheet without us exposing internals they would then depend on.
 * Colours inherit from the host page where possible so the panel sits inside an existing till
 * theme rather than fighting it.
 */
export const panelStyles = /* css */ `
  :host {
    /* Public theming surface. Override these from the host page. */
    --loso-font: system-ui, -apple-system, "Segoe UI", sans-serif;
    --loso-radius: 10px;
    --loso-gap: 12px;
    --loso-fg: currentColor;
    --loso-muted: color-mix(in srgb, currentColor 60%, transparent);
    --loso-border: color-mix(in srgb, currentColor 18%, transparent);
    --loso-surface: transparent;
    --loso-accent: #2f6f4f;
    --loso-accent-fg: #ffffff;
    --loso-danger: #b3261e;

    display: block;
    font-family: var(--loso-font);
    color: var(--loso-fg);
    background: var(--loso-surface);
    container-type: inline-size;
  }

  :host([hidden]) { display: none; }

  .stack { display: flex; flex-direction: column; gap: var(--loso-gap); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .muted { color: var(--loso-muted); font-size: 0.875rem; margin: 0; }
  .spread { display: flex; justify-content: space-between; gap: 8px; }

  button {
    font: inherit;
    color: inherit;
    padding: 8px 12px;
    border: 1px solid var(--loso-border);
    border-radius: var(--loso-radius);
    background: transparent;
    cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--loso-accent); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  /* Never remove the ring — a till is often driven by keyboard or a scanner wedge. */
  button:focus-visible, input:focus-visible { outline: 2px solid var(--loso-accent); outline-offset: 2px; }

  button.primary {
    background: var(--loso-accent);
    color: var(--loso-accent-fg);
    border-color: var(--loso-accent);
    font-weight: 600;
  }

  input[type="text"] {
    font: inherit;
    color: inherit;
    padding: 8px 10px;
    border: 1px solid var(--loso-border);
    border-radius: var(--loso-radius);
    background: transparent;
    flex: 1 1 12ch;
    min-width: 0;
  }

  input[type="range"] { width: 100%; accent-color: var(--loso-accent); }

  .card {
    border: 1px solid var(--loso-border);
    border-radius: var(--loso-radius);
    padding: var(--loso-gap);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .offer__amount { font-size: 1.5rem; font-weight: 650; }
  .receipt { font-variant-numeric: tabular-nums; }
  .receipt .spread + .spread { margin-top: 4px; }
  .total { font-weight: 650; border-top: 1px solid var(--loso-border); padding-top: 6px; margin-top: 6px; }

  .error { border-color: var(--loso-danger); }
  .error__code { font-family: ui-monospace, monospace; font-size: 0.8125rem; color: var(--loso-danger); }

  .busy { opacity: 0.6; pointer-events: none; }

  @media (prefers-reduced-motion: no-preference) {
    button { transition: border-color 120ms ease; }
  }
`;
