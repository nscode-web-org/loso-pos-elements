import { LosoPosPanel } from './panel.js';

export const LOSO_POS_PANEL_TAG = 'loso-pos-panel';

/**
 * Registers the elements on the global registry.
 *
 * Idempotent, and safe in a non-DOM context: a till that server-renders would otherwise crash on
 * import, and two bundles that each pull the package in must not fight over the tag name.
 *
 * Call this yourself, or import `@nscodecom/loso-pos-elements/define`, which calls it for you.
 */
export function defineLosoPosElements(): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(LOSO_POS_PANEL_TAG)) {
    customElements.define(LOSO_POS_PANEL_TAG, LosoPosPanel);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'loso-pos-panel': LosoPosPanel;
  }
}
