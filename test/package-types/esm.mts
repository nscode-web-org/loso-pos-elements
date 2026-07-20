// ESM consumer of the packed tarball, under moduleResolution node16.
import { LosoPosPanel, defineLosoPosElements, LOSO_POS_PANEL_TAG } from '@nscodecom/loso-pos-elements';
import type { LosoPosPanelEventMap, LosoPosPanelEventName } from '@nscodecom/loso-pos-elements';

// The `./define` subpath must resolve on its own — it is a second entry in the
// exports map, and the whole point of this check is that both entries ship
// working declarations, not just the main one.
import { defineLosoPosElements as defineViaSubpath } from '@nscodecom/loso-pos-elements/define';
import '@nscodecom/loso-pos-elements/define';

const tag: string = LOSO_POS_PANEL_TAG;
defineLosoPosElements();
defineViaSubpath();

// The panel is a real HTMLElement subclass, with typed events.
const panel = new LosoPosPanel();
const name: LosoPosPanelEventName = 'loso-committed';
type CommitDetail = LosoPosPanelEventMap['loso-committed'];

// These guard against the types silently widening to `any`, which resolves
// just as happily as the real thing. They must ERROR.

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
