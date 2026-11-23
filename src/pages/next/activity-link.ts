import { appPath } from "../../app-base";
import type { ActivityGroup } from "../../audit";

/** The filters of the activity page, as they appear in its URL. */
export interface ActivityQuery {
  /** `<from>~<to>`, the value format of `/mirroring?d=`. */
  d?: string;
  /** The ID of a calendar, either side of a mirroring. */
  c?: string;
  kind?: ActivityGroup;
  /** "org" for the view of the whole organisation (admins only). */
  scope?: "org";
  /** Cursor: the ID of the newest row that the page leaves out. */
  before?: number;
}

/** The address of the activity page with the given filters. */
export function activityHref(query: ActivityQuery = {}): string {
  // `encodeURIComponent` keeps "~", as the mirroring page's `?d=` does.
  const pairs: [string, string | number | undefined][] = [
    ["scope", query.scope],
    ["d", query.d],
    ["c", query.c],
    ["kind", query.kind],
    ["before", query.before],
  ];
  const text = pairs
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
  return text ? `${appPath("/activity")}?${text}` : appPath("/activity");
}

/** The activity page filtered to one mirroring. */
export function mirroringActivityHref(from: string, to: string): string {
  return activityHref({ d: `${from}~${to}` });
}
