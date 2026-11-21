/**
 * Where the app pages live. The Overview is the base itself, the other pages sit below it. The
 * value is empty today: `/` is the Overview and `/mirroring` is the list of mirrorings. A change
 * here moves every page link, form action and redirect of the server, and `html[data-app-base]`
 * tells the scripts. Asset URLs (`/next/<file>.<hash>.<ext>`) do not use it: see `asset()`.
 */
export const APP_BASE = "";

/** The pages of the app below the base. The Overview is the base and is not in this list. */
export const APP_PAGES = ["mirroring", "calendars", "activity", "admin", "tokens"] as const;

/** The address of an app page: "/" for the Overview, "/mirroring" for a list. Queries go after it. */
export function appPath(path: string): string {
  return path === "/" ? APP_BASE || "/" : `${APP_BASE}${path}`;
}

/** True if the path is the Overview or the address of a page in `APP_PAGES`. */
export function isAppPagePath(pathname: string): boolean {
  if (pathname === APP_BASE || pathname === `${APP_BASE}/`) return true;
  if (!pathname.startsWith(`${APP_BASE}/`)) return false;
  return (APP_PAGES as readonly string[]).includes(pathname.slice(APP_BASE.length + 1));
}
