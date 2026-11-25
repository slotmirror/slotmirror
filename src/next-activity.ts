import { parseActivityGroup, type ActivityFilter } from "./audit";
import type { EditorState } from "./editor";
import type { ActivityQuery } from "./pages/next/activity-link";

/** The query parameters of the activity page, as the router hands them over. */
export interface ActivityParams {
  d?: string;
  c?: string;
  kind?: string;
  scope?: string;
  before?: string;
}

/**
 * The filters in the URL, kept only if the state knows them: a mirroring that the user has, a
 * calendar of the user, a known type, a numeric cursor. Anything else is dropped, so a stale link
 * shows all events instead of none. `org` is true only for the org view that the caller allowed.
 */
export function parseActivityQuery(
  state: EditorState,
  params: ActivityParams,
  org: boolean,
): ActivityQuery {
  const query: ActivityQuery = {};
  if (org) query.scope = "org";
  const kind = parseActivityGroup(params.kind);
  if (kind) query.kind = kind;
  if (/^\d{1,15}$/.test(params.before ?? "")) query.before = Number(params.before);
  // In the org view, too, a mirroring or a calendar must be the user's own: its rows are the
  // user's own rows, which that view names (see `orgActivityPage`).
  const [from, to, ...rest] = (params.d ?? "").split("~");
  if (
    from &&
    to &&
    rest.length === 0 &&
    state.directions.some((direction) => direction.from === from && direction.to === to)
  ) {
    query.d = `${from}~${to}`;
  }
  const account = state.accounts.find((entry) => entry.id === params.c);
  if (account) query.c = account.id;
  return query;
}

/**
 * The query for the audit log. A mirroring is its rules (a direction with several source calendars
 * has several). A calendar is the rules into or out of it, plus the events of its own account, such
 * as a reconnect. A mirroring and a calendar together are the rules that match both.
 */
export function activityFilter(state: EditorState, query: ActivityQuery): ActivityFilter {
  const filter: ActivityFilter = { group: query.kind, before: query.before };
  const [from, to] = (query.d ?? "").split("~");
  if (query.d) {
    filter.ruleIds = state.rules
      .filter(
        (entry) =>
          entry.from === from &&
          entry.to === to &&
          (!query.c || entry.from === query.c || entry.to === query.c),
      )
      .map((entry) => entry.rule.id);
    // A save that turned the mirroring off deleted its rules; its rows name the two calendars.
    if (!query.c || query.c === from || query.c === to) filter.turnedOff = { from, to };
  } else if (query.c) {
    filter.ruleIds = state.rules
      .filter((entry) => entry.from === query.c || entry.to === query.c)
      .map((entry) => entry.rule.id);
    filter.accountId = query.c;
    // The rows of the calendar's own account include those that turned a mirroring into it off.
    filter.turnedOff = { from: query.c };
  }
  return filter;
}
