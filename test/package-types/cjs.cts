// CommonJS consumer of the packed tarball, under moduleResolution node16.
//
// This is the case that regressed silently in the SDK: package.json sets
// "type": "module", so a .d.ts is an ESM declaration, and a require-condition
// pointing at one fails with TS1479. Only a .d.cts satisfies it. With two
// entries here (`.` and `./define`), both need their own .d.cts.
import { LosoPosPanel, defineLosoPosElements, LOSO_POS_PANEL_TAG } from '@nscodecom/loso-pos-elements';
import type { LosoPosPanelEventMap, LosoPosPanelEventName } from '@nscodecom/loso-pos-elements';
import { defineLosoPosElements as defineViaSubpath } from '@nscodecom/loso-pos-elements/define';

const tag: string = LOSO_POS_PANEL_TAG;
defineLosoPosElements();
defineViaSubpath();

const panel = new LosoPosPanel();
const name: LosoPosPanelEventName = 'loso-committed';
type CommitDetail = LosoPosPanelEventMap['loso-committed'];

// Must ERROR — see esm.mts.

// @ts-expect-error LOSO_POS_PANEL_TAG is a string, not a number
const wrongType: number = LOSO_POS_PANEL_TAG;

// @ts-expect-error 'loso-nope' is not one of the panel's event names
const wrongEvent: LosoPosPanelEventName = 'loso-nope';

void tag;
void panel;
void name;
void ({} as CommitDetail);
void wrongType;
void wrongEvent;
