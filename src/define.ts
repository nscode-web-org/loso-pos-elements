// Side-effect entry point: importing this registers the elements.
//
//   import '@nscodecom/loso-pos-elements/define';
//
// Kept separate from `index` so the main entry stays side-effect-free and tree-shakeable — a
// bundler must be free to drop the registration for a consumer who only wants the types.
import { defineLosoPosElements } from './registry.js';

defineLosoPosElements();

export { defineLosoPosElements, LOSO_POS_PANEL_TAG } from './registry.js';
