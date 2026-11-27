export {
  formatAsOf,
  asOfLine,
  escapeHtml,
  ringGeometry,
  scorePercent,
  shortenKey,
  statLines,
  STAT_KEYS,
  type StatKey,
  type StatLine,
} from './presentation';
export {
  CircleStatsPage,
  CIRCLE_STATS_PAGE_TAG,
  defineCircleStatsPage,
  type InviteCandidate,
} from './circle-stats-page';
export {
  CircleStatsList,
  CIRCLE_STATS_LIST_TAG,
  defineCircleStatsList,
} from './circle-stats-list';
export {
  CircleInviteCard,
  CIRCLE_INVITE_CARD_TAG,
  defineCircleInviteCard,
} from './circle-invite-card';
export {
  CircleCreateForm,
  CIRCLE_CREATE_FORM_TAG,
  defineCircleCreateForm,
} from './circle-create-form';
export {
  CircleDashboard,
  CIRCLE_DASHBOARD_TAG,
  defineCircleDashboard,
} from './circle-dashboard';
export {
  CircleBar,
  CIRCLE_BAR_TAG,
  defineCircleBar,
  type CircleBarItem,
} from './circle-bar';

import { defineCircleStatsPage } from './circle-stats-page';
import { defineCircleStatsList } from './circle-stats-list';
import { defineCircleInviteCard } from './circle-invite-card';
import { defineCircleCreateForm } from './circle-create-form';
import { defineCircleDashboard } from './circle-dashboard';
import { defineCircleBar } from './circle-bar';

export function defineCircleStatsElements(): void {
  defineCircleStatsPage();
  defineCircleStatsList();
  defineCircleInviteCard();
  defineCircleCreateForm();
  defineCircleDashboard();
  defineCircleBar();
}
